import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  constructor(_options: unknown) {
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
