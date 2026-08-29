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

type Listener = (event: unknown) => void;

class FakeRTCDataChannel {
  readonly sent: string[] = [];
  readyState: RTCDataChannelState = 'open';
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 'closed';
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  readonly channel = new FakeRTCDataChannel();
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }

  addTrack(): void {}

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.connectionState = 'closed';
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: MediaStreamTrack[] = []) {}

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks;
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

  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate ?? 48_000;
    audioContexts.push(this);
  }

  createMediaStreamDestination() {
    return {
      stream: new FakeMediaStream([{ kind: 'audio' } as MediaStreamTrack]),
    };
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
      addEventListener: vi.fn(),
      onended: null as (() => void) | null,
    };
    this.sources.push(source);
    return source;
  }

  async close() {
    return undefined;
  }

  async resume() {
    return undefined;
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;
const originalUrl = globalThis.URL;
const originalRTCPeerConnection = globalThis.RTCPeerConnection;
const originalMediaStream = globalThis.MediaStream;

function installBrowserFakes() {
  FakeWebSocket.instances.length = 0;
  FakeRTCPeerConnection.instances.length = 0;
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
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: FakeRTCPeerConnection,
  });
  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    value: FakeMediaStream,
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

function directReservation() {
  return {
    id: 'reservation-1',
    authorizedDurationSeconds: 1800,
    leaseExpiresAt: '2100-01-01T00:05:00Z',
    billing: {
      mode: 'direct_entitlement' as const,
      state: 'estimated' as const,
      maximumAmountMicros: '180000',
      currency: 'USD',
    },
  };
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
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: originalRTCPeerConnection,
  });
  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    value: originalMediaStream,
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
    vi.useRealTimers();
    restoreBrowserGlobals();
    vi.unstubAllGlobals();
  });

  it('connects browser audio directly to OpenAI with only the delegated credential', async () => {
    Object.defineProperty(globalThis, 'URL', { configurable: true, value: originalUrl });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('answer-sdp', {
          status: 201,
          headers: { Location: '/v1/realtime/calls/call_12345678' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ bound: true }, { status: 202 }))
      .mockResolvedValue(Response.json({ accepted: 2, deduplicated: 0 }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = RealtimeVoiceConversation.create({
      transport: 'provider_direct',
      sessionId: 'sess_provider_direct',
      attemptId: 'att_provider_direct',
      provider: 'openai',
      model: 'gpt-realtime',
      adapter: 'openai.realtime.v1',
      providerTransport: 'webrtc',
      endpoint: 'https://api.openai.com/v1/realtime/calls',
      sidebandUrl: 'https://control.speko.test/v1/sessions/sess_provider_direct/sidebands/openai',
      credential: { kind: 'bearer', value: 'ek-short-lived', expiresAt: '2100-01-01T00:05:00Z' },
      telemetry: {
        endpoint: 'https://control.speko.test/v1/runtime-events',
        token: 'telemetry-token',
        flushIntervalMs: 5000,
      },
      reservation: directReservation(),
      session: { voice: 'marin', instructions: 'Answer briefly.' },
      inputSampleRate: 24000,
      outputSampleRate: 24000,
    });

    await vi.waitFor(() => expect(FakeRTCPeerConnection.instances).toHaveLength(1));
    const peer = FakeRTCPeerConnection.instances[0];
    if (!peer) throw new Error('expected WebRTC peer');
    peer.channel.emit('open', {});
    expect(JSON.parse(String(peer.channel.sent[0]))).toMatchObject({
      type: 'session.update',
      session: { instructions: 'Answer briefly.', audio: { output: { voice: 'marin' } } },
    });
    peer.channel.emit('message', { data: JSON.stringify({ type: 'session.updated' }) });
    const conversation = await pending;

    peer.channel.emit('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'hello',
      }),
    });
    await conversation.endSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/realtime/calls');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://control.speko.test/v1/sessions/sess_provider_direct/sidebands/openai',
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://control.speko.test/v1/runtime-events');
  });

  it('configures xAI caller transcription and reconciles cumulative updates', async () => {
    Object.defineProperty(globalThis, 'URL', { configurable: true, value: originalUrl });
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ accepted: 2, deduplicated: 0 }, { status: 202 })),
    );
    const pending = RealtimeVoiceConversation.create({
      transport: 'provider_direct',
      sessionId: 'sess_xai_direct',
      attemptId: 'att_xai_direct',
      provider: 'xai',
      model: 'grok-voice-latest',
      adapter: 'xai.realtime.v1',
      providerTransport: 'websocket',
      endpoint: 'wss://api.x.ai/v1/realtime',
      credential: { kind: 'bearer', value: 'xai-short-lived', expiresAt: '2100-01-01T00:05:00Z' },
      telemetry: {
        endpoint: 'https://control.speko.test/v1/runtime-events',
        token: 'telemetry-token',
        flushIntervalMs: 5000,
      },
      reservation: directReservation(),
      session: { voice: 'eve', instructions: 'Answer briefly.' },
      inputSampleRate: 24000,
      outputSampleRate: 24000,
    });

    expect(socket().url).toBe('wss://api.x.ai/v1/realtime?model=grok-voice-latest');
    expect(socket().protocols).toEqual(['xai-client-secret.xai-short-lived']);
    socket().emit('open', {});
    expect(JSON.parse(String(socket().sent[0]))).toMatchObject({
      type: 'session.update',
      session: {
        audio: { input: { transcription: { model: 'grok-transcribe' } } },
      },
    });
    socket().message(JSON.stringify({ type: 'session.updated' }));
    const conversation = await pending;

    for (const transcript of ['hello', 'hello world']) {
      socket().message(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.updated',
          item_id: 'item-1',
          transcript,
        }),
      );
    }
    socket().message(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        transcript: 'hello world',
      }),
    );

    expect(conversation.transcript).toEqual([
      { source: 'user', text: 'hello world', isFinal: true, segmentId: 'item-1' },
    ]);
    await conversation.endSession();
  });

  it('uses Google constrained Live directly with 16 kHz PCM input', async () => {
    Object.defineProperty(globalThis, 'URL', { configurable: true, value: originalUrl });
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ accepted: 2, deduplicated: 0 }, { status: 202 })),
    );
    const onMessage = vi.fn();
    const pending = RealtimeVoiceConversation.create({
      transport: 'provider_direct',
      sessionId: 'sess_google_direct',
      attemptId: 'att_google_direct',
      provider: 'google',
      model: 'gemini-3.1-flash-live-preview',
      adapter: 'google.live.v1',
      providerTransport: 'websocket',
      endpoint:
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
      credential: {
        kind: 'bearer',
        value: 'auth_tokens/google-one-use',
        expiresAt: '2100-01-01T00:05:00Z',
      },
      telemetry: {
        endpoint: 'https://control.speko.test/v1/runtime-events',
        token: 'telemetry-token',
        flushIntervalMs: 5000,
      },
      reservation: directReservation(),
      session: { voice: 'Puck', instructions: 'Answer briefly.', temperature: 0.7 },
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      onMessage,
    });

    expect(socket().url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fgoogle-one-use',
    );
    expect(socket().protocols).toBeUndefined();
    socket().emit('open', {});
    expect(JSON.parse(String(socket().sent[0]))).toMatchObject({
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 0.7,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        },
        systemInstruction: { parts: [{ text: 'Answer briefly.' }] },
      },
    });
    socket().message(JSON.stringify({ setupComplete: {} }));
    const conversation = await pending;
    socket().message(
      JSON.stringify({
        serverContent: {
          inputTranscription: { text: 'hello Gemini' },
          modelTurn: {
            parts: [{ inlineData: { data: 'AQIDBA==', mimeType: 'audio/pcm;rate=24000' } }],
          },
        },
      }),
    );
    expect(onMessage).toHaveBeenCalledWith({
      source: 'user',
      text: 'hello Gemini',
      isFinal: true,
    });

    const ctx = audioContexts[0];
    if (!ctx?.processor.onaudioprocess) throw new Error('audio processor was not installed');
    ctx.processor.onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array(960).fill(0.25) },
    });
    expect(JSON.parse(String(socket().sent[1]))).toMatchObject({
      realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000' } },
    });
    await conversation.endSession();
  });

  it('prepaids and rotates a Google Live entitlement with session resumption', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-28T12:00:00Z');
    vi.setSystemTime(now);
    Object.defineProperty(globalThis, 'URL', { configurable: true, value: originalUrl });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          entitlement_id: 'entitlement-2',
          sequence: 2,
          lease_expires_at: '2026-08-28T12:00:20Z',
          authorized_units: 10,
          maximum_amount_micros: 1_000,
          currency: 'USD',
          credential: {
            kind: 'bearer',
            value: 'auth_tokens/google-renewed',
            expires_at: '2026-08-28T12:00:20Z',
          },
        }),
      )
      .mockResolvedValue(Response.json({ accepted: 2 }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = RealtimeVoiceConversation.create({
      transport: 'provider_direct',
      sessionId: 'sess_google_renew',
      attemptId: 'att_google_renew',
      provider: 'google',
      model: 'gemini-3.1-flash-live-preview',
      adapter: 'google.live.v1',
      providerTransport: 'websocket',
      endpoint:
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
      credential: {
        kind: 'bearer',
        value: 'auth_tokens/google-first',
        expiresAt: '2026-08-28T12:00:10Z',
      },
      telemetry: {
        endpoint: 'https://control.speko.test/v1/runtime-events',
        token: 'telemetry-token',
        flushIntervalMs: 60_000,
      },
      reservation: {
        id: 'reservation-1',
        authorizedDurationSeconds: 10,
        leaseExpiresAt: '2026-08-28T12:00:10Z',
        billing: {
          mode: 'direct_entitlement',
          state: 'estimated',
          maximumAmountMicros: '1000',
          currency: 'USD',
          renewalUrl: 'https://control.speko.test/v1/sessions/sess_google_renew/entitlements/renew',
          renewableUntil: '2026-08-28T12:05:00Z',
        },
      },
      inputSampleRate: 16000,
      outputSampleRate: 24000,
    });
    const first = socket();
    first.emit('open', {});
    first.message(
      JSON.stringify({
        setupComplete: {},
        sessionResumptionUpdate: { newHandle: 'resume-handle' },
      }),
    );
    const conversation = await pending;

    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://control.speko.test/v1/sessions/sess_google_renew/entitlements/renew',
    );
    expect(FakeWebSocket.instances).toHaveLength(2);
    const renewed = FakeWebSocket.instances[1];
    if (!renewed) throw new Error('expected renewed Google socket');
    expect(renewed.url).toContain('access_token=auth_tokens%2Fgoogle-renewed');
    renewed.emit('open', {});
    expect(JSON.parse(String(renewed.sent[0]))).toMatchObject({
      setup: { sessionResumption: { handle: 'resume-handle' } },
    });
    await conversation.endSession();
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
