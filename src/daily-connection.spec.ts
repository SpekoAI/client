import type { PipecatClientOptions, TranscriptData } from '@pipecat-ai/client-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileTranscript } from './transcript.js';
import type { ConversationMessage } from './types.js';

const clients: FakePipecatClient[] = [];

class FakePipecatClient {
  initDevices = vi.fn(async () => undefined);
  connect = vi.fn(() => new Promise<void>(() => undefined));
  disconnect = vi.fn(async () => undefined);
  updateMic = vi.fn();
  updateSpeaker = vi.fn();
  enableMic = vi.fn();
  sendClientMessage = vi.fn();
  sendText = vi.fn(async () => undefined);

  constructor(readonly options: PipecatClientOptions) {
    clients.push(this);
  }
}

vi.mock('@pipecat-ai/client-js', () => ({ PipecatClient: FakePipecatClient }));
vi.mock('@pipecat-ai/daily-transport', () => ({
  DailyTransport: class {
    getSessionInfo() {
      return { id: 'daily-room-id' };
    }
  },
}));

const { DailyConnection } = await import('./daily-connection.js');

describe('DailyConnection', () => {
  beforeEach(() => {
    clients.length = 0;
    vi.useRealTimers();
  });

  it('disconnects and reports a timeout when the bot-ready handshake never arrives', async () => {
    vi.useFakeTimers();
    const connection = new DailyConnection({
      token: 'token',
      url: 'https://daily.example/room',
      connectTimeoutMs: 1_000,
      callbacks: {},
    });

    const connecting = connection.connect();
    const timedOut = expect(connecting).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1_000);

    await timedOut;
    expect(clients[0]?.disconnect).toHaveBeenCalledOnce();
    expect(connection.getStatus()).toBe('disconnected');
  });

  it('clears the timeout after the bot-ready handshake succeeds', async () => {
    vi.useFakeTimers();
    const connection = new DailyConnection({
      token: 'token',
      url: 'https://daily.example/room',
      connectTimeoutMs: 1_000,
      callbacks: {},
    });
    clients[0]?.connect.mockResolvedValue(undefined);

    await expect(connection.connect()).resolves.toBe('daily-room-id');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(clients[0]?.disconnect).not.toHaveBeenCalled();
    expect(connection.getStatus()).toBe('connected');
  });
});

describe('DailyConnection transcripts', () => {
  function transcriptSink() {
    let messages: ConversationMessage[] = [];
    const updates: ConversationMessage[] = [];
    new DailyConnection({
      token: 'token',
      url: 'https://daily.example/room',
      callbacks: {
        onMessage(message) {
          updates.push(message);
          messages = reconcileTranscript(messages, message);
        },
      },
    });
    const client = clients[clients.length - 1];
    if (!client) throw new Error('Expected a Pipecat client');
    return {
      emit: (data: TranscriptData) => client.options.callbacks?.onUserTranscript?.(data),
      messages: () => messages,
      updates,
    };
  }

  it('replaces cumulative partials even when each frame has a new timestamp', () => {
    const sink = transcriptSink();
    for (const [index, text] of ['Hello', 'Hello there', 'Hello there!'].entries()) {
      sink.emit({
        text,
        user_id: 'caller',
        timestamp: `2026-09-17T19:12:00.${index}00Z`,
        final: index === 2,
      });
      expect(sink.messages()).toHaveLength(1);
      expect(sink.messages()[0]?.text).toBe(text);
    }
    expect(new Set(sink.updates.map((message) => message.segmentId)).size).toBe(1);
    expect(sink.messages()[0]).toMatchObject({
      isFinal: true,
      startedAt: Date.parse('2026-09-17T19:12:00.000Z'),
    });
  });

  it('preserves intentionally repeated words in separate final segments', () => {
    const sink = transcriptSink();
    for (const [index, final] of [false, true, false, true].entries()) {
      sink.emit({
        text: 'Yes',
        user_id: 'caller',
        timestamp: `2026-09-17T19:12:00.${index}00Z`,
        final,
      });
    }
    expect(sink.messages().map((message) => message.text)).toEqual(['Yes Yes']);
    expect(sink.updates[0]?.segmentId).not.toBe(sink.updates[2]?.segmentId);
  });

  it('keeps separate final-only segments even without usable timestamps', () => {
    const sink = transcriptSink();
    for (let i = 0; i < 2; i++) {
      sink.emit({ text: 'Yes', user_id: 'caller', timestamp: '', final: true });
    }
    expect(sink.messages().map((message) => message.text)).toEqual(['Yes Yes']);
    expect(sink.messages()[0]?.startedAt).toBeUndefined();
  });

  it('ends the pending segment on an empty final without displaying an empty message', () => {
    const sink = transcriptSink();
    sink.emit({
      text: 'Hello',
      user_id: 'caller',
      timestamp: '2026-09-17T19:12:00.000Z',
      final: false,
    });
    sink.emit({ text: '', user_id: 'caller', timestamp: '2026-09-17T19:12:00.100Z', final: true });
    sink.emit({
      text: 'Goodbye',
      user_id: 'caller',
      timestamp: '2026-09-17T19:12:01.000Z',
      final: false,
    });
    expect(sink.updates).toHaveLength(2);
    expect(sink.updates[1]?.segmentId).not.toBe(sink.updates[0]?.segmentId);
    expect(sink.updates[1]?.startedAt).toBe(Date.parse('2026-09-17T19:12:01.000Z'));
    expect(sink.messages()[0]?.text).toBe('Hello Goodbye');
  });

  it('tracks each participant independently', () => {
    const sink = transcriptSink();
    sink.emit({
      text: 'Hello',
      user_id: 'first',
      timestamp: '2026-09-17T19:12:00.000Z',
      final: false,
    });
    sink.emit({
      text: 'Hi',
      user_id: 'second',
      timestamp: '2026-09-17T19:12:00.000Z',
      final: false,
    });
    sink.emit({
      text: 'Hello there',
      user_id: 'first',
      timestamp: '2026-09-17T19:12:00.100Z',
      final: true,
    });
    sink.emit({
      text: 'Hi friend',
      user_id: 'second',
      timestamp: '2026-09-17T19:12:00.200Z',
      final: true,
    });
    expect(sink.messages().map((message) => message.text)).toEqual(['Hello there Hi friend']);
  });
});
