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
}

export interface ConversationCommonOptions extends ConversationCallbacks {
  readonly overrides?: ConversationOverrides;
  readonly inputDeviceId?: string;
  readonly outputDeviceId?: string;
  readonly audioConstraints?: AudioConstraints;
}

export interface TransportConversationOptions extends ConversationCommonOptions {
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

export interface RealtimeConversationOptions extends ConversationCallbacks {
  readonly sessionId: string;
  readonly wsUrl: string;
  readonly wsToken: string;
  readonly expiresAt?: string;
  readonly inputSampleRate?: 16000 | 24000;
  readonly outputSampleRate?: 16000 | 24000;
  readonly inputDeviceId?: string;
  readonly audioConstraints?: AudioConstraints;
}

/**
 * `VoiceConversation.create` accepts short-lived session credentials minted by
 * your backend. Do not pass long-lived Speko API keys to browser code.
 */
export type CreateOptions = ConversationOptions;
