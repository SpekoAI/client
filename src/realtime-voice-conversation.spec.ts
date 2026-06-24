import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeVoiceConversation } from './realtime-voice-conversation.js';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  binaryType = '';
  readyState = FakeWebSocket.OPEN;
  sent: unknown[] = [];
  readonly listeners = new Map<string, Array<(evt: unknown) => void>>();

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (evt: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(cb);
    this.listeners.set(type, existing);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  emit(type: string, evt: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(evt);
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }
}

interface FakeAudioContextInstance {
  sampleRate: number;
  currentTime: number;
  destination: object;
  processor: {
    onaudioprocess: ((evt: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
  };
  sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>;
}

const audioContexts: FakeAudioContextInstance[] = [];

class FakeAudioContext {
  sampleRate = 48_000;
  currentTime = 1;
  destination = {};
  processor: FakeAudioContextInstance['processor'] = { onaudioprocess: null };
  sources: FakeAudioContextInstance['sources'] = [];

  constructor() {
    audioContexts.push(this);
  }

  createGain() {
    return {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createScriptProcessor() {
    const holder = this.processor;
    return {
      get onaudioprocess():
        | ((evt: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
        | null {
        return holder.onaudioprocess;
      },
      set onaudioprocess(cb:
        | ((evt: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
        | null,) {
        holder.onaudioprocess = cb;
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => data,
    };
  }

  createBufferSource() {
    const source = {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    this.sources.push(source);
    return source;
  }

  async close() {
    return undefined;
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;
const originalUrl = globalThis.URL;

function installBrowserFakes() {
  FakeWebSocket.instances.length = 0;
  audioContexts.length = 0;
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: FakeAudioContext },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [{ enabled: true }],
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    },
  });
  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    value: {
      ...originalUrl,
      createObjectURL: vi.fn(() => 'blob:worklet'),
      revokeObjectURL: vi.fn(),
    },
  });
}

function restoreBrowserGlobals() {
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: originalWebSocket,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: originalNavigator,
  });
  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    value: originalUrl,
  });
}

function socket(): FakeWebSocket {
  const ws = FakeWebSocket.instances[0];
  if (!ws) throw new Error('expected websocket');
  return ws;
}

describe('RealtimeVoiceConversation', () => {
  beforeEach(() => {
    installBrowserFakes();
  });

  afterEach(() => {
    restoreBrowserGlobals();
  });

  it('waits for ready before starting capture and sends PCM frames at the negotiated input rate', async () => {
    const onConnect = vi.fn();
    const onStatusChange = vi.fn();
    const pending = RealtimeVoiceConversation.create({
      sessionId: 'sess_direct',
      wsUrl: 'ws://localhost/v1/realtime/sess_direct/ws',
      wsToken: 'token',
      onConnect,
      onStatusChange,
    });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(socket().url).toBe('ws://localhost/v1/realtime/sess_direct/ws');
    expect(socket().protocols).toEqual(['token']);

    socket().message(
      JSON.stringify({ t: 'ready', inputSampleRate: 16000, outputSampleRate: 24000 }),
    );
    const conversation = await pending;

    expect(conversation.isOpen()).toBe(true);
    expect(onConnect).toHaveBeenCalledWith({ conversationId: 'sess_direct' });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      }),
    });

    const ctx = audioContexts[0];
    if (!ctx?.processor.onaudioprocess) throw new Error('expected script processor');
    ctx.processor.onaudioprocess({
      inputBuffer: {
        getChannelData: () => new Float32Array(2048).fill(0.5),
      },
    });

    expect(socket().sent.some((payload) => payload instanceof ArrayBuffer)).toBe(true);
    expect(onStatusChange).toHaveBeenCalledWith('connected');

    await conversation.endSession();
  });

  it('queues playback, clears it on interruption, and surfaces transcripts/errors', async () => {
    const onModeChange = vi.fn();
    const onMessage = vi.fn();
    const onError = vi.fn();
    const pending = RealtimeVoiceConversation.create({
      sessionId: 'sess_direct',
      wsUrl: 'ws://localhost/v1/realtime/sess_direct/ws',
      wsToken: 'token',
      onModeChange,
      onMessage,
      onError,
    });
    socket().message(
      JSON.stringify({ t: 'ready', inputSampleRate: 24000, outputSampleRate: 24000 }),
    );
    const conversation = await pending;

    const pcm = new Int16Array([0, 8192, -8192]).buffer;
    socket().message(pcm);
    const ctx = audioContexts[0];
    const source = ctx?.sources[0];
    expect(source?.start).toHaveBeenCalled();
    expect(onModeChange).toHaveBeenCalledWith('speaking');

    socket().message(JSON.stringify({ t: 'interruption', at: 'user' }));
    expect(source?.stop).toHaveBeenCalled();
    expect(onModeChange).toHaveBeenCalledWith('listening');

    socket().message(
      JSON.stringify({
        t: 'transcript',
        role: 'user',
        text: 'hello',
        final: true,
      }),
    );
    expect(onMessage).toHaveBeenCalledWith({
      source: 'user',
      text: 'hello',
      isFinal: true,
    });

    socket().message(JSON.stringify({ t: 'error', code: 'BAD', message: 'broken' }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'BAD: broken' }));

    await conversation.endSession();
  });

  it('fires onTranscript with the reconciled list and transcript getter reflects it', async () => {
    const onMessage = vi.fn();
    const onTranscript = vi.fn();
    const pending = RealtimeVoiceConversation.create({
      sessionId: 'sess_transcript',
      wsUrl: 'ws://localhost/v1/realtime/sess_transcript/ws',
      wsToken: 'token',
      onMessage,
      onTranscript,
    });
    socket().message(
      JSON.stringify({ t: 'ready', inputSampleRate: 24000, outputSampleRate: 24000 }),
    );
    const conversation = await pending;

    // First transcript message (partial).
    socket().message(
      JSON.stringify({ t: 'transcript', role: 'agent', text: 'hello', final: false }),
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledTimes(1);
    const list1 = onTranscript.mock.calls[0]?.[0] as readonly { text: string }[];
    expect(list1).toHaveLength(1);
    expect(list1[0]?.text).toBe('hello');

    // Second transcript message (same source, no segmentId — legacy coalesce
    // replaces last same-source non-final entry).
    socket().message(
      JSON.stringify({ t: 'transcript', role: 'agent', text: 'hello world', final: true }),
    );

    expect(onTranscript).toHaveBeenCalledTimes(2);
    const list2 = onTranscript.mock.calls[1]?.[0] as readonly { text: string; isFinal: boolean }[];
    expect(list2).toHaveLength(1);
    expect(list2[0]?.text).toBe('hello world');
    expect(list2[0]?.isFinal).toBe(true);

    // transcript getter reflects the latest state.
    expect(conversation.transcript).toHaveLength(1);
    expect(conversation.transcript[0]?.text).toBe('hello world');

    await conversation.endSession();
  });

  it('transcript getter starts empty', async () => {
    const pending = RealtimeVoiceConversation.create({
      sessionId: 'sess_empty',
      wsUrl: 'ws://localhost/v1/realtime/sess_empty/ws',
      wsToken: 'token',
    });
    socket().message(
      JSON.stringify({ t: 'ready', inputSampleRate: 24000, outputSampleRate: 24000 }),
    );
    const conversation = await pending;
    expect(conversation.transcript).toEqual([]);
    await conversation.endSession();
  });

  it('uses provider error frames as the startup rejection when the socket closes before ready', async () => {
    const onError = vi.fn();
    const pending = RealtimeVoiceConversation.create({
      sessionId: 'sess_direct',
      wsUrl: 'ws://localhost/v1/realtime/sess_direct/ws',
      wsToken: 'token',
      onError,
    });

    socket().message(
      JSON.stringify({
        t: 'error',
        code: 'S2S_PROVIDER_CONNECT_FAILED',
        message: 'openai-realtime: invalid model',
      }),
    );
    socket().close(1011, 'Provider connect failed');

    await expect(pending).rejects.toThrow(
      'S2S_PROVIDER_CONNECT_FAILED: openai-realtime: invalid model',
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'S2S_PROVIDER_CONNECT_FAILED: openai-realtime: invalid model',
      }),
    );
  });
});
