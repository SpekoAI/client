import {
  createLocalAudioTrack,
  DisconnectReason,
  type LocalAudioTrack,
  type Participant,
  ParticipantKind,
  type RemoteAudioTrack,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
} from 'livekit-client';
import { CALL_OVER_REASONS, reasonName } from './call-room.js';
import { SpekoClientError } from './errors.js';
import { RemoteAudioPlayback } from './remote-audio.js';

/**
 * `connecting` then `live`, then one of two terminal states: `ended` (you
 * handed the call back, or the call is over) or `failed` (the connection was
 * lost). A call that ends during the join goes from `connecting` to `ended`.
 * A take-over never leaves a terminal state. To take the call over again,
 * mint a new token and connect a new `CallTakeover`.
 */
export type CallTakeoverStatus = 'connecting' | 'live' | 'ended' | 'failed';

export interface CallTakeoverEndDetails {
  /**
   * `handed_back`: your code called `handBack()`, and the agent takes the
   * call again. `call_ended`: the call is over.
   */
  readonly reason: 'handed_back' | 'call_ended';
}

/**
 * `you` is this browser. `agent` is the AI, which stays silent while you are
 * on the call. `caller` is anyone else on it.
 */
export type CallTakeoverSpeaker = 'you' | 'agent' | 'caller';

/** What `speko.calls.webJoin(callId)` returns, or the part of it a browser needs. */
export interface CallTakeoverCredentials {
  readonly url: string;
  readonly token: string;
}

/** Give either `url` and `token`, or `credentials`. */
export type CallTakeoverOptions = CallTakeoverCommonOptions &
  (
    | (CallTakeoverCredentials & { readonly credentials?: never })
    | {
        /**
         * Called once the browser has granted the microphone, to fetch fresh
         * credentials from your backend. Recommended: Speko waits about a
         * minute after the mint for the microphone to reach the call, and a
         * person can take longer than that to answer the permission prompt.
         */
        readonly credentials: () => Promise<CallTakeoverCredentials>;
        readonly url?: never;
        readonly token?: never;
      }
  );

export interface CallTakeoverCommonOptions {
  /**
   * How long to wait, after the microphone reached the call, for Speko to
   * confirm the take-over (the agent is silent and the caller hears you).
   * Default 20000 ms.
   */
  readonly confirmTimeoutMs?: number;
  /**
   * Cancels the take-over: at any point before `connect()` settles, the
   * browser never joins or leaves at once, and the microphone is released.
   * `connect()` then resolves to a take-over whose status is `ended`, after
   * `onEnded` fired with `handed_back`. Abort it when the person leaves the
   * page or clicks cancel.
   */
  readonly signal?: AbortSignal;
  /** Microphone device id from `navigator.mediaDevices.enumerateDevices()`. */
  readonly inputDeviceId?: string;
  /**
   * Output device id. The call is audible on this device only, and stays
   * silent if the browser cannot route it there. See `onOutputDeviceError`.
   */
  readonly outputDeviceId?: string;
  /** Playback volume from 0 to 1. Default 1. */
  readonly volume?: number;
  onStatusChange?: (status: CallTakeoverStatus) => void;
  /** The take-over reached `ended`. */
  onEnded?: (details: CallTakeoverEndDetails) => void;
  /**
   * The take-over reached `failed` after it was live (`error.code` is
   * `DISCONNECTED`), or the microphone stopped while live (`MICROPHONE_FAILED`:
   * unplugged, or the permission revoked; the connection stays up, the agent
   * stays silent and the caller no longer hears you, so hand the call back).
   */
  onError?: (error: SpekoClientError) => void;
  /** Who is speaking now. An empty array means silence. */
  onSpeakersChange?: (speakers: readonly CallTakeoverSpeaker[]) => void;
  /**
   * The browser blocked audio playback, so you hear nothing. Show a button
   * and call `startAudio()` from its click handler.
   */
  onAudioPlaybackBlocked?: () => void;
  /** The browser could not play the call on `outputDeviceId`. Called at most once. */
  onOutputDeviceError?: (error: Error) => void;
}

type Terminal =
  | { readonly status: 'ended'; readonly reason: CallTakeoverEndDetails['reason'] }
  | { readonly status: 'failed'; readonly error: SpekoClientError };

// A disconnect that arrives before the join settles is part of `connecting`.
type Connecting = {
  readonly status: 'connecting';
  readonly earlyDisconnect: { readonly reason: DisconnectReason | undefined } | null;
};

type State = Connecting | { readonly status: 'live' } | Terminal;

type JoinResult = { readonly ok: true } | { readonly ok: false; readonly cause: unknown };

const ROLE_ORDER: readonly CallTakeoverSpeaker[] = ['you', 'agent', 'caller'];

const DEFAULT_CONFIRM_TIMEOUT_MS = 20_000;

// Sent by the agent, to this browser alone, once it has gone silent for it
// (worker agent.py `_ack_bridge_muted`). The server's own `transfer_completed`
// is only the request to mute, so it is not enough.
const CONTROL_TOPIC = 'speko.control';
const BRIDGE_MUTED = 'bridge_muted';

/**
 * Takes a live call over from the browser: you talk to the caller with your
 * microphone, and the agent goes silent until you hand the call back.
 *
 * The take-over starts when your microphone track reaches the call. The
 * server then connects your audio to a phone caller and tells the agent to
 * stop listening and speaking. When you hand back (or your browser leaves),
 * the agent learns that a teammate spoke to the caller, which it did not
 * hear, and asks the caller whether there is anything else.
 *
 * Disconnect a `CallListener` on the same call before you take it over, or you
 * hear the call twice.
 */
export class CallTakeover {
  private readonly room = new Room();
  private readonly playback: RemoteAudioPlayback;
  private state: State = { status: 'connecting', earlyDisconnect: null };
  private speakers: readonly CallTakeoverSpeaker[] = [];
  private outputDeviceFailed = false;
  private microphone: LocalAudioTrack | null = null;
  private muted = false;
  private microphoneFailed = false;
  // The microphone stopped (ended, or muted by the browser) at any point.
  private microphoneLost = false;
  // setMuted calls run one after another; a `Muted` event while one runs is ours.
  private muteChain: Promise<void> = Promise.resolve();
  private muteOpsInFlight = 0;
  private takeOverConfirmed = false;
  private confirmation: ((confirmed: boolean) => void) | null = null;

  private constructor(private readonly options: CallTakeoverOptions) {
    this.playback = new RemoteAudioPlayback({
      outputDeviceId: options.outputDeviceId,
      // A private call must not reach a device the user did not choose.
      outputDeviceRouting: 'required',
      onPlaybackRejected: () => this.reportIfBlocked(),
      onOutputDeviceError: (cause) => this.reportOutputDeviceError(cause),
    });
    if (options.volume !== undefined) this.playback.setVolume(options.volume);
    this.bindRoomEvents();
  }

  /**
   * Take the microphone, join the call, and resolve once Speko confirms the
   * take-over: the caller hears you and the agent is silent. Rejects with a
   * `SpekoClientError` whose `code` is:
   *
   * - `MICROPHONE_FAILED`: the browser gave no microphone. Nothing joined the
   *   call, so the agent carries on.
   * - `CONNECTION_FAILED`: the join failed, for example because the token
   *   expired, or `credentials()` rejected.
   * - `TAKE_OVER_FAILED`: the microphone reached the call but Speko did not
   *   confirm the take-over within `confirmTimeoutMs`. The browser leaves and
   *   the agent carries on.
   *
   * If the call ends while the join is in progress, `connect()` resolves to a
   * take-over whose status is already `ended`, after `onEnded` fired with
   * `call_ended`. Read `status` before you show a live state.
   */
  static async connect(options: CallTakeoverOptions): Promise<CallTakeover> {
    const takeover = new CallTakeover(options);
    options.onStatusChange?.('connecting');
    const { signal } = options;
    if (signal?.aborted) {
      void takeover.finish({ status: 'ended', reason: 'handed_back' });
      return takeover;
    }
    let settleAborted: () => void = () => undefined;
    const aborted = new Promise<CallTakeover>((resolve) => {
      settleAborted = () => resolve(takeover);
    });
    const abort = () => {
      // Already over (an abort from an `onStatusChange('failed')` handler,
      // say): the join's own outcome, its error included, stands.
      if (isTerminal(takeover.state)) return;
      void takeover.finish({ status: 'ended', reason: 'handed_back' });
      settleAborted();
    };
    signal?.addEventListener('abort', abort, { once: true });
    // The join can wait on a permission prompt or a credentials request that
    // never settles: an abort settles connect() at once, and the join left
    // behind releases the microphone and never joins whenever it moves on.
    const joining = takeover.join();
    joining.catch(() => undefined);
    try {
      return await Promise.race([joining, aborted]);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private async join(): Promise<CallTakeover> {
    // Before the join: a refused microphone must not leave a silent
    // participant on the call.
    let microphone: LocalAudioTrack;
    try {
      microphone = await createLocalAudioTrack({
        ...(this.options.inputDeviceId ? { deviceId: this.options.inputDeviceId } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
    } catch (cause) {
      if (isTerminal(this.state)) return this;
      const error = new SpekoClientError(
        'Failed to acquire microphone',
        'MICROPHONE_FAILED',
        cause,
      );
      void this.terminate({ status: 'failed', error });
      throw error;
    }
    // Cancelled while the browser asked for the microphone.
    if (isTerminal(this.state)) {
      microphone.stop();
      return this;
    }
    this.microphone = microphone;
    this.watchMicrophone();
    const join = await this.resolveCredentials()
      .then(({ url, token }) => {
        // Cancelled while the credentials were fetched: never join.
        if (isTerminal(this.state)) throw new Error('cancelled');
        return this.room.connect(url, token, { autoSubscribe: true });
      })
      .then(
        (): JoinResult => ({ ok: true }),
        (cause: unknown): JoinResult => ({ ok: false, cause }),
      );
    await this.settleJoin(join);
    return this;
  }

  get status(): CallTakeoverStatus {
    return this.state.status;
  }

  /** Whether your microphone is muted. The agent stays silent either way. */
  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Mute or unmute your microphone. The call stays yours while muted: the
   * agent does not take over again until you hand the call back.
   */
  async setMuted(muted: boolean): Promise<void> {
    const run = this.muteChain.then(() => this.applyMuted(muted));
    // A failed call must not wedge the ones after it.
    this.muteChain = run.catch(() => undefined);
    return run;
  }

  private async applyMuted(muted: boolean): Promise<void> {
    const track = this.microphone;
    if (!track || this.state.status !== 'live') return;
    this.muteOpsInFlight += 1;
    try {
      if (muted) await track.mute();
      else await track.unmute();
      this.muted = muted;
    } finally {
      this.muteOpsInFlight -= 1;
    }
  }

  setVolume(volume: number): void {
    this.playback.setVolume(volume);
  }

  /**
   * Resume playback after `onAudioPlaybackBlocked`. Call it from a click or
   * tap handler, or the browser refuses again.
   */
  async startAudio(): Promise<void> {
    try {
      await this.room.startAudio();
    } catch {
      this.options.onAudioPlaybackBlocked?.();
      return;
    }
    this.playback.resume();
  }

  /**
   * Leave the call and give it back to the agent. Safe to call more than once
   * and after the call ended.
   */
  async handBack(): Promise<void> {
    await this.finish({ status: 'ended', reason: 'handed_back' });
  }

  private resolveCredentials(): Promise<CallTakeoverCredentials> {
    const { credentials, url, token } = this.options;
    // Inside `then`, so a callback that throws instead of rejecting still ends
    // as CONNECTION_FAILED with the microphone released.
    if (credentials) return Promise.resolve().then(() => credentials());
    return Promise.resolve({ url: url as string, token: token as string });
  }

  // LiveKit restarts a microphone that ends; one it cannot restart is left
  // muted without a `MediaDevicesError`. Either way the caller hears nothing.
  private watchMicrophone(): void {
    const track = this.microphone;
    if (!track || typeof track.on !== 'function') return;
    const lost = () => {
      this.microphoneLost = true;
      this.reportMicrophoneLost();
    };
    track.on(TrackEvent.Ended, lost);
    track.on(TrackEvent.Muted, () => {
      if (!this.muted && this.muteOpsInFlight === 0) lost();
    });
  }

  private reportMicrophoneLost(): void {
    if (this.microphoneFailed || this.state.status !== 'live') return;
    this.microphoneFailed = true;
    this.options.onError?.(new SpekoClientError('The microphone stopped', 'MICROPHONE_FAILED'));
  }

  private waitForTakeOver(timeoutMs: number): Promise<boolean> {
    if (this.takeOverConfirmed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), timeoutMs);
      const settle = (confirmed: boolean) => {
        clearTimeout(timer);
        this.confirmation = null;
        resolve(confirmed);
      };
      this.confirmation = settle;
    });
  }

  private onControlData(payload: Uint8Array, participant: unknown, topic: string | undefined) {
    // Only the agent's own acknowledgement counts; anyone else in the room
    // can publish data, but none of them is an agent participant.
    const sender = participant as { kind?: ParticipantKind } | undefined;
    if (topic !== CONTROL_TOPIC || sender?.kind !== ParticipantKind.AGENT) return;
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    const { type, recipientParticipantIdentity } = (message ?? {}) as Record<string, unknown>;
    if (
      type !== BRIDGE_MUTED ||
      recipientParticipantIdentity !== this.room.localParticipant.identity
    ) {
      return;
    }
    this.takeOverConfirmed = true;
    this.confirmation?.(true);
  }

  private async settleJoin(join: JoinResult): Promise<void> {
    if (this.state.status !== 'connecting') {
      await this.closeRoom();
      return;
    }
    let publishFailure: unknown = null;
    let confirmed = false;
    if (join.ok && this.state.earlyDisconnect === null) {
      try {
        if (!this.microphone) throw new Error('no microphone track');
        await this.room.localParticipant.publishTrack(this.microphone, {
          source: Track.Source.Microphone,
          name: 'microphone',
        });
      } catch (cause) {
        publishFailure = cause;
      }
      if (
        publishFailure === null &&
        this.state.status === 'connecting' &&
        this.state.earlyDisconnect === null
      ) {
        confirmed = await this.waitForTakeOver(
          this.options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
        );
      }
    }
    // Read again: `handBack()` or a disconnect can land while the track
    // publishes.
    if (this.state.status !== 'connecting') {
      await this.closeRoom();
      return;
    }
    const { earlyDisconnect } = this.state;
    if (earlyDisconnect && CALL_OVER_REASONS.has(earlyDisconnect.reason)) {
      await this.finish({ status: 'ended', reason: 'call_ended' });
      return;
    }
    // A microphone that stopped before the take-over was confirmed leaves the
    // caller hearing nobody: leave, and the agent keeps the call.
    if (this.microphoneLost && publishFailure === null) {
      publishFailure = new Error('the microphone stopped before the take-over was confirmed');
    }
    if (join.ok && !earlyDisconnect && publishFailure === null && confirmed) {
      this.setState({ status: 'live' });
      return;
    }
    const error =
      !join.ok || earlyDisconnect
        ? new SpekoClientError(
            'Failed to connect to the call',
            'CONNECTION_FAILED',
            join.ok ? reasonName(earlyDisconnect?.reason) : join.cause,
          )
        : publishFailure !== null
          ? new SpekoClientError(
              'Failed to acquire microphone',
              'MICROPHONE_FAILED',
              publishFailure,
            )
          : new SpekoClientError(
              'Speko did not confirm the take-over; the agent keeps the call',
              'TAKE_OVER_FAILED',
            );
    void this.terminate({ status: 'failed', error });
    throw error;
  }

  private bindRoomEvents(): void {
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio || !this.isOnCall()) return;
      this.playback.attach(track as RemoteAudioTrack);
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      this.playback.detach(track as RemoteAudioTrack);
    });
    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      if (isTerminal(this.state)) return;
      this.setSpeakers(this.rolesOf(speakers));
    });
    this.room.on(RoomEvent.AudioPlaybackStatusChanged, () => this.reportIfBlocked());
    this.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: unknown, _kind?: unknown, topic?: string) =>
        this.onControlData(payload, participant, topic),
    );
    this.room.on(RoomEvent.MediaDevicesError, (cause: Error) => {
      if (this.state.status !== 'live') return;
      this.options.onError?.(
        new SpekoClientError('Microphone device error', 'MICROPHONE_FAILED', cause),
      );
    });
    // A join that livekit-client retries can connect after the take-over is
    // over. Nothing else would close that connection.
    for (const event of [RoomEvent.Connected, RoomEvent.Reconnected]) {
      this.room.on(event, () => {
        if (isTerminal(this.state)) void this.closeRoom();
      });
    }
    this.room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (isTerminal(this.state)) return;
      if (this.state.status === 'connecting') {
        this.state = { status: 'connecting', earlyDisconnect: { reason } };
        this.playback.clear();
        this.confirmation?.(false);
        return;
      }
      if (reason === DisconnectReason.CLIENT_INITIATED) {
        void this.finish({ status: 'ended', reason: 'handed_back' });
      } else if (CALL_OVER_REASONS.has(reason)) {
        void this.finish({ status: 'ended', reason: 'call_ended' });
      } else {
        const error = new SpekoClientError(
          'Lost the connection to the call',
          'DISCONNECTED',
          reasonName(reason),
        );
        void this.finish({ status: 'failed', error });
      }
    });
  }

  private isOnCall(): boolean {
    if (this.state.status === 'connecting') return this.state.earlyDisconnect === null;
    return this.state.status === 'live';
  }

  private rolesOf(speakers: readonly Participant[]): readonly CallTakeoverSpeaker[] {
    const localIdentity = this.room.localParticipant.identity;
    const speaking = new Set<CallTakeoverSpeaker>();
    for (const speaker of speakers) {
      if (speaker.identity === localIdentity) speaking.add('you');
      else if (speaker.kind === ParticipantKind.AGENT) speaking.add('agent');
      else speaking.add('caller');
    }
    return ROLE_ORDER.filter((role) => speaking.has(role));
  }

  private reportOutputDeviceError(cause: unknown): void {
    if (this.outputDeviceFailed || isTerminal(this.state)) return;
    this.outputDeviceFailed = true;
    this.options.onOutputDeviceError?.(
      new Error('Could not play the call on the chosen output device', { cause }),
    );
  }

  private reportIfBlocked(): void {
    if (!this.room.canPlaybackAudio && !isTerminal(this.state)) {
      this.options.onAudioPlaybackBlocked?.();
    }
  }

  private finish(next: Terminal): Promise<void> {
    if (isTerminal(this.state)) return this.closeRoom();
    const closed = this.terminate(next);
    if (next.status === 'ended') {
      this.options.onEnded?.({ reason: next.reason });
    } else {
      this.options.onError?.(next.error);
    }
    return closed;
  }

  // The only way into a terminal state, so no terminal take-over keeps a room
  // or a microphone.
  private terminate(next: Terminal): Promise<void> {
    this.confirmation?.(false);
    const closed = this.closeRoom();
    this.microphone?.stop();
    this.playback.clear();
    this.setSpeakers([]);
    this.setState(next);
    return closed;
  }

  private closeRoom(): Promise<void> {
    return this.room.disconnect().catch(() => undefined);
  }

  private setState(next: State): void {
    this.state = next;
    this.options.onStatusChange?.(next.status);
  }

  private setSpeakers(next: readonly CallTakeoverSpeaker[]): void {
    if (next.length === this.speakers.length && next.every((role, i) => role === this.speakers[i]))
      return;
    this.speakers = next;
    this.options.onSpeakersChange?.(next);
  }
}

function isTerminal(state: State): state is Terminal {
  return state.status === 'ended' || state.status === 'failed';
}
