import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('VoiceConversation.create', () => {
  beforeEach(() => {
    connectMock.mockClear();
    constructorSpy.mockClear();
  });

  it('connects directly when given conversationToken + livekitUrl', async () => {
    const conv = await VoiceConversation.create({
      conversationToken: 'tok_legacy',
      livekitUrl: 'wss://lk.example',
    });

    expect(conv.getId()).toBe('conv_xyz');
    expect(conv.isOpen()).toBe(true);

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

  it('connects directly when given transportToken + transportUrl', async () => {
    const conv = await VoiceConversation.create({
      transportToken: 'tok_transport',
      transportUrl: 'wss://transport.example',
    });

    expect(conv.getId()).toBe('conv_xyz');
    expect(connectMock).toHaveBeenCalledTimes(1);

    const init = firstConstructorArg() as {
      conversationToken: string;
      livekitUrl: string;
    };
    expect(init.conversationToken).toBe('tok_transport');
    expect(init.livekitUrl).toBe('wss://transport.example');
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
