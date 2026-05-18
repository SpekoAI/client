import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpekoClientError } from './errors.js';
import { requestSession } from './start-session.js';

const SUCCESS_BODY = {
  sessionId: 'sess_123',
  conversationToken: 'tok_abc',
  livekitUrl: 'wss://livekit.speko.dev',
  expiresAt: '2026-01-01T00:00:00.000Z',
  mode: 'cascade',
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('requestSession', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('POSTs to /v1/sessions with bearer auth and the agent id', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SUCCESS_BODY));

    const result = await requestSession({
      agentId: 'agent_a1b2c3',
      apiKey: 'sk_live_test',
    });

    // Server may include extra fields (mode, roomName, identity) that the
    // helper is permitted to pass through. Assert on the contract fields.
    expect(result).toMatchObject({
      sessionId: 'sess_123',
      conversationToken: 'tok_abc',
      livekitUrl: 'wss://livekit.speko.dev',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0];
    if (!firstCall) throw new Error('fetch was not called');
    const [calledUrl, init] = firstCall;
    expect(calledUrl).toBe('https://api.speko.dev/v1/sessions');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk_live_test');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['mode']).toBe('cascade');
    expect(body['agentId']).toBe('agent_a1b2c3');
    expect(body).not.toHaveProperty('intent');
  });

  it('honors apiBaseUrl override and trims trailing slashes', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SUCCESS_BODY));

    await requestSession({
      agentId: 'agent_x',
      apiKey: 'sk_test',
      apiBaseUrl: 'https://staging.speko.dev/',
    });

    const stagingCall = fetchSpy.mock.calls[0];
    if (!stagingCall) throw new Error('fetch was not called');
    expect(stagingCall[0]).toBe('https://staging.speko.dev/v1/sessions');
  });

  it('throws SpekoClientError with status=401 when the API rejects the key', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ error: 'Invalid API key', code: 'UNAUTHORIZED' }, { status: 401 }),
    );

    await expect(requestSession({ agentId: 'agent_x', apiKey: 'sk_bad' })).rejects.toMatchObject({
      name: 'SpekoClientError',
      code: 'SESSION_REQUEST_FAILED',
      status: 401,
      message: 'Invalid API key',
    });
  });

  it('throws SpekoClientError with status=404 when the agent is unknown', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'Agent not found' }, code: 'NOT_FOUND' }, { status: 404 }),
    );

    const err = await requestSession({
      agentId: 'agent_missing',
      apiKey: 'sk_live',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SpekoClientError);
    expect((err as SpekoClientError).status).toBe(404);
    expect((err as SpekoClientError).message).toBe('Agent not found');
    expect((err as SpekoClientError).code).toBe('SESSION_REQUEST_FAILED');
  });

  it('falls back to a generic message when the error body is unparseable', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('<html>500</html>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(requestSession({ agentId: 'agent_x', apiKey: 'sk_live' })).rejects.toMatchObject({
      code: 'SESSION_REQUEST_FAILED',
      status: 500,
      message: 'Speko API responded with HTTP 500',
    });
  });

  it('wraps network failures with SESSION_REQUEST_FAILED', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const err = await requestSession({
      agentId: 'agent_x',
      apiKey: 'sk_live',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SpekoClientError);
    expect((err as SpekoClientError).code).toBe('SESSION_REQUEST_FAILED');
    expect((err as SpekoClientError).status).toBeUndefined();
    expect((err as SpekoClientError).cause).toBeInstanceOf(TypeError);
  });

  it('rejects when the response is missing required fields', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ sessionId: 'sess_1' }), // no conversationToken/livekitUrl
    );

    await expect(requestSession({ agentId: 'agent_x', apiKey: 'sk_live' })).rejects.toMatchObject({
      code: 'SESSION_REQUEST_FAILED',
      message: 'Speko API response was missing conversationToken or livekitUrl',
    });
  });
});
