import { SpekoClientError } from './errors.js';

/**
 * Default Speko API origin used when callers do not pass `apiBaseUrl`. Lives
 * here (rather than in voice-conversation.ts) so any future helper that hits
 * the public API picks up the same default.
 */
const DEFAULT_API_BASE_URL = 'https://api.speko.dev';

export interface RequestSessionParams {
  /** Persistent agent id returned from `POST /v1/agents`. */
  readonly agentId: string;
  /** Speko API key (sk_...) — sent as `Authorization: Bearer ...`. */
  readonly apiKey: string;
  /**
   * Override the API origin. Defaults to `https://api.speko.dev`. Useful for
   * staging, local dev, or self-hosted deployments.
   */
  readonly apiBaseUrl?: string;
}

export interface RequestSessionResult {
  readonly sessionId: string;
  readonly conversationToken: string;
  readonly livekitUrl: string;
  readonly expiresAt: string;
}

/**
 * Hit `POST /v1/sessions` to mint a conversation token and LiveKit URL for
 * a persistent agent. Used internally by `VoiceConversation.create({ agentId })`
 * so browser apps don't need their own backend just to forward the call.
 *
 * Errors are thrown as `SpekoClientError` with code `SESSION_REQUEST_FAILED`
 * and the HTTP `status` attached for caller-side branching (401, 404, ...).
 */
export async function requestSession(params: RequestSessionParams): Promise<RequestSessionResult> {
  const baseUrl = (params.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/v1/sessions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        mode: 'cascade',
        agentId: params.agentId,
      }),
    });
  } catch (cause) {
    throw new SpekoClientError(
      `Failed to reach Speko API at ${url}`,
      'SESSION_REQUEST_FAILED',
      cause,
    );
  }

  if (!response.ok) {
    const { message } = await readErrorBody(response);
    throw new SpekoClientError(
      message ?? `Speko API responded with HTTP ${response.status}`,
      'SESSION_REQUEST_FAILED',
      undefined,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new SpekoClientError(
      'Speko API returned a non-JSON response',
      'SESSION_REQUEST_FAILED',
      cause,
      response.status,
    );
  }

  if (!isSessionResponse(body)) {
    throw new SpekoClientError(
      'Speko API response was missing conversationToken or livekitUrl',
      'SESSION_REQUEST_FAILED',
      body,
      response.status,
    );
  }

  return body;
}

interface ErrorBody {
  readonly message?: string;
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const parsed = (await response.json()) as Record<string, unknown>;
    const error = parsed['error'];
    if (typeof error === 'string') return { message: error };
    if (error && typeof error === 'object') {
      const m = (error as { message?: unknown }).message;
      if (typeof m === 'string') return { message: m };
    }
    const message = parsed['message'];
    if (typeof message === 'string') return { message };
    return {};
  } catch {
    return {};
  }
}

function isSessionResponse(value: unknown): value is RequestSessionResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['sessionId'] === 'string' &&
    typeof v['conversationToken'] === 'string' &&
    typeof v['livekitUrl'] === 'string' &&
    typeof v['expiresAt'] === 'string'
  );
}
