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

export interface ConversationOptions extends ConversationCallbacks {
  readonly conversationToken: string;
  /**
   * LiveKit WebSocket URL returned from `POST /v1/sessions`. Pass the value
   * straight from the session response — the SDK does not default this so
   * consumers can't accidentally ship against staging.
   */
  readonly livekitUrl: string;
  readonly overrides?: ConversationOverrides;
  readonly inputDeviceId?: string;
  readonly outputDeviceId?: string;
  readonly audioConstraints?: AudioConstraints;
}

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
 * Options for the `agentId`-based form of `VoiceConversation.create`. The SDK
 * mints a session against `POST /v1/sessions` using the supplied API key, then
 * hands the resulting token + LiveKit URL to the same code path as the
 * lower-level form.
 *
 * Use this when your app authenticates with a Speko API key directly. Use
 * {@link ConversationOptions} when your backend is the one minting sessions
 * and forwarding `conversationToken` + `livekitUrl` to the browser.
 */
export interface AgentConversationOptions extends ConversationCallbacks {
  readonly agentId: string;
  readonly apiKey: string;
  /** Override the Speko API origin. Defaults to `https://api.speko.dev`. */
  readonly apiBaseUrl?: string;
  readonly overrides?: ConversationOverrides;
  readonly inputDeviceId?: string;
  readonly outputDeviceId?: string;
  readonly audioConstraints?: AudioConstraints;
}

/**
 * `VoiceConversation.create` accepts either form. The lower-level
 * `ConversationOptions` form (token + livekitUrl) is the primary API and is
 * recommended for production apps that mint sessions on a server. The
 * `AgentConversationOptions` form is a convenience for browser-only apps and
 * embedded widgets that hold a Speko API key directly.
 */
export type CreateOptions = ConversationOptions | AgentConversationOptions;
