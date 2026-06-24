import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationCallbacks, ConversationMessage } from './types.js';

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
    sendChatText = vi.fn(async () => undefined);
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

/** Extract the callbacks object from the last constructed mock connection. */
function capturedCallbacks(): ConversationCallbacks {
  const init = firstConstructorArg() as { callbacks: ConversationCallbacks };
  return init.callbacks;
}

/** Fire the connection's onMessage (simulates incoming transcript). */
function fireMessage(msg: ConversationMessage): void {
  const cb = capturedCallbacks().onMessage;
  if (!cb) throw new Error('onMessage not registered on connection');
  cb(msg);
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
    // onMessage is always registered internally for transcript reconciliation.
    // Other callbacks (onConnect, onDisconnect, etc.) are omitted when not provided.
    expect(typeof init.callbacks['onMessage']).toBe('function');
    expect(init.callbacks['onConnect']).toBeUndefined();
    expect(init.callbacks['onDisconnect']).toBeUndefined();
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
    // onMessage is wrapped internally — the raw connection receives the wrapped
    // version, not the consumer's function directly.
    expect(typeof init.callbacks.onMessage).toBe('function');
  });
});

describe('VoiceConversation — onTranscript and transcript getter', () => {
  beforeEach(() => {
    connectMock.mockClear();
    constructorSpy.mockClear();
  });

  it('fires onTranscript with the full reconciled list after each message', async () => {
    const onMessage = vi.fn();
    const onTranscript = vi.fn();

    const conv = await VoiceConversation.create({
      conversationToken: 'tok',
      livekitUrl: 'wss://lk.example',
      onMessage,
      onTranscript,
    });

    const msg1: ConversationMessage = {
      source: 'agent',
      text: 'hello',
      isFinal: false,
      segmentId: 's1',
    };
    fireMessage(msg1);

    expect(onMessage).toHaveBeenCalledWith(msg1);
    expect(onTranscript).toHaveBeenCalledTimes(1);
    const firstList = onTranscript.mock.calls[0]?.[0] as readonly ConversationMessage[];
    expect(firstList).toHaveLength(1);
    expect(firstList[0]?.text).toBe('hello');

    // Second message: cumulative update of the same segment.
    const msg2: ConversationMessage = {
      source: 'agent',
      text: 'hello world',
      isFinal: true,
      segmentId: 's1',
    };
    fireMessage(msg2);

    expect(onTranscript).toHaveBeenCalledTimes(2);
    const secondList = onTranscript.mock.calls[1]?.[0] as readonly ConversationMessage[];
    // Segment updated in place — still one entry.
    expect(secondList).toHaveLength(1);
    expect(secondList[0]?.text).toBe('hello world');
    expect(secondList[0]?.isFinal).toBe(true);

    // transcript getter reflects the latest state.
    expect(conv.transcript).toHaveLength(1);
    expect(conv.transcript[0]?.text).toBe('hello world');
  });

  it('still calls onMessage even when onTranscript is not provided', async () => {
    const onMessage = vi.fn();

    await VoiceConversation.create({
      conversationToken: 'tok',
      livekitUrl: 'wss://lk.example',
      onMessage,
    });

    const msg: ConversationMessage = { source: 'user', text: 'hi', isFinal: true };
    fireMessage(msg);

    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it('transcript getter returns empty list before any messages', async () => {
    const conv = await VoiceConversation.create({
      conversationToken: 'tok',
      livekitUrl: 'wss://lk.example',
    });
    expect(conv.transcript).toEqual([]);
  });

  it('two different segments from two sources remain as separate entries', async () => {
    const onTranscript = vi.fn();

    const conv = await VoiceConversation.create({
      conversationToken: 'tok',
      livekitUrl: 'wss://lk.example',
      onTranscript,
    });

    fireMessage({ source: 'agent', text: 'agent text', isFinal: true, segmentId: 'a1' });
    fireMessage({ source: 'user', text: 'user text', isFinal: true, segmentId: 'u1' });

    expect(conv.transcript).toHaveLength(2);
  });
});
