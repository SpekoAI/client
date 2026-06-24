import {
  createLocalAudioTrack,
  DisconnectReason,
  type LocalAudioTrack,
  type Participant,
  type RemoteAudioTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type TranscriptionSegment,
} from 'livekit-client';
import {
  decodePacket,
  encodePacket,
  type InboundPacket,
  type OutboundPacket,
  packetToMessage,
} from './data-channel.js';
import { SpekoClientError } from './errors.js';
import type {
  AudioConstraints,
  ConversationCallbacks,
  ConversationMode,
  ConversationOverrides,
  ConversationStatus,
  DisconnectionDetails,
  DisconnectionReason,
  MessageSource,
} from './types.js';

// LiveKit Agents' RoomIO listens for typed user input on this topic (textEnabled
// defaults to true), treating each message as a user turn.
const CHAT_TOPIC = 'lk.chat';

// Instant barge-in duck: the moment the caller speaks over the agent, silence the
// agent's <audio> so its already-buffered audio can't keep draining (the
// jitter-buffer tail) while the worker decides to yield. Restore when the agent's
// next reply begins, or after a short fallback if the caller only backchanneled
// and the agent never actually yielded.
const BARGE_IN_MIC_RMS = 0.03; // local-mic RMS (0..1) above which the caller is talking
const BARGE_IN_POLL_MS = 40; // onset poll cadence (ms)
const BARGE_IN_FALLBACK_MS = 1200; // restore if the agent never yields (false barge-in)

export interface WebRTCConnectionInit {
  readonly conversationToken: string;
  readonly livekitUrl: string;
  readonly overrides?: ConversationOverrides;
  readonly inputDeviceId?: string;
  readonly outputDeviceId?: string;
  readonly audioConstraints?: AudioConstraints;
  readonly callbacks: ConversationCallbacks;
}

export class WebRTCConnection {
  private readonly room: Room;
  private readonly callbacks: ConversationCallbacks;
  private readonly outputDeviceId?: string;
  private readonly audioElements = new Set<HTMLAudioElement>();
  private status: ConversationStatus = 'connecting';
  private mode: ConversationMode = 'listening';
  private localTrack?: LocalAudioTrack;
  private volume = 1;
  // Instant barge-in duck state (see startBargeInDuck).
  private agentDucked = false;
  private agentWentSilentSinceDuck = false;
  private bargeInCtx?: AudioContext;
  private bargeInTimer?: ReturnType<typeof setInterval>;
  private bargeInFallback?: ReturnType<typeof setTimeout>;

  constructor(private readonly init: WebRTCConnectionInit) {
    this.callbacks = init.callbacks;
    this.outputDeviceId = init.outputDeviceId;
    this.room = new Room();
    this.bindRoomEvents();
  }

  get roomInstance(): Room {
    return this.room;
  }

  getStatus(): ConversationStatus {
    return this.status;
  }

  getMode(): ConversationMode {
    return this.mode;
  }

  async connect(): Promise<string> {
    try {
      await this.room.connect(this.init.livekitUrl, this.init.conversationToken, {
        autoSubscribe: true,
      });
    } catch (err) {
      this.setStatus('disconnected');
      throw new SpekoClientError('Failed to connect to media transport', 'CONNECTION_FAILED', err);
    }

    try {
      // Always route through createLocalAudioTrack so audioConstraints are
      // applied — setMicrophoneEnabled(true) would silently ignore them
      // when no explicit inputDeviceId is passed.
      this.localTrack = await createLocalAudioTrack({
        ...(this.init.inputDeviceId && { deviceId: this.init.inputDeviceId }),
        echoCancellation: this.init.audioConstraints?.echoCancellation ?? true,
        noiseSuppression: this.init.audioConstraints?.noiseSuppression ?? true,
        autoGainControl: this.init.audioConstraints?.autoGainControl ?? true,
      });
      await this.room.localParticipant.publishTrack(this.localTrack, {
        source: Track.Source.Microphone,
        name: 'microphone',
      });
    } catch (err) {
      // Mic failure after the room is connected — tear down the room so
      // we don't leave it open consuming media transport resources until
      // the token expires.
      this.localTrack?.stop();
      this.localTrack = undefined;
      await this.room.disconnect().catch(() => undefined);
      this.setStatus('disconnected');
      throw new SpekoClientError('Failed to acquire microphone', 'MICROPHONE_FAILED', err);
    }

    this.setStatus('connected');
    const conversationId = this.room.name || '';

    if (this.init.overrides) {
      this.publish({ type: 'overrides', overrides: this.init.overrides });
    }

    this.startBargeInDuck();
    this.callbacks.onConnect?.({ conversationId });
    return conversationId;
  }

  async disconnect(): Promise<void> {
    if (this.status === 'disconnected' || this.status === 'disconnecting') {
      return;
    }
    this.setStatus('disconnecting');
    await this.room.disconnect();
    // Disconnected event handler will fire onDisconnect + setStatus.
  }

  publish(packet: OutboundPacket): void {
    if (this.status !== 'connected') {
      throw new SpekoClientError(
        'Cannot send data before connection is established',
        'NOT_CONNECTED',
      );
    }
    const bytes = encodePacket(packet);
    void this.room.localParticipant.publishData(bytes, { reliable: true });
  }

  // Send a typed user message over LiveKit's native text input (the `lk.chat`
  // topic the agent's RoomIO listens on). The agent treats it as a user turn
  // and replies with audio + transcription, exactly like a spoken turn.
  async sendChatText(text: string): Promise<void> {
    if (this.status !== 'connected') {
      throw new SpekoClientError(
        'Cannot send text before connection is established',
        'NOT_CONNECTED',
      );
    }
    await this.room.localParticipant.sendText(text, { topic: CHAT_TOPIC });
  }

  async setMicMuted(muted: boolean): Promise<void> {
    if (this.localTrack) {
      if (muted) await this.localTrack.mute();
      else await this.localTrack.unmute();
      return;
    }
    await this.room.localParticipant.setMicrophoneEnabled(!muted);
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyAgentVolume();
  }

  // Single point that sets agent <audio> volume, honoring the barge-in duck:
  // while ducked the agent is silenced; otherwise it plays at the set volume.
  private applyAgentVolume(): void {
    const v = this.agentDucked ? 0 : this.volume;
    for (const el of this.audioElements) el.volume = v;
  }

  private bindRoomEvents(): void {
    this.room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) =>
      this.handleTrackSubscribed(track, participant),
    );
    this.room.on(RoomEvent.TrackUnsubscribed, (track, pub) =>
      this.handleTrackUnsubscribed(track, pub),
    );
    this.room.on(RoomEvent.DataReceived, (payload) => this.handleDataReceived(payload));
    this.room.on(RoomEvent.TranscriptionReceived, (segments, participant) =>
      this.handleTranscription(segments, participant),
    );
    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) =>
      this.handleActiveSpeakersChanged(speakers),
    );
    this.room.on(RoomEvent.Disconnected, (reason) => this.handleDisconnected(reason));
    this.room.on(RoomEvent.MediaDevicesError, (err) => {
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private handleTrackSubscribed(track: RemoteTrack, _participant: Participant): void {
    if (track.kind !== Track.Kind.Audio) return;
    const audio = track as RemoteAudioTrack;
    const el = audio.attach();
    el.autoplay = true;
    el.volume = this.agentDucked ? 0 : this.volume;
    el.style.display = 'none';
    if (typeof document !== 'undefined') {
      document.body.appendChild(el);
    }
    if (this.outputDeviceId && 'setSinkId' in el) {
      const withSink = el as HTMLAudioElement & {
        setSinkId: (id: string) => Promise<void>;
      };
      void withSink.setSinkId(this.outputDeviceId).catch((err: unknown) => {
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }
    this.audioElements.add(el);
  }

  private handleTrackUnsubscribed(track: RemoteTrack, _pub: RemoteTrackPublication): void {
    if (track.kind !== Track.Kind.Audio) return;
    const elements = (track as RemoteAudioTrack).detach();
    for (const el of elements) {
      this.audioElements.delete(el);
      el.remove();
    }
  }

  private handleDataReceived(payload: Uint8Array): void {
    const packet = decodePacket(payload);
    if (!packet) {
      // Not our wire protocol — rooms carry data from other publishers too
      // (server control topics, future participants). Surfacing those as
      // errors flipped consumers into a fatal error state mid-call over a
      // packet that was never addressed to us; ignore instead.
      return;
    }
    this.forwardInbound(packet);
  }

  private forwardInbound(packet: InboundPacket): void {
    const message = packetToMessage(packet);
    if (message) this.callbacks.onMessage?.(message);
  }

  // LiveKit Agents (the Speko worker) publishes both the caller's STT and the
  // agent's spoken text as native LiveKit transcriptions — not the custom data
  // packets above. Surface them through onMessage so consumers get a live
  // transcript regardless of transport. Attribution: segments from the local
  // participant are the user; everything else is the agent.
  //
  // Segment updates are cumulative re-deliveries of the SAME id (the agent's
  // transcript arrives word-by-word with growing text; the user's full
  // utterance is re-published per recognizer update, final included), so the
  // id must travel with each message — it is the only way a consumer can
  // upsert instead of appending duplicates.
  private handleTranscription(segments: TranscriptionSegment[], participant?: Participant): void {
    const localIdentity = this.room.localParticipant.identity;
    const source: MessageSource =
      participant && participant.identity === localIdentity ? 'user' : 'agent';
    for (const segment of segments) {
      if (!segment.text) continue;
      this.callbacks.onMessage?.({
        source,
        text: segment.text,
        isFinal: segment.final,
        ...(segment.id ? { segmentId: segment.id } : {}),
        // Stable per-segment receive time — lets consumers order bubbles by
        // when each utterance began rather than by message-arrival order
        // (which interleaves wrong when user/agent speech overlaps).
        ...(Number.isFinite(segment.firstReceivedTime)
          ? { startedAt: segment.firstReceivedTime }
          : {}),
      });
    }
  }

  private handleActiveSpeakersChanged(speakers: Participant[]): void {
    const localIdentity = this.room.localParticipant.identity;
    const remoteSpeaking = speakers.some((s) => s.identity !== localIdentity);
    this.setMode(remoteSpeaking ? 'speaking' : 'listening');
  }

  private handleDisconnected(reason: DisconnectReason | undefined): void {
    this.setStatus('disconnected');
    this.stopBargeInDuck();
    // Release the OS-level microphone capture so the browser indicator
    // stops after the call ends.
    this.localTrack?.stop();
    this.localTrack = undefined;
    for (const el of this.audioElements) el.remove();
    this.audioElements.clear();
    this.callbacks.onDisconnect?.(mapDisconnect(reason));
  }

  private setStatus(status: ConversationStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }

  private setMode(mode: ConversationMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.callbacks.onModeChange?.(mode);
  }

  // ── Instant barge-in duck ──────────────────────────────────────────────────
  // Tap the (already-published) local mic; the instant the caller speaks while
  // the agent is talking, silence the agent's <audio> so its buffered audio can't
  // drain. Restore when the agent's reply resumes — it goes silent (the worker
  // yielded) then speaks again — or after a fallback if the agent never yields
  // (a backchannel that wasn't a real interrupt). Mode ('speaking'/'listening')
  // tracks the agent's REAL track energy via ActiveSpeakers, unaffected by the
  // playback-volume mute, so it cleanly signals yield + reply-resume. Best-effort:
  // any failure (AudioContext blocked, no mic) leaves playback untouched.
  private startBargeInDuck(): void {
    if (typeof window === 'undefined' || !this.localTrack) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const micTrack = this.localTrack.mediaStreamTrack;
    if (!Ctor || !micTrack) return;
    try {
      const ctx = new Ctor();
      this.bargeInCtx = ctx;
      if (ctx.state === 'suspended') void ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      this.bargeInTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const micRms = Math.sqrt(sum / buf.length);
        const agentSpeaking = this.mode === 'speaking';
        if (!this.agentDucked) {
          if (micRms > BARGE_IN_MIC_RMS && agentSpeaking) this.duckAgent();
        } else if (!agentSpeaking) {
          // The interrupted audio drained / the worker yielded — arm the restore.
          this.agentWentSilentSinceDuck = true;
        } else if (this.agentWentSilentSinceDuck) {
          // Agent resumed after going silent → that's the fresh reply.
          this.restoreAgent();
        }
      }, BARGE_IN_POLL_MS);
    } catch {
      this.stopBargeInDuck();
    }
  }

  private duckAgent(): void {
    if (this.agentDucked) return;
    this.agentDucked = true;
    this.agentWentSilentSinceDuck = false;
    this.applyAgentVolume();
    // Safety net: a backchannel ("mm-hmm") makes the caller "speak" without the
    // worker yielding, so the agent never goes silent. Un-duck after a short
    // window so we don't permanently mute an agent that isn't being interrupted.
    if (this.bargeInFallback) clearTimeout(this.bargeInFallback);
    this.bargeInFallback = setTimeout(() => this.restoreAgent(), BARGE_IN_FALLBACK_MS);
  }

  private restoreAgent(): void {
    if (this.bargeInFallback) {
      clearTimeout(this.bargeInFallback);
      this.bargeInFallback = undefined;
    }
    if (!this.agentDucked) return;
    this.agentDucked = false;
    this.agentWentSilentSinceDuck = false;
    this.applyAgentVolume();
  }

  private stopBargeInDuck(): void {
    if (this.bargeInTimer) {
      clearInterval(this.bargeInTimer);
      this.bargeInTimer = undefined;
    }
    if (this.bargeInFallback) {
      clearTimeout(this.bargeInFallback);
      this.bargeInFallback = undefined;
    }
    this.bargeInCtx?.close().catch(() => undefined);
    this.bargeInCtx = undefined;
    this.agentDucked = false;
    this.agentWentSilentSinceDuck = false;
  }
}

function mapDisconnect(reason: DisconnectReason | undefined): DisconnectionDetails {
  const mapped: DisconnectionReason =
    reason === DisconnectReason.CLIENT_INITIATED
      ? 'user'
      : reason === DisconnectReason.PARTICIPANT_REMOVED ||
          reason === DisconnectReason.ROOM_DELETED ||
          reason === DisconnectReason.ROOM_CLOSED
        ? 'agent'
        : reason === DisconnectReason.JOIN_FAILURE
          ? 'error'
          : reason === undefined
            ? 'unknown'
            : 'unknown';
  return { reason: mapped, message: reason ? DisconnectReason[reason] : undefined };
}
