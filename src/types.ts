export type ConversationStatus = 'connecting' | 'connected' | 'disconnecting' | 'disconnected';

export type ConversationMode = 'listening' | 'speaking';

export type DisconnectionReason = 'user' | 'agent' | 'error' | 'timeout' | 'unknown';

export interface DisconnectionDetails {
  readonly reason: DisconnectionReason;
  readonly message?: string;
}

export type MessageSource = 'agent' | 'user';

export interface ConversationMessage {
  readonly source: MessageSource;
  readonly text: string;
  readonly isFinal: boolean;
  /**
   * Stable id of the underlying transcription segment, when the transport
   * provides one (LiveKit transcriptions do). Segment updates are
   * CUMULATIVE: the same id is re-delivered with growing `text` (the
   * agent's transcript streams word-by-word; the user's re-publishes the
   * full utterance per recognizer update, including a duplicate of the
   * final). Renderers must upsert by `(source, segmentId)` — appending
   * every message produces duplicated, interleaved bubbles. Absent for
   * custom data-channel packets, which carry no segment identity.
   */
  readonly segmentId?: string;
  /**
   * Wall-clock time (ms epoch) the transport first received this segment.
   * STABLE across the cumulative re-deliveries of a given `segmentId`, so it
   * marks when the utterance *began*. Renderers should order bubbles by this
   * rather than by message-arrival order: user and agent transcripts stream
   * on separate paths with different latencies, so arrival order interleaves
   * wrong when speech overlaps (a backchannel during the agent's turn lands
   * above the agent's bubble). Absent for transports without segment timing.
   */
  readonly startedAt?: number;
}

export interface AgentOverrides {
  readonly prompt?: string;
  readonly firstMessage?: string;
  readonly language?: string;
}

export interface TtsOverrides {
  readonly voiceId?: string;
  readonly speed?: number;
}

/**
 * INERT — nothing reads these today. Kept because whether a browser may
 * override agent config at all is an open product question, not because the
 * path works. Two independent breaks, either one sufficient:
 *
 *  1. Topic mismatch. `WebRTCConnection.publish` calls `publishData` with no
 *     topic, so the packet arrives with `topic == None`. worker-py's only
 *     data-channel handler (`agent.py` `_on_control_data`) routes through
 *     `parse_control_message`, which returns `None` for any topic that is not
 *     `speko.control` — asserted by `tests/test_bridge_etiquette.py`
 *     `test_ignores_other_topics`, which pins the `None`-topic case.
 *  2. Type mismatch. Even on `speko.control` the handler dispatches only
 *     `transfer_completed` and `credits_exhausted`. There is no `overrides`
 *     branch to reach.
 *
 * Per-session agent config that DOES take effect is set server-side on
 * `POST /v1/sessions` (`variables`, compiled into the prompt at mint), which
 * has the additional property of not being forgeable by page JavaScript.
 * Making these overrides live means picking a topic, publishing on it from
 * `publish()`, and adding a dispatch branch in worker-py — all three.
 */
export interface ConversationOverrides {
  readonly agent?: AgentOverrides;
  readonly tts?: TtsOverrides;
}

export interface AudioConstraints {
  readonly echoCancellation?: boolean;
  readonly noiseSuppression?: boolean;
  readonly autoGainControl?: boolean;
}

export interface ConversationCallbacks {
  onConnect?: (details: { conversationId: string }) => void;
  onDisconnect?: (details: DisconnectionDetails) => void;
  onMessage?: (message: ConversationMessage) => void;
  onStatusChange?: (status: ConversationStatus) => void;
  onModeChange?: (mode: ConversationMode) => void;
  onError?: (error: Error) => void;
  /** Fires when the browser blocks the agent's audio from auto-playing (autoplay
   * policy / no fresh user gesture) — the agent is producing audio but the user
   * hears NOTHING and no error is thrown. Show a tap-to-unmute affordance and
   * call `startAudioPlayback()` from the resulting user-gesture handler to recover. */
  onAudioPlaybackBlocked?: () => void;
  /** Emits the FULL reconciled transcript (deduped, coalesced, ordered) on every update.
   * Prefer this over onMessage for rendering — the SDK owns reconciliation so consumers
   * never reimplement upsert-by-(source,segmentId). */
  onTranscript?: (transcript: readonly ConversationMessage[]) => void;
}

export interface ConversationCommonOptions extends ConversationCallbacks {
  readonly overrides?: ConversationOverrides;
  readonly inputDeviceId?: string;
  readonly outputDeviceId?: string;
  readonly audioConstraints?: AudioConstraints;
  /**
   * Publish the local microphone into the session (default true). Set false
   * for a text-only conversation: the room connects and the agent's audio
   * plays, but no microphone is requested or published — no permission
   * prompt, no MICROPHONE_FAILED. Typed turns via `sendChatMessage` still
   * work, so this is the fallback when a visitor has no mic or denied it.
   */
  readonly micEnabled?: boolean;
}

export interface TransportConversationOptions extends ConversationCommonOptions {
  /** Media runtime returned by POST /v1/sessions. Omitted means LiveKit for compatibility. */
  readonly transport?: 'livekit' | 'daily';
  readonly transportToken: string;
  /**
   * Media transport URL returned from `POST /v1/sessions`. Pass the value
   * straight from the session response — the SDK does not default this so
   * consumers can't accidentally ship against the wrong environment.
   */
  readonly transportUrl: string;
  /** @deprecated Use `transportToken`. */
  readonly conversationToken?: string;
  /** @deprecated Use `transportUrl`. */
  readonly livekitUrl?: string;
}

export interface LegacyConversationOptions extends ConversationCommonOptions {
  readonly transport?: 'livekit';
  /** @deprecated Use `transportToken`. */
  readonly conversationToken: string;
  /**
   * @deprecated Use `transportUrl`.
   *
   * WebSocket URL returned from `POST /v1/sessions`. Pass the value
   * straight from the session response — the SDK does not default this so
   * consumers can't accidentally ship against the wrong environment.
   */
  readonly livekitUrl: string;
  readonly transportToken?: string;
  readonly transportUrl?: string;
}

export type ConversationOptions = TransportConversationOptions | LegacyConversationOptions;

export interface LegacyRealtimeConversationOptions extends ConversationCallbacks {
  readonly sessionId: string;
  readonly wsUrl: string;
  readonly wsToken: string;
  readonly expiresAt?: string;
  readonly inputSampleRate?: 16000 | 24000;
  readonly outputSampleRate?: 16000 | 24000;
  readonly inputDeviceId?: string;
  readonly audioConstraints?: AudioConstraints;
}

export interface ProviderDirectRealtimeConversationOptions extends ConversationCallbacks {
  readonly transport: 'provider_direct';
  readonly sessionId: string;
  readonly attemptId: string;
  readonly provider: 'openai' | 'xai' | 'google';
  readonly model: string;
  readonly adapter: 'openai.realtime.v1' | 'xai.realtime.v1' | 'google.live.v1';
  readonly providerTransport: 'websocket' | 'webrtc';
  readonly endpoint: string;
  readonly sidebandUrl?: string;
  readonly credential: {
    readonly kind: 'bearer';
    readonly value: string;
    readonly expiresAt: string;
  };
  readonly telemetry: {
    readonly endpoint: string;
    readonly token: string;
    readonly flushIntervalMs: number;
  };
  readonly reservation: {
    readonly id: string;
    readonly authorizedDurationSeconds: number;
    readonly leaseExpiresAt: string;
    readonly billing: {
      readonly mode: 'direct_entitlement';
      readonly state: 'estimated';
      readonly maximumAmountMicros: string;
      readonly currency: string;
      readonly renewalUrl?: string;
      readonly renewableUntil?: string;
    };
  };
  readonly session?: {
    readonly voice?: string;
    readonly instructions?: string;
    readonly temperature?: number;
    /**
     * Gemini Live only: `generationConfig.thinkingConfig.thinkingLevel`. The
     * server sends it only for a model that REQUIRES one (and never for a
     * model that refuses one) — both mistakes close the socket 1007 before a
     * word is spoken — so this is forwarded as given, not decided here.
     */
    readonly thinkingLevel?: 'low' | 'medium' | 'high';
  };
  readonly expiresAt?: string;
  readonly inputSampleRate?: 16000 | 24000;
  readonly outputSampleRate?: 24000;
  readonly inputDeviceId?: string;
  readonly audioConstraints?: AudioConstraints;
}

export type RealtimeConversationOptions =
  | LegacyRealtimeConversationOptions
  | ProviderDirectRealtimeConversationOptions;

/**
 * `VoiceConversation.create` accepts short-lived session credentials minted by
 * your backend. Do not pass long-lived Speko API keys to browser code.
 */
export type CreateOptions = ConversationOptions;
