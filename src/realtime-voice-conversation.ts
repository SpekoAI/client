import { reconcileTranscript } from './transcript.js';
import type {
  ConversationMessage,
  ConversationMode,
  ConversationStatus,
  LegacyRealtimeConversationOptions,
  ProviderDirectRealtimeConversationOptions,
  RealtimeConversationOptions,
} from './types.js';

type ReadyFrame = { inputSampleRate: 16000 | 24000; outputSampleRate: 16000 | 24000 };

interface EntitlementRenewalResponse {
  entitlement_id: string;
  sequence: number;
  lease_expires_at: string;
  authorized_units: number;
  maximum_amount_micros: number;
  currency: string;
  credential: { kind: 'bearer'; value: string; expires_at: string };
}

const DEFAULT_SAMPLE_RATE = 24_000;
const READY_TIMEOUT_MS = 10_000;
const CAPTURE_FRAME_MS = 20;
const FALLBACK_BUFFER_SIZE = 1024;
const JITTER_BUFFER_SECONDS = 0.02;

export class RealtimeVoiceConversation {
  private readonly options: RealtimeConversationOptions;
  private ws: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private openAIInputContext: AudioContext | null = null;
  private openAIInputDestination: MediaStreamAudioDestinationNode | null = null;
  private openAIInputScheduledAt = 0;
  private openAIOutputTrack: MediaStreamTrack | null = null;
  private openAIOutputSource: MediaStreamAudioSourceNode | null = null;
  private ctx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private outputGain: GainNode | null = null;
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private captureResampler: Pcm16Resampler | null = null;
  private inputSampleRate: 16000 | 24000;
  private outputSampleRate: 16000 | 24000;
  private status: ConversationStatus = 'disconnected';
  private nextStartAt = 0;
  private mode: ConversationMode = 'listening';
  private micMuted = false;
  private volume = 1;
  private _transcript: ConversationMessage[] = [];
  private openedAtMs: number | null = null;
  private telemetryFinished = false;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private telemetrySequence = 0;
  private authorizedDurationMs = 0;
  private leaseExpiresAt = '';
  private googleResumptionHandle: string | null = null;
  private googleSocketGeneration = 0;
  private googleReady = false;
  private googleReadyEmitted = false;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingGoogleMessages: string[] = [];
  private readyHandler: ((frame: ReadyFrame) => void) | null = null;
  private readyErrorHandler: ((err: Error) => void) | null = null;

  private constructor(options: RealtimeConversationOptions) {
    this.options = options;
    this.inputSampleRate = options.inputSampleRate ?? DEFAULT_SAMPLE_RATE;
    this.outputSampleRate = options.outputSampleRate ?? DEFAULT_SAMPLE_RATE;
    if ('transport' in options && options.transport === 'provider_direct') {
      this.authorizedDurationMs = options.reservation.authorizedDurationSeconds * 1_000;
      this.leaseExpiresAt = options.reservation.leaseExpiresAt;
    }
  }

  static async create(options: RealtimeConversationOptions): Promise<RealtimeVoiceConversation> {
    const conv = new RealtimeVoiceConversation(options);
    await conv.connect();
    return conv;
  }

  getId(): string {
    return this.options.sessionId;
  }

  isOpen(): boolean {
    const direct = this.providerDirectOptions();
    if (direct?.provider === 'openai') {
      return this.status === 'connected' && this.dataChannel?.readyState === 'open';
    }
    return this.status === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  /** The current reconciled transcript (deduped, ordered by startedAt). */
  get transcript(): readonly ConversationMessage[] {
    return this._transcript;
  }

  async endSession(): Promise<void> {
    this.setStatus('disconnecting');
    this.finishTelemetry();
    this.ws?.close(1000, 'client_stopped');
    this.dataChannel?.close();
    this.peer?.close();
    this.cleanup();
    this.setStatus('disconnected');
    this.options.onDisconnect?.({ reason: 'user' });
  }

  async setMicMuted(muted: boolean): Promise<void> {
    this.micMuted = muted;
    this.mediaStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.outputGain) this.outputGain.gain.value = this.volume;
  }

  private async connect(): Promise<void> {
    // Reset transcript on every fresh connect so reconnects don't carry stale turns.
    this._transcript = [];
    this.setStatus('connecting');
    const ready = new Promise<ReadyFrame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Realtime session did not become ready')),
        READY_TIMEOUT_MS,
      );
      const settle = (frame: ReadyFrame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.openTransport(settle, (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const readyFrame = await ready;
    this.inputSampleRate = readyFrame.inputSampleRate;
    this.outputSampleRate = readyFrame.outputSampleRate;
    try {
      await this.setupAudio();
    } catch (err) {
      this.ws?.close(1000, 'audio_setup_failed');
      this.dataChannel?.close();
      this.peer?.close();
      this.cleanup();
      this.setStatus('disconnected');
      throw err;
    }
    this.setStatus('connected');
    this.options.onConnect?.({ conversationId: this.options.sessionId });
    this.setMode('listening');
  }

  private openTransport(
    onReady: (frame: ReadyFrame) => void,
    onReadyError: (err: Error) => void,
  ): void {
    const direct = this.providerDirectOptions();
    this.readyHandler = onReady;
    this.readyErrorHandler = onReadyError;
    if (direct?.provider === 'openai') {
      void this.openOpenAI(direct, onReady, onReadyError);
      return;
    }
    if (direct) {
      this.openDirectWebSocket(direct, direct.credential.value, undefined, onReady, onReadyError);
      return;
    }
    this.openLegacyWebSocket(
      this.options as LegacyRealtimeConversationOptions,
      onReady,
      onReadyError,
    );
  }

  private openLegacyWebSocket(
    legacy: LegacyRealtimeConversationOptions,
    onReady: (frame: ReadyFrame) => void,
    onReadyError: (err: Error) => void,
  ): void {
    const ws = new WebSocket(legacy.wsUrl, [legacy.wsToken]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let startupError: Error | null = null;
    ws.addEventListener('message', (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        this.playPcm(evt.data);
        return;
      }
      if (typeof evt.data !== 'string') return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (parsed['t'] === 'ready') {
        onReady({
          inputSampleRate: parseSampleRate(parsed['inputSampleRate'], this.inputSampleRate),
          outputSampleRate: parseSampleRate(parsed['outputSampleRate'], this.outputSampleRate),
        });
        return;
      }
      const handledError = this.handleJson(parsed);
      if (this.status === 'connecting' && handledError) {
        startupError = handledError;
      }
    });

    ws.addEventListener('close', (evt) => {
      this.finishTelemetry();
      if (this.status === 'connecting') {
        onReadyError(
          startupError ?? new Error(`WebSocket closed before ready: ${evt.code} ${evt.reason}`),
        );
      }
      this.cleanup();
      this.setStatus('disconnected');
      this.options.onDisconnect?.({
        reason: evt.code === 1000 || evt.code === 1005 ? 'agent' : 'error',
        ...(evt.reason ? { message: evt.reason } : {}),
      });
    });

    ws.addEventListener('error', () => {
      const err = new Error('WebSocket transport error');
      this.options.onError?.(err);
      if (this.status === 'connecting') onReadyError(err);
    });
  }

  private openDirectWebSocket(
    direct: ProviderDirectRealtimeConversationOptions,
    credential: string,
    resumptionHandle: string | undefined,
    onReady: (frame: ReadyFrame) => void,
    onReadyError: (err: Error) => void,
  ): void {
    if (direct.provider === 'openai' || direct.providerTransport !== 'websocket') {
      onReadyError(new Error(`Invalid ${direct.provider} realtime transport`));
      return;
    }
    const generation = ++this.googleSocketGeneration;
    const url = providerRealtimeURL(direct.endpoint, direct.provider, direct.model, credential);
    const ws =
      direct.provider === 'google'
        ? new WebSocket(url)
        : new WebSocket(url, [`xai-client-secret.${credential}`]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let startupError: Error | null = null;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.openedAtMs ??= Date.now();
      this.startTelemetry(direct);
      ws.send(JSON.stringify(providerSessionUpdate(direct, resumptionHandle)));
    });
    ws.addEventListener('message', (evt) => {
      if (this.ws !== ws || typeof evt.data !== 'string') return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(evt.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const handledError = this.handleProviderJson(parsed, onReady);
      if (this.status === 'connecting' && handledError) startupError = handledError;
    });
    ws.addEventListener('close', (evt) => {
      if (direct.provider === 'google' && generation !== this.googleSocketGeneration) return;
      if (this.ws !== ws) return;
      this.finishTelemetry();
      if (this.status === 'connecting') {
        onReadyError(
          startupError ?? new Error(`WebSocket closed before ready: ${evt.code} ${evt.reason}`),
        );
      }
      this.cleanup();
      this.setStatus('disconnected');
      this.options.onDisconnect?.({
        reason: evt.code === 1000 || evt.code === 1005 ? 'agent' : 'error',
        ...(evt.reason ? { message: evt.reason } : {}),
      });
    });
    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      const err = new Error('Provider WebSocket transport error');
      this.options.onError?.(err);
      if (this.status === 'connecting') onReadyError(err);
    });
  }

  private async openOpenAI(
    direct: ProviderDirectRealtimeConversationOptions,
    onReady: (frame: ReadyFrame) => void,
    onReadyError: (err: Error) => void,
  ): Promise<void> {
    try {
      if (direct.providerTransport !== 'webrtc') {
        throw new Error('Invalid openai realtime transport');
      }
      const endpoint = validatedOpenAIWebRTCEndpoint(direct.endpoint);
      const sidebandUrl = validatedSidebandURL(
        direct.sidebandUrl,
        direct.telemetry.endpoint,
        direct.sessionId,
      );
      const AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (typeof RTCPeerConnection === 'undefined' || !AudioCtor) {
        throw new Error('OpenAI realtime WebRTC requires browser WebRTC and Web Audio support');
      }
      const peer = new RTCPeerConnection();
      const inputContext = new AudioCtor({ sampleRate: this.inputSampleRate });
      const destination = inputContext.createMediaStreamDestination();
      const inputTrack = destination.stream.getAudioTracks()[0];
      if (!inputTrack) throw new Error('Unable to create the OpenAI realtime audio track');
      this.peer = peer;
      this.openAIInputContext = inputContext;
      this.openAIInputDestination = destination;
      peer.addTrack(inputTrack, destination.stream);
      const channel = peer.createDataChannel('oai-events');
      this.dataChannel = channel;
      channel.addEventListener('open', () => {
        if (this.dataChannel !== channel) return;
        this.openedAtMs ??= Date.now();
        this.startTelemetry(direct);
        channel.send(JSON.stringify(providerSessionUpdate(direct)));
      });
      channel.addEventListener('message', (event) => {
        if (this.dataChannel !== channel || typeof event.data !== 'string') return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const handledError = this.handleProviderJson(parsed, onReady);
        if (this.status === 'connecting' && handledError) onReadyError(handledError);
      });
      channel.addEventListener('error', () => {
        const error = new Error('OpenAI control channel error');
        this.options.onError?.(error);
        if (this.status === 'connecting') onReadyError(error);
      });
      peer.addEventListener('track', (event) => {
        if (event.track.kind !== 'audio') return;
        this.openAIOutputTrack = event.track;
        this.attachOpenAIOutput();
      });
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState !== 'failed' && peer.connectionState !== 'closed') return;
        const error = new Error(`OpenAI WebRTC ${peer.connectionState}`);
        if (this.status === 'connecting') onReadyError(error);
      });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const offerSdp = peer.localDescription?.sdp;
      if (!offerSdp) throw new Error('OpenAI WebRTC offer has no SDP');
      const answer = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${direct.credential.value}`,
          'Content-Type': 'application/sdp',
        },
        body: offerSdp,
      });
      if (!answer.ok) throw new Error(`OpenAI WebRTC setup failed with HTTP ${answer.status}`);
      const callId = openAICallID(answer.headers.get('Location'));
      const answerSdp = await answer.text();
      if (!answerSdp || answerSdp.length > 128 << 10) {
        throw new Error('OpenAI WebRTC answer is invalid');
      }
      const bound = await fetch(sidebandUrl, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${direct.telemetry.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ attempt_id: direct.attemptId, provider_session_id: callId }),
      });
      if (!bound.ok) throw new Error(`OpenAI billing sideband failed with HTTP ${bound.status}`);
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (error) {
      this.cleanup();
      onReadyError(error instanceof Error ? error : new Error('OpenAI WebRTC setup failed'));
    }
  }

  private handleJson(parsed: Record<string, unknown>): Error | null {
    const t = parsed['t'];
    if (t === 'transcript') {
      const msg: ConversationMessage = {
        source: parsed['role'] === 'user' ? 'user' : 'agent',
        text: String(parsed['text'] ?? ''),
        isFinal: Boolean(parsed['final']),
      };
      // (a) Back-compat: forward to the consumer's onMessage unchanged.
      this.options.onMessage?.(msg);
      // (b) Reconcile into the canonical list.
      this._transcript = reconcileTranscript(this._transcript, msg);
      // (c) Fire onTranscript with the full reconciled list.
      this.options.onTranscript?.(this._transcript);
    } else if (t === 'interruption') {
      this.clearPlayback();
      this.setMode('listening');
    } else if (t === 'error') {
      const err = new Error(
        `${String(parsed['code'] ?? 'ERROR')}: ${String(parsed['message'] ?? '')}`,
      );
      this.options.onError?.(err);
      return err;
    }
    return null;
  }

  private handleProviderJson(
    event: Record<string, unknown>,
    onReady: (frame: ReadyFrame) => void,
  ): Error | null {
    if (this.providerDirectOptions()?.provider === 'google') {
      return this.handleGoogleJson(event, onReady);
    }
    switch (event['type']) {
      case 'session.updated':
        onReady({ inputSampleRate: this.inputSampleRate, outputSampleRate: this.outputSampleRate });
        break;
      case 'response.output_audio.delta': {
        const delta = event['delta'];
        if (typeof delta === 'string' && delta) {
          this.playPcm(new Uint8Array(decodeBase64(delta)).buffer);
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.delta':
        this.emitProviderTranscript('user', event['delta'], false, event['item_id']);
        break;
      case 'conversation.item.input_audio_transcription.updated':
        // xAI streams a cumulative, correctable transcript for the item.
        this.emitProviderTranscript('user', event['transcript'], false, event['item_id']);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.emitProviderTranscript('user', event['transcript'], true, event['item_id']);
        break;
      case 'response.output_audio_transcript.delta':
        this.emitProviderTranscript('agent', event['delta'], false);
        break;
      case 'response.output_audio_transcript.done':
        this.emitProviderTranscript('agent', event['transcript'], true);
        break;
      case 'input_audio_buffer.speech_started':
        this.clearPlayback();
        this.setMode('listening');
        break;
      case 'error': {
        const providerError = asRecord(event['error']);
        const err = new Error(
          `${String(providerError['code'] ?? 'PROVIDER_ERROR')}: ${String(providerError['message'] ?? 'Provider realtime error')}`,
        );
        this.options.onError?.(err);
        return err;
      }
      default:
        break;
    }
    return null;
  }

  private handleGoogleJson(
    event: Record<string, unknown>,
    onReady: (frame: ReadyFrame) => void,
  ): Error | null {
    if (event['setupComplete'] !== undefined) {
      this.googleReady = true;
      if (!this.googleReadyEmitted) {
        this.googleReadyEmitted = true;
        onReady({ inputSampleRate: this.inputSampleRate, outputSampleRate: this.outputSampleRate });
      }
      const socket = this.ws;
      if (socket?.readyState === WebSocket.OPEN) {
        for (const message of this.pendingGoogleMessages.splice(0)) socket.send(message);
      }
      this.scheduleGoogleRenewal();
    }
    const resumption = asRecord(event['sessionResumptionUpdate']);
    const newHandle = resumption['newHandle'];
    if (typeof newHandle === 'string' && newHandle) this.googleResumptionHandle = newHandle;
    const content = asRecord(event['serverContent']);
    const inputTranscription = asRecord(content['inputTranscription']);
    if (inputTranscription['text'] !== undefined) {
      this.emitProviderTranscript('user', inputTranscription['text'], true);
    }
    const outputTranscription = asRecord(content['outputTranscription']);
    if (outputTranscription['text'] !== undefined) {
      this.emitProviderTranscript(
        'agent',
        outputTranscription['text'],
        Boolean(content['turnComplete']),
      );
    }
    const modelTurn = asRecord(content['modelTurn']);
    const parts = Array.isArray(modelTurn['parts']) ? modelTurn['parts'] : [];
    for (const value of parts) {
      const inlineData = asRecord(asRecord(value)['inlineData']);
      const audio = inlineData['data'];
      if (typeof audio === 'string' && audio) {
        this.playPcm(new Uint8Array(decodeBase64(audio)).buffer);
      }
    }
    if (content['interrupted'] === true) {
      this.clearPlayback();
      this.setMode('listening');
    }
    const providerError = asRecord(event['error']);
    if (Object.keys(providerError).length > 0) {
      const err = new Error(
        `${String(providerError['status'] ?? providerError['code'] ?? 'PROVIDER_ERROR')}: ${String(providerError['message'] ?? 'Gemini Live error')}`,
      );
      this.options.onError?.(err);
      return err;
    }
    return null;
  }

  private emitProviderTranscript(
    source: 'user' | 'agent',
    value: unknown,
    isFinal: boolean,
    segmentId?: unknown,
  ): void {
    if (typeof value !== 'string' || !value) return;
    const message: ConversationMessage = {
      source,
      text: value,
      isFinal,
      ...(typeof segmentId === 'string' && segmentId ? { segmentId } : {}),
    };
    this.options.onMessage?.(message);
    this._transcript = reconcileTranscript(this._transcript, message);
    this.options.onTranscript?.(this._transcript);
  }

  private async setupAudio(): Promise<void> {
    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) throw new Error('AudioContext is not available in this browser');

    const ctx = new AudioCtor();
    this.ctx = ctx;
    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = this.volume;
    this.outputGain.connect(ctx.destination);
    this.nextStartAt = ctx.currentTime;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: this.inputSampleRate,
        echoCancellation: this.options.audioConstraints?.echoCancellation ?? true,
        noiseSuppression: this.options.audioConstraints?.noiseSuppression ?? true,
        autoGainControl: this.options.audioConstraints?.autoGainControl,
        ...(this.options.inputDeviceId ? { deviceId: { exact: this.options.inputDeviceId } } : {}),
      },
    });
    this.mediaStream = stream;
    if (this.micMuted) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    }
    this.source = ctx.createMediaStreamSource(stream);

    if (!(await this.trySetupWorklet(ctx))) this.setupScriptProcessor(ctx);
    this.attachOpenAIOutput();
  }

  private attachOpenAIOutput(): void {
    const track = this.openAIOutputTrack;
    const ctx = this.ctx;
    const gain = this.outputGain;
    if (!track || !ctx || !gain || this.openAIOutputSource) return;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(gain);
    this.openAIOutputSource = source;
  }

  private async trySetupWorklet(ctx: AudioContext): Promise<boolean> {
    if (!ctx.audioWorklet) return false;
    const url = URL.createObjectURL(new Blob([workletSource()], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
      const worklet = new AudioWorkletNode(ctx, 'speko-realtime-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          targetSampleRate: this.inputSampleRate,
          frameSize: Math.round((this.inputSampleRate * CAPTURE_FRAME_MS) / 1000),
        },
      });
      worklet.port.onmessage = (evt: MessageEvent<ArrayBuffer>) => {
        if (evt.data instanceof ArrayBuffer) this.sendAudio(new Uint8Array(evt.data));
      };
      const silent = ctx.createGain();
      silent.gain.value = 0;
      this.worklet = worklet;
      this.silentGain = silent;
      this.source?.connect(worklet);
      worklet.connect(silent);
      silent.connect(ctx.destination);
      return true;
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private setupScriptProcessor(ctx: AudioContext): void {
    const processor = ctx.createScriptProcessor(FALLBACK_BUFFER_SIZE, 1, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    this.captureResampler = new Pcm16Resampler(ctx.sampleRate, this.inputSampleRate);
    processor.onaudioprocess = (evt) => {
      const input = evt.inputBuffer.getChannelData(0);
      for (const frame of this.captureResampler?.push(input) ?? []) {
        this.sendAudio(frame);
      }
    };
    this.processor = processor;
    this.silentGain = silent;
    this.source?.connect(processor);
    processor.connect(silent);
    silent.connect(ctx.destination);
  }

  private sendAudio(pcm: Uint8Array): void {
    if (this.micMuted) return;
    const direct = this.providerDirectOptions();
    if (direct?.provider === 'openai') {
      this.sendOpenAIAudio(pcm);
      return;
    }
    if (direct?.provider === 'google') {
      const encoded = JSON.stringify({
        realtimeInput: {
          audio: { mimeType: 'audio/pcm;rate=16000', data: encodeBase64(pcm) },
        },
      });
      if (!this.googleReady || this.ws?.readyState !== WebSocket.OPEN) {
        if (this.pendingGoogleMessages.length < 128) this.pendingGoogleMessages.push(encoded);
        return;
      }
      this.ws.send(encoded);
      return;
    }
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (direct) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: encodeBase64(pcm) }));
      return;
    }
    const copy = new Uint8Array(pcm.byteLength);
    copy.set(pcm);
    this.ws.send(copy.buffer);
  }

  private sendOpenAIAudio(pcm: Uint8Array): void {
    const context = this.openAIInputContext;
    const destination = this.openAIInputDestination;
    if (!context || !destination || this.dataChannel?.readyState !== 'open' || pcm.byteLength < 2) {
      return;
    }
    const sampleCount = Math.floor(pcm.byteLength / 2);
    const buffer = context.createBuffer(1, sampleCount, this.inputSampleRate);
    const samples = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, sampleCount * 2);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const startAt = Math.max(context.currentTime + 0.005, this.openAIInputScheduledAt);
    source.start(startAt);
    this.openAIInputScheduledAt = startAt + buffer.duration;
    source.addEventListener('ended', () => source.disconnect(), { once: true });
    void context.resume().catch(() => undefined);
  }

  private playPcm(pcm: ArrayBuffer): void {
    const ctx = this.ctx;
    const gain = this.outputGain;
    if (!ctx || !gain) return;
    const i16 = new Int16Array(pcm);
    if (i16.length === 0) return;
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = (i16[i] ?? 0) / 32768;
    const buf = ctx.createBuffer(1, f32.length, this.outputSampleRate);
    buf.getChannelData(0).set(f32);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    const startAt = Math.max(this.nextStartAt, ctx.currentTime + JITTER_BUFFER_SECONDS);
    this.nextStartAt = startAt + buf.duration;
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
      if (this.activeSources.size === 0) this.setMode('listening');
    };
    this.setMode('speaking');
    src.start(startAt);
  }

  private clearPlayback(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
    if (this.ctx) this.nextStartAt = this.ctx.currentTime;
  }

  private cleanup(): void {
    if (this.renewalTimer !== null) clearTimeout(this.renewalTimer);
    this.renewalTimer = null;
    this.clearPlayback();
    this.worklet?.disconnect();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.outputGain?.disconnect();
    this.openAIOutputSource?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.ctx?.close().catch(() => undefined);
    this.openAIInputContext?.close().catch(() => undefined);
    try {
      this.dataChannel?.close();
      this.peer?.close();
    } catch {
      // ignore
    }
    this.worklet = null;
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.outputGain = null;
    this.mediaStream = null;
    this.ctx = null;
    this.captureResampler = null;
    this.openAIOutputSource = null;
    this.openAIOutputTrack = null;
    this.openAIInputDestination = null;
    this.openAIInputContext = null;
    this.dataChannel = null;
    this.peer = null;
    this.ws = null;
  }

  private setStatus(status: ConversationStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private setMode(mode: ConversationMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.options.onModeChange?.(mode);
  }

  private providerDirectOptions(): ProviderDirectRealtimeConversationOptions | null {
    return 'transport' in this.options && this.options.transport === 'provider_direct'
      ? this.options
      : null;
  }

  private finishTelemetry(): void {
    const direct = this.providerDirectOptions();
    if (!direct || this.telemetryFinished) return;
    this.telemetryFinished = true;
    if (this.telemetryTimer !== null) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    this.sendTelemetry(direct, true);
  }

  private startTelemetry(direct: ProviderDirectRealtimeConversationOptions): void {
    if (this.telemetryTimer !== null || this.telemetryFinished) return;
    this.telemetryTimer = setInterval(
      () => this.sendTelemetry(direct, false),
      direct.telemetry.flushIntervalMs,
    );
  }

  private scheduleGoogleRenewal(): void {
    const direct = this.providerDirectOptions();
    if (direct?.provider !== 'google') return;
    const renewalUrl = direct.reservation.billing.renewalUrl;
    const renewableUntil = direct.reservation.billing.renewableUntil;
    if (!renewalUrl || !renewableUntil) return;
    if (Date.parse(this.leaseExpiresAt) >= Date.parse(renewableUntil)) return;
    if (this.renewalTimer !== null) clearTimeout(this.renewalTimer);
    const remainingMs = Math.max(0, Date.parse(this.leaseExpiresAt) - Date.now());
    const leadMs = Math.min(15_000, Math.max(2_000, Math.floor(remainingMs / 5)));
    this.renewalTimer = setTimeout(
      () => void this.renewGoogleEntitlement(0),
      Math.max(0, remainingMs - leadMs),
    );
  }

  private async renewGoogleEntitlement(attempt: number): Promise<void> {
    const direct = this.providerDirectOptions();
    if (direct?.provider !== 'google' || !this.readyHandler || !this.readyErrorHandler) return;
    const previousExpiresAt = this.leaseExpiresAt;
    try {
      if (!this.googleResumptionHandle) {
        throw new Error('Gemini Live did not provide a session-resumption handle');
      }
      const renewalUrl = validatedRenewalURL(
        direct.reservation.billing.renewalUrl,
        direct.telemetry.endpoint,
        direct.sessionId,
      );
      const response = await fetch(renewalUrl, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${direct.telemetry.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `renew:${direct.attemptId}:${previousExpiresAt}`,
        },
        body: JSON.stringify({ previous_expires_at: previousExpiresAt }),
      });
      if (!response.ok) throw new Error(`entitlement renewal failed with HTTP ${response.status}`);
      const renewal = (await response.json()) as EntitlementRenewalResponse;
      assertRenewalResponse(renewal, previousExpiresAt, direct.reservation.billing.renewableUntil);
      const oldSocket = this.ws;
      this.googleReady = false;
      this.googleSocketGeneration += 1;
      this.ws = null;
      try {
        oldSocket?.close(1000, 'entitlement_rotation');
      } catch {
        // The generation guard suppresses a stale close event.
      }
      this.authorizedDurationMs += renewal.authorized_units * 1_000;
      this.leaseExpiresAt = renewal.lease_expires_at;
      this.openDirectWebSocket(
        direct,
        renewal.credential.value,
        this.googleResumptionHandle,
        this.readyHandler,
        this.readyErrorHandler,
      );
    } catch (error) {
      const remainingMs = Date.parse(previousExpiresAt) - Date.now();
      if (attempt < 2 && remainingMs > 3_000) {
        this.renewalTimer = setTimeout(
          () => void this.renewGoogleEntitlement(attempt + 1),
          Math.min(2_000, Math.max(250, remainingMs - 2_000)),
        );
        return;
      }
      this.options.onError?.(
        new Error(
          error instanceof Error ? error.message : 'Gemini Live entitlement renewal failed',
        ),
      );
      this.renewalTimer = setTimeout(
        () => {
          this.ws?.close(4003, 'entitlement_expired');
        },
        Math.max(0, remainingMs),
      );
    }
  }

  private sendTelemetry(
    direct: ProviderDirectRealtimeConversationOptions | false,
    terminal: boolean,
  ): void {
    if (!direct) {
      const options = this.providerDirectOptions();
      if (!options || this.telemetryFinished) return;
      direct = options;
    }
    const createdAtMs = Date.now();
    const elapsed = this.openedAtMs === null ? 0 : Math.max(0, createdAtMs - this.openedAtMs);
    const quantityMillis = Math.min(this.authorizedDurationMs, elapsed);
    this.telemetrySequence += 1;
    const common = {
      session_id: direct.sessionId,
      attempt_id: direct.attemptId,
      created_at_ms: createdAtMs,
    };
    void fetch(direct.telemetry.endpoint, {
      method: 'POST',
      keepalive: true,
      headers: {
        Authorization: `Bearer ${direct.telemetry.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        events: [
          {
            ...common,
            type: 'usage.reported',
            event_id: `${direct.attemptId}:usage.reported:${this.telemetrySequence}`,
            data: { unit: 'duration_seconds', quantity_millis: quantityMillis },
          },
          ...(terminal
            ? [
                {
                  ...common,
                  type: 'session.closed',
                  event_id: `${direct.attemptId}:session.closed`,
                },
              ]
            : []),
        ],
      }),
    }).catch(() => undefined);
  }
}

function providerSessionUpdate(
  options: ProviderDirectRealtimeConversationOptions,
  resumptionHandle?: string,
): Record<string, unknown> {
  if (options.provider === 'google') {
    const generationConfig: Record<string, unknown> = { responseModalities: ['AUDIO'] };
    if (options.session?.voice) {
      generationConfig['speechConfig'] = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: options.session.voice } },
      };
    }
    if (options.session?.temperature !== undefined) {
      generationConfig['temperature'] = options.session.temperature;
    }
    return {
      setup: {
        model: `models/${options.model.replace(/^models\//, '')}`,
        generationConfig,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
        ...(options.session?.instructions !== undefined
          ? { systemInstruction: { parts: [{ text: options.session.instructions }] } }
          : {}),
      },
    };
  }
  if (options.provider === 'xai') {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: options.model,
        output_modalities: ['audio'],
        turn_detection: { type: 'server_vad' },
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'grok-transcribe' },
          },
          output: { format: { type: 'audio/pcm', rate: 24000 } },
        },
        ...(options.session?.voice ? { voice: options.session.voice } : {}),
        ...(options.session?.instructions !== undefined
          ? { instructions: options.session.instructions }
          : {}),
      },
    };
  }
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: { type: 'server_vad' },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          ...(options.session?.voice ? { voice: options.session.voice } : {}),
        },
      },
      ...(options.session?.instructions !== undefined
        ? { instructions: options.session.instructions }
        : {}),
    },
  };
}

function providerRealtimeURL(
  endpoint: string,
  provider: ProviderDirectRealtimeConversationOptions['provider'],
  model: string,
  credential: string,
): string {
  if (provider === 'openai') throw new Error('OpenAI realtime requires WebRTC');
  const url = new URL(endpoint);
  const expectedHost = provider === 'xai' ? 'api.x.ai' : 'generativelanguage.googleapis.com';
  const expectedPath =
    provider === 'google'
      ? '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'
      : '/v1/realtime';
  if (
    url.protocol !== 'wss:' ||
    url.hostname !== expectedHost ||
    (url.port && url.port !== '443') ||
    url.pathname !== expectedPath ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid ${provider} realtime endpoint`);
  }
  if (provider === 'google') {
    url.searchParams.set('access_token', credential);
  } else {
    url.searchParams.set('model', model);
  }
  return url.toString();
}

function validatedOpenAIWebRTCEndpoint(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.openai.com' ||
    (url.port && url.port !== '443') ||
    url.pathname !== '/v1/realtime/calls' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid openai realtime endpoint');
  }
  return url.toString();
}

function validatedSidebandURL(
  raw: string | undefined,
  telemetryEndpoint: string,
  sessionId: string,
): string {
  if (!raw) throw new Error('OpenAI billing sideband URL is missing');
  const url = new URL(raw);
  const telemetry = new URL(telemetryEndpoint);
  if (
    url.protocol !== 'https:' ||
    url.origin !== telemetry.origin ||
    url.pathname !== `/v1/sessions/${encodeURIComponent(sessionId)}/sidebands/openai` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid OpenAI billing sideband URL');
  }
  return url.toString();
}

function validatedRenewalURL(
  raw: string | undefined,
  telemetryEndpoint: string,
  sessionId: string,
): string {
  if (!raw) throw new Error('Gemini Live entitlement renewal URL is missing');
  const url = new URL(raw);
  const telemetry = new URL(telemetryEndpoint);
  if (
    url.protocol !== 'https:' ||
    url.origin !== telemetry.origin ||
    url.pathname !== `/v1/sessions/${encodeURIComponent(sessionId)}/entitlements/renew` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Gemini Live entitlement renewal URL');
  }
  return url.toString();
}

function openAICallID(location: string | null): string {
  if (!location) throw new Error('OpenAI WebRTC response did not include a call ID');
  const url = new URL(location, 'https://api.openai.com');
  if (url.origin !== 'https://api.openai.com' || url.search || url.hash) {
    throw new Error('OpenAI WebRTC call location is invalid');
  }
  const match = /^\/v1\/realtime\/calls\/([^/]+)$/.exec(url.pathname);
  const callId = match?.[1] ? decodeURIComponent(match[1]) : '';
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(callId)) {
    throw new Error('OpenAI WebRTC call ID is invalid');
  }
  return callId;
}

function assertRenewalResponse(
  renewal: EntitlementRenewalResponse,
  previousExpiresAt: string,
  renewableUntil: string | undefined,
): void {
  const previousExpiryMs = Date.parse(previousExpiresAt);
  const leaseExpiryMs = Date.parse(renewal?.lease_expires_at);
  const credentialExpiryMs = Date.parse(renewal?.credential?.expires_at);
  const renewableUntilMs = Date.parse(renewableUntil ?? '');
  if (
    !renewal ||
    typeof renewal.entitlement_id !== 'string' ||
    !renewal.entitlement_id ||
    !Number.isInteger(renewal.sequence) ||
    renewal.sequence <= 0 ||
    !Number.isInteger(renewal.authorized_units) ||
    renewal.authorized_units <= 0 ||
    renewal.authorized_units > 300 ||
    !Number.isSafeInteger(renewal.maximum_amount_micros) ||
    renewal.maximum_amount_micros <= 0 ||
    renewal.currency !== 'USD' ||
    renewal.credential?.kind !== 'bearer' ||
    !renewal.credential.value ||
    !Number.isFinite(previousExpiryMs) ||
    !Number.isFinite(leaseExpiryMs) ||
    !Number.isFinite(credentialExpiryMs) ||
    !Number.isFinite(renewableUntilMs) ||
    leaseExpiryMs <= previousExpiryMs ||
    leaseExpiryMs > renewableUntilMs ||
    credentialExpiryMs < leaseExpiryMs
  ) {
    throw new Error('Gemini Live entitlement renewal response is invalid');
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

class Pcm16Resampler {
  private readonly frameSize: number;
  private readonly pending: number[] = [];

  constructor(
    private readonly sourceRate: number,
    private readonly targetRate: number,
  ) {
    this.frameSize = Math.round((targetRate * CAPTURE_FRAME_MS) / 1000);
  }

  push(input: Float32Array): Uint8Array[] {
    const ratio = this.sourceRate / this.targetRate;
    const outLength = Math.max(1, Math.floor(input.length / ratio));
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, input.length - 1);
      const frac = pos - lo;
      const sample = (input[lo] ?? 0) * (1 - frac) + (input[hi] ?? 0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.pending.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }

    const frames: Uint8Array[] = [];
    while (this.pending.length >= this.frameSize) {
      const pcm = new Int16Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i++) pcm[i] = this.pending.shift() ?? 0;
      frames.push(new Uint8Array(pcm.buffer));
    }
    return frames;
  }
}

function parseSampleRate(value: unknown, fallback: 16000 | 24000): 16000 | 24000 {
  return value === 16000 || value === 24000 ? value : fallback;
}

function workletSource(): string {
  return `
class SpekoRealtimeCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetSampleRate;
    this.frameSize = options.processorOptions.frameSize;
    this.pending = [];
  }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (input) {
      if (output) output.fill(0);
      const ratio = sampleRate / this.targetRate;
      const outLength = Math.max(1, Math.floor(input.length / ratio));
      for (let i = 0; i < outLength; i++) {
        const pos = i * ratio;
        const lo = Math.floor(pos);
        const hi = Math.min(lo + 1, input.length - 1);
        const frac = pos - lo;
        const sample = (input[lo] || 0) * (1 - frac) + (input[hi] || 0) * frac;
        const clamped = Math.max(-1, Math.min(1, sample));
        this.pending.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      }
      while (this.pending.length >= this.frameSize) {
        const pcm = new Int16Array(this.frameSize);
        for (let i = 0; i < this.frameSize; i++) pcm[i] = this.pending.shift() || 0;
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('speko-realtime-capture', SpekoRealtimeCapture);
`;
}
