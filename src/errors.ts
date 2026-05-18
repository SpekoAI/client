export type SpekoClientErrorCode =
  | 'CONNECTION_FAILED'
  | 'DISCONNECTED'
  | 'MICROPHONE_FAILED'
  | 'INVALID_MESSAGE'
  | 'NOT_CONNECTED'
  | 'SESSION_REQUEST_FAILED';

export class SpekoClientError extends Error {
  readonly code: SpekoClientErrorCode;
  override readonly cause: unknown;
  /**
   * HTTP status code, when the error originated from a Speko API response.
   * Undefined for network or local failures.
   */
  readonly status?: number;

  constructor(message: string, code: SpekoClientErrorCode, cause?: unknown, status?: number) {
    super(message);
    this.name = 'SpekoClientError';
    this.code = code;
    this.cause = cause;
    if (status !== undefined) this.status = status;
  }
}
