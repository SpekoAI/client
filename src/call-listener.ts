import {
  DisconnectReason,
  type Participant,
  ParticipantKind,
  type RemoteAudioTrack,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import { SpekoClientError } from './errors.js';
import { RemoteAudioPlayback } from './remote-audio.js';

/**
 * `connecting` then `listening`, then one of two terminal states: `ended`
 * (the call is over, or you stopped listening) or `failed` (the connection
 * was lost). A call that ends during the join goes from `connecting` to
 * `ended`. A listener never leaves a terminal state. To listen again, mint
 * a new token and connect a new listener.
 */
export type CallListenerStatus = 'connecting' | 'listening' | 'ended' | 'failed';

export interface CallListenerEndDetails {
  /** `call_ended`: the call is over. `stopped`: your code called `disconnect()`. */
  readonly reason: 'call_ended' | 'stopped';
}

/** `agent` is the AI. `caller` is any person on the call, a transfer recipient included. */
export type CallSpeakerRole = 'agent' | 'caller';

export interface CallListenerOptions {
  /** `url` from `speko.calls.listen(callId)`. */
  readonly url: string;
  /** `token` from `speko.calls.listen(callId)`. Mint one per connect. */
  readonly token: string;
  /** Playback volume from 0 to 1. Default 1. */
  readonly volume?: number;
  /**
   * Output device id from `navigator.mediaDevices.enumerateDevices()`. The
   * call is audible on this device only. A track makes no sound until the
   * browser has routed it there, and it stays silent if the browser cannot.
   * See `onOutputDeviceError`.
   */
  readonly outputDeviceId?: string;
  onStatusChange?: (status: CallListenerStatus) => void;
  /** The listener reached `ended`. */
  onEnded?: (details: CallListenerEndDetails) => void;
  /** The listener reached `failed` after it was listening. `error.code` is `DISCONNECTED`. */
  onError?: (error: SpekoClientError) => void;
  /**
   * Who is speaking now. An empty array means silence. On a call between two
   * AI agents both sides report `agent`, so the array cannot tell them apart.
   */
  onSpeakersChange?: (speakers: readonly CallSpeakerRole[]) => void;
  /**
   * The browser blocked audio playback, so the user hears nothing. Show a
   * button and call `startAudio()` from its click handler.
   */
  onAudioPlaybackBlocked?: () => void;
  /**
   * The browser could not play the call on `outputDeviceId`, so the user
   * hears nothing. The listener stays connected and never falls back to the
   * default device. Called at most once. To recover, disconnect and connect
   * a new listener with another device, or with none.
   */
  onOutputDeviceError?: (error: Error) => void;
}

type Terminal =
  | { readonly status: 'ended'; readonly reason: CallListenerEndDetails['reason'] }
  | { readonly status: 'failed'; readonly error: SpekoClientError };

// A disconnect that arrives before the join settles is part of `connecting`.
// It decides what `connect()` returns, whichever way the join itself settles.
type Connecting = {
  readonly status: 'connecting';
  readonly earlyDisconnect: { readonly reason: DisconnectReason | undefined } | null;
};

type State = Connecting | { readonly status: 'listening' } | Terminal;

type JoinResult = { readonly ok: true } | { readonly ok: false; readonly cause: unknown };

// The server removes every listener when the call is over, so these reasons
// are the "call ended" signal. Any other reason means the connection broke.
const CALL_OVER_REASONS: ReadonlySet<DisconnectReason | undefined> = new Set([
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.ROOM_CLOSED,
]);

const ROLE_BY_KIND: ReadonlyMap<ParticipantKind, CallSpeakerRole> = new Map([
  [ParticipantKind.AGENT, 'agent'],
  [ParticipantKind.SIP, 'caller'],
  [ParticipantKind.STANDARD, 'caller'],
]);

const ROLE_ORDER: readonly CallSpeakerRole[] = ['agent', 'caller'];

/**
 * Plays a live call's audio in the browser, receive-only. It never asks for
 * the microphone and never publishes audio or data.
 */
export class CallListener {
  private readonly room = new Room();
  private readonly playback: RemoteAudioPlayback;
  private state: State = { status: 'connecting', earlyDisconnect: null };
  private speakers: readonly CallSpeakerRole[] = [];
  private outputDeviceFailed = false;

  private constructor(private readonly options: CallListenerOptions) {
    this.playback = new RemoteAudioPlayback({
      outputDeviceId: options.outputDeviceId,
      // A listener hears a private call, so it must not reach a device the
      // user did not choose.
      outputDeviceRouting: 'required',
      onPlaybackRejected: () => this.reportIfBlocked(),
      onOutputDeviceError: (cause) => this.reportOutputDeviceError(cause),
    });
    if (options.volume !== undefined) this.playback.setVolume(options.volume);
    this.bindRoomEvents();
  }

  /**
   * Join the call and start playback. Rejects with a `SpekoClientError` whose
   * `code` is `CONNECTION_FAILED` when the join fails, for example because
   * the token expired.
   *
   * If the call ends while the join is in progress, or the server turns the
   * listener away, `connect()` resolves to a listener whose status is already
   * `ended`, after `onEnded` fired with `call_ended`. Read `status` before
   * you show a listening state.
   */
  static async connect(options: CallListenerOptions): Promise<CallListener> {
    const listener = new CallListener(options);
    options.onStatusChange?.('connecting');
    const join = await listener.room
      .connect(options.url, options.token, { autoSubscribe: true })
      .then(
        (): JoinResult => ({ ok: true }),
        (cause: unknown): JoinResult => ({ ok: false, cause }),
      );
    listener.settleJoin(join);
    return listener;
  }

  get status(): CallListenerStatus {
    return this.state.status;
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

  /** Stop listening. Safe to call more than once and after the call ended. */
  async disconnect(): Promise<void> {
    await this.finish({ status: 'ended', reason: 'stopped' });
  }

  private settleJoin(join: JoinResult): void {
    if (this.state.status !== 'connecting') {
      void this.closeRoom();
      return;
    }
    const { earlyDisconnect } = this.state;
    if (earlyDisconnect && CALL_OVER_REASONS.has(earlyDisconnect.reason)) {
      void this.finish({ status: 'ended', reason: 'call_ended' });
      return;
    }
    if (join.ok && !earlyDisconnect) {
      this.setState({ status: 'listening' });
      return;
    }
    const error = new SpekoClientError(
      'Failed to connect to the call',
      'CONNECTION_FAILED',
      join.ok ? reasonName(earlyDisconnect?.reason) : join.cause,
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
      this.setSpeakers(rolesOf(speakers));
    });
    this.room.on(RoomEvent.AudioPlaybackStatusChanged, () => this.reportIfBlocked());
    // A join that livekit-client retries can connect after this listener is
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
        return;
      }
      if (reason === DisconnectReason.CLIENT_INITIATED) {
        void this.finish({ status: 'ended', reason: 'stopped' });
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

  // livekit-client can retry a join after the server removed the listener, so
  // a room that disconnected during the join can still deliver tracks.
  private isOnCall(): boolean {
    if (this.state.status === 'connecting') return this.state.earlyDisconnect === null;
    return this.state.status === 'listening';
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

  // The only way into a terminal state, so no terminal listener keeps a room.
  private terminate(next: Terminal): Promise<void> {
    const closed = this.closeRoom();
    this.playback.clear();
    this.setSpeakers([]);
    this.setState(next);
    return closed;
  }

  // A retried join can connect the room after the listener is terminal, so
  // this runs on every terminal path, not only the first.
  private closeRoom(): Promise<void> {
    return this.room.disconnect().catch(() => undefined);
  }

  private setState(next: State): void {
    this.state = next;
    this.options.onStatusChange?.(next.status);
  }

  private setSpeakers(next: readonly CallSpeakerRole[]): void {
    if (next.length === this.speakers.length && next.every((role, i) => role === this.speakers[i]))
      return;
    this.speakers = next;
    this.options.onSpeakersChange?.(next);
  }
}

function isTerminal(state: State): state is Terminal {
  return state.status === 'ended' || state.status === 'failed';
}

function reasonName(reason: DisconnectReason | undefined): string | undefined {
  return reason === undefined ? undefined : DisconnectReason[reason];
}

function rolesOf(speakers: readonly Participant[]): readonly CallSpeakerRole[] {
  const speaking = new Set(speakers.map((speaker) => ROLE_BY_KIND.get(speaker.kind)));
  return ROLE_ORDER.filter((role) => speaking.has(role));
}
