import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectMock = vi.fn(async () => 'conv_xyz');
const constructorSpy = vi.fn();

vi.mock('./webrtc-connection.js', () => {
  class MockWebRTCConnection {
    constructor(init: unknown) {
      constructorSpy(init);
    }
    connect = connectMock;
    getStatus = () => 'connected';
    disconnect = vi.fn(async () => undefined);
    setMicMuted = vi.fn(async () => undefined);
    setVolume = vi.fn();
    publish = vi.fn();
  }
  return { WebRTCConnection: MockWebRTCConnection };
});

const requestSessionMock = vi.fn();
vi.mock('./start-session.js', () => ({
  requestSession: requestSessionMock,
}));

// Import AFTER mocks register so the SUT picks up mocked modules.
const { VoiceConversation } = await import('./voice-conversation.js');

/**
 * Pulls the first arg of the most recent MockWebRTCConnection construction.
 * Helper exists so we can avoid `!` non-null assertions (lint rule) without
 * losing the inline narrowing each test wants.
 */
function firstConstructorArg(): unknown {
  const call = constructorSpy.mock.calls[0];
  if (!call) throw new Error('WebRTCConnection was not constructed');
  return call[0];
}

describe('VoiceConversation.create — token form (legacy)', () => {
  beforeEach(() => {
    connectMock.mockClear();
    constructorSpy.mockClear();
    requestSessionMock.mockReset();
  });

  it('connects directly when given conversationToken + livekitUrl', async () => {
    const conv = await VoiceConversation.create({
      conversationToken: 'tok_legacy',
      livekitUrl: 'wss://lk.example',
    });

    expect(conv.getId()).toBe('conv_xyz');
    expect(conv.isOpen()).toBe(true);

    expect(requestSessionMock).not.toHaveBeenCalled();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorSpy).toHaveBeenCalledTimes(1);

    const init = firstConstructorArg() as {
      conversationToken: string;
      livekitUrl: string;
      callbacks: Record<string, unknown>;
    };
    expect(init.conversationToken).toBe('tok_legacy');
    expect(init.livekitUrl).toBe('wss://lk.example');
    // No callbacks were provided; the callbacks object should be empty.
    expect(Object.keys(init.callbacks)).toHaveLength(0);
  });

  it('forwards overrides, audioConstraints, and callbacks to the connection', async () => {
    const onConnect = vi.fn();
    const onMessage = vi.fn();

    await VoiceConversation.create({
      conversationToken: 'tok_legacy',
      livekitUrl: 'wss://lk.example',
      overrides: { agent: { language: 'fr' } },
      audioConstraints: { echoCancellation: true },
      inputDeviceId: 'mic-1',
      onConnect,
      onMessage,
    });

    const init = firstConstructorArg() as {
      overrides?: { agent?: { language?: string } };
      audioConstraints?: { echoCancellation?: boolean };
      inputDeviceId?: string;
      callbacks: { onConnect?: unknown; onMessage?: unknown };
    };
    expect(init.overrides?.agent?.language).toBe('fr');
    expect(init.audioConstraints?.echoCancellation).toBe(true);
    expect(init.inputDeviceId).toBe('mic-1');
    expect(init.callbacks.onConnect).toBe(onConnect);
    expect(init.callbacks.onMessage).toBe(onMessage);
  });
});

describe('VoiceConversation.create — agent form', () => {
  beforeEach(() => {
    connectMock.mockClear();
    constructorSpy.mockClear();
    requestSessionMock.mockReset();
  });

  afterEach(() => {
    requestSessionMock.mockReset();
  });

  it('mints a session via requestSession then connects with the returned token', async () => {
    requestSessionMock.mockResolvedValueOnce({
      sessionId: 'sess_1',
      conversationToken: 'tok_minted',
      livekitUrl: 'wss://lk.minted',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    const conv = await VoiceConversation.create({
      agentId: 'agent_a1b2c3',
      apiKey: 'sk_live_test',
    });

    expect(conv.getId()).toBe('conv_xyz');
    expect(requestSessionMock).toHaveBeenCalledTimes(1);
    expect(requestSessionMock).toHaveBeenCalledWith({
      agentId: 'agent_a1b2c3',
      apiKey: 'sk_live_test',
    });

    const init = firstConstructorArg() as {
      conversationToken: string;
      livekitUrl: string;
    };
    expect(init.conversationToken).toBe('tok_minted');
    expect(init.livekitUrl).toBe('wss://lk.minted');
  });

  it('passes apiBaseUrl through when provided', async () => {
    requestSessionMock.mockResolvedValueOnce({
      sessionId: 'sess_2',
      conversationToken: 'tok_2',
      livekitUrl: 'wss://lk.2',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    await VoiceConversation.create({
      agentId: 'agent_x',
      apiKey: 'sk_test',
      apiBaseUrl: 'https://staging.speko.dev',
    });

    expect(requestSessionMock).toHaveBeenCalledWith({
      agentId: 'agent_x',
      apiKey: 'sk_test',
      apiBaseUrl: 'https://staging.speko.dev',
    });
  });

  it('forwards overrides and callbacks from the agent form to the connection', async () => {
    requestSessionMock.mockResolvedValueOnce({
      sessionId: 'sess_3',
      conversationToken: 'tok_3',
      livekitUrl: 'wss://lk.3',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    const onError = vi.fn();
    await VoiceConversation.create({
      agentId: 'agent_x',
      apiKey: 'sk_test',
      overrides: { tts: { voiceId: 'voice-1', speed: 1.1 } },
      onError,
    });

    const init = firstConstructorArg() as {
      overrides?: { tts?: { voiceId?: string } };
      callbacks: { onError?: unknown };
    };
    expect(init.overrides?.tts?.voiceId).toBe('voice-1');
    expect(init.callbacks.onError).toBe(onError);
  });

  it('propagates errors thrown by requestSession without opening a connection', async () => {
    const failure = new Error('boom');
    requestSessionMock.mockRejectedValueOnce(failure);

    await expect(
      VoiceConversation.create({
        agentId: 'agent_x',
        apiKey: 'sk_bad',
      }),
    ).rejects.toBe(failure);

    expect(connectMock).not.toHaveBeenCalled();
    expect(constructorSpy).not.toHaveBeenCalled();
  });
});
