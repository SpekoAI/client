export type SpekoClientErrorCode =
  | 'CONNECTION_FAILED'
  | 'DISCONNECTED'
  | 'MICROPHONE_FAILED'
  | 'INVALID_MESSAGE'
  | 'NOT_CONNECTED';

export class SpekoClientError extends Error {
  readonly code: SpekoClientErrorCode;
  override readonly cause: unknown;

  constructor(message: string, code: SpekoClientErrorCode, cause?: unknown) {
    super(message);
    this.name = 'SpekoClientError';
    this.code = code;
    this.cause = cause;
  }
}
