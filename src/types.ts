export type ConversationStatus =
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected';

export type ConversationMode = 'listening' | 'speaking';

export type DisconnectionReason =
  | 'user'
  | 'agent'
  | 'error'
  | 'timeout'
  | 'unknown';

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
