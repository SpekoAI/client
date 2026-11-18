import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  connect: vi.fn(async (_url: string, _token: string, _opts?: unknown): Promise<void> => {}),
  disconnect: vi.fn(async (): Promise<void> => {}),
  startAudio: vi.fn(async (): Promise<void> => {}),
  publishTrack: vi.fn(async (_track: unknown, _opts?: unknown): Promise<unknown> => ({})),
  createLocalAudioTrack: vi.fn(),
  canPlaybackAudio: true,
}));

vi.mock('livekit-client', () => {
  class FakeRoom {
    localParticipant = { identity: 'web-join-1', publishTrack: fake.publishTrack };
    get canPlaybackAudio(): boolean {
      return fake.canPlaybackAudio;
    }
    startAudio = fake.startAudio;
    connect = fake.connect;
    disconnect = fake.disconnect;
    on(event: string, cb: Handler): this {
      fake.handlers.set(event, cb);
      return this;
    }
  }
  const DisconnectReason: Record<string | number, string | number> = {
    UNKNOWN_REASON: 0,
    CLIENT_INITIATED: 1,
    PARTICIPANT_REMOVED: 4,
    ROOM_DELETED: 5,
    ROOM_CLOSED: 10,
    CONNECTION_TIMEOUT: 14,
  };
  for (const [name, value] of Object.entries(DisconnectReason)) DisconnectReason[value] = name;
  return {
    Room: FakeRoom,
    RoomEvent: {
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      ActiveSpeakersChanged: 'activeSpeakersChanged',
      Disconnected: 'disconnected',
      AudioPlaybackStatusChanged: 'audioPlaybackStatusChanged',
      MediaDevicesError: 'mediaDevicesError',
      DataReceived: 'dataReceived',
      Connected: 'connected',
      Reconnected: 'reconnected',
    },
    Track: { Kind: { Audio: 'audio', Video: 'video' }, Source: { Microphone: 'microphone' } },
    TrackEvent: { Ended: 'ended', Muted: 'muted' },
    ParticipantKind: { STANDARD: 0, INGRESS: 1, EGRESS: 2, SIP: 3, AGENT: 4 },
    DisconnectReason,
    createLocalAudioTrack: fake.createLocalAudioTrack,
  };
});

import {
  CallTakeover,
  type CallTakeoverEndDetails,
  type CallTakeoverSpeaker,
  type CallTakeoverStatus,
  SpekoClientError,
} from './index.js';

const REASON = { CLIENT_INITIATED: 1, ROOM_DELETED: 5, CONNECTION_TIMEOUT: 14 };
const KIND = { STANDARD: 0, SIP: 3, AGENT: 4 };

function fire(event: string, ...args: unknown[]): void {
  const handler = fake.handlers.get(event);
  if (!handler) throw new Error(`no handler bound for ${event}`);
  handler(...args);
}

function microphone() {
  const handlers = new Map<string, () => void>();
  const track = {
    handlers,
    on: vi.fn((event: string, cb: () => void) => {
      handlers.set(event, cb);
      return track;
    }),
    // A real LocalAudioTrack emits `muted` from inside `mute()`.
    mute: vi.fn(async () => handlers.get('muted')?.()),
    unmute: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  return track;
}

const AGENT = { identity: 'agent-AJ_1', kind: 4 };

/** The agent's acknowledgement once it has gone silent for this browser. */
function confirm(identity = 'web-join-1', from: unknown = AGENT, type = 'bridge_muted'): void {
  fire(
    'dataReceived',
    new TextEncoder().encode(JSON.stringify({ type, recipientParticipantIdentity: identity })),
    from,
    0,
    'speko.control',
  );
}

let mic = microphone();

async function connectTakeover(
  extra: {
    inputDeviceId?: string;
    confirmTimeoutMs?: number;
    credentials?: () => Promise<{ url: string; token: string }>;
    signal?: AbortSignal;
  } = {},
) {
  const statuses: CallTakeoverStatus[] = [];
  const onEnded = vi.fn<(details: CallTakeoverEndDetails) => void>();
  const onError = vi.fn<(error: SpekoClientError) => void>();
  const onSpeakersChange = vi.fn<(speakers: readonly CallTakeoverSpeaker[]) => void>();
  const { credentials, ...rest } = extra;
  const takeover = await CallTakeover.connect({
    ...(credentials ? { credentials } : { url: 'wss://media.test', token: 'tok_join' }),
    ...rest,
    onStatusChange: (status) => statuses.push(status),
    onEnded,
    onError,
    onSpeakersChange,
  });
  return { takeover, statuses, onEnded, onError, onSpeakersChange };
}

beforeEach(() => {
  fake.handlers.clear();
  fake.canPlaybackAudio = true;
  mic = microphone();
  fake.createLocalAudioTrack.mockImplementation(async () => mic);
  fake.connect.mockImplementation(async () => {});
  // The server confirms once the microphone reaches the call.
  fake.publishTrack.mockImplementation(async () => {
    queueMicrotask(() => confirm());
    return {};
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('CallTakeover', () => {
  it('takes the microphone before it joins, then publishes it and goes live', async () => {
    const { takeover, statuses } = await connectTakeover({ inputDeviceId: 'mic-2' });
    expect(fake.createLocalAudioTrack).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'mic-2', echoCancellation: true }),
    );
    expect(fake.createLocalAudioTrack.mock.invocationCallOrder[0]).toBeLessThan(
      fake.connect.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(fake.connect).toHaveBeenCalledWith('wss://media.test', 'tok_join', {
      autoSubscribe: true,
    });
    expect(fake.publishTrack).toHaveBeenCalledWith(mic, {
      source: 'microphone',
      name: 'microphone',
    });
    expect(takeover.status).toBe('live');
    expect(statuses).toEqual(['connecting', 'live']);
  });

  it('never joins the call when the browser gives no microphone', async () => {
    fake.createLocalAudioTrack.mockRejectedValue(new Error('NotAllowedError'));
    const error = await connectTakeover().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SpekoClientError);
    expect((error as SpekoClientError).code).toBe('MICROPHONE_FAILED');
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it('rejects CONNECTION_FAILED and releases the microphone when credentials() throws', async () => {
    const error = await connectTakeover({
      credentials: () => {
        throw new Error('backend down');
      },
    }).catch((err: unknown) => err);
    expect((error as SpekoClientError).code).toBe('CONNECTION_FAILED');
    expect(mic.stop).toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it('rejects CONNECTION_FAILED and releases the microphone when the join fails', async () => {
    fake.connect.mockRejectedValue(new Error('token expired'));
    const error = await connectTakeover().catch((err: unknown) => err);
    expect((error as SpekoClientError).code).toBe('CONNECTION_FAILED');
    expect(mic.stop).toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenCalled();
  });

  it('leaves the call when the microphone cannot be published', async () => {
    fake.publishTrack.mockRejectedValue(new Error('publish failed'));
    const error = await connectTakeover().catch((err: unknown) => err);
    expect((error as SpekoClientError).code).toBe('MICROPHONE_FAILED');
    expect(fake.disconnect).toHaveBeenCalled();
    expect(mic.stop).toHaveBeenCalled();
  });

  it('fetches credentials only after the microphone is granted', async () => {
    const credentials = vi.fn(async () => ({ url: 'wss://fresh.test', token: 'tok_fresh' }));
    const { takeover } = await connectTakeover({ credentials });
    expect(fake.createLocalAudioTrack.mock.invocationCallOrder[0]).toBeLessThan(
      credentials.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(fake.connect).toHaveBeenCalledWith('wss://fresh.test', 'tok_fresh', {
      autoSubscribe: true,
    });
    expect(takeover.status).toBe('live');
  });

  it('rejects TAKE_OVER_FAILED and leaves when the take-over is never confirmed', async () => {
    fake.publishTrack.mockImplementation(async () => ({}));
    const error = await connectTakeover({ confirmTimeoutMs: 20 }).catch((err: unknown) => err);
    expect((error as SpekoClientError).code).toBe('TAKE_OVER_FAILED');
    expect(fake.disconnect).toHaveBeenCalled();
    expect(mic.stop).toHaveBeenCalled();
  });

  it('ignores the server’s mute request and any acknowledgement not from the agent', async () => {
    fake.publishTrack.mockImplementation(async () => {
      queueMicrotask(() => {
        confirm('web-join-other');
        // The server's request to mute is not proof the agent did.
        confirm('web-join-1', undefined, 'transfer_completed');
        // Anyone can publish data; only an agent participant's ack counts.
        confirm('web-join-1', { identity: 'browser-caller', kind: 0 });
      });
      return {};
    });
    const error = await connectTakeover({ confirmTimeoutMs: 20 }).catch((err: unknown) => err);
    expect((error as SpekoClientError).code).toBe('TAKE_OVER_FAILED');
  });

  it('reports a microphone that stops while live, but not its own mute', async () => {
    const { takeover, onError } = await connectTakeover();
    await takeover.setMuted(true);
    expect(onError).not.toHaveBeenCalled();
    await takeover.setMuted(false);
    mic.handlers.get('ended')?.();
    expect(onError.mock.calls[0]?.[0].code).toBe('MICROPHONE_FAILED');
    expect(takeover.status).toBe('live');
  });

  it('fails MICROPHONE_FAILED when the microphone stops before the confirmation', async () => {
    fake.publishTrack.mockImplementation(async () => {
      mic.handlers.get('ended')?.();
      queueMicrotask(() => confirm());
      return {};
    });
    const error = await connectTakeover().catch((err: unknown) => err);
    expect((error as SpekoClientError).code).toBe('MICROPHONE_FAILED');
    expect(fake.disconnect).toHaveBeenCalled();
  });

  it('never reads its own overlapping mute and unmute as a lost microphone', async () => {
    const { takeover, onError } = await connectTakeover();
    // LiveKit's mute awaits a lock before it emits `muted`.
    mic.mute.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      mic.handlers.get('muted')?.();
    });
    const first = takeover.setMuted(true);
    const second = takeover.setMuted(false);
    await Promise.all([first, second]);
    expect(onError).not.toHaveBeenCalled();
    expect(takeover.isMuted).toBe(false);
  });

  describe('cancelled through its signal', () => {
    it('never joins when cancelled during the microphone prompt, and releases it', async () => {
      const controller = new AbortController();
      let grant: () => void = () => undefined;
      fake.createLocalAudioTrack.mockImplementation(
        () =>
          new Promise((resolve) => {
            grant = () => resolve(mic);
          }),
      );
      const pending = connectTakeover({ signal: controller.signal });
      controller.abort();
      grant();
      const { takeover, onEnded } = await pending;
      expect(takeover.status).toBe('ended');
      expect(onEnded).toHaveBeenCalledWith({ reason: 'handed_back' });
      expect(fake.connect).not.toHaveBeenCalled();
      expect(mic.stop).toHaveBeenCalled();
    });

    it('settles at once when cancelled while a prompt never answers', async () => {
      const controller = new AbortController();
      fake.createLocalAudioTrack.mockImplementation(() => new Promise(() => undefined));
      const pending = connectTakeover({ signal: controller.signal });
      controller.abort();
      const { takeover, onEnded } = await pending;
      expect(takeover.status).toBe('ended');
      expect(onEnded).toHaveBeenCalledWith({ reason: 'handed_back' });
      expect(fake.connect).not.toHaveBeenCalled();
    });

    it('settles at once when cancelled while credentials() never answers', async () => {
      const controller = new AbortController();
      const pending = connectTakeover({
        signal: controller.signal,
        credentials: () => new Promise(() => undefined),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      const { takeover } = await pending;
      expect(takeover.status).toBe('ended');
      expect(fake.connect).not.toHaveBeenCalled();
      expect(mic.stop).toHaveBeenCalled();
    });

    it('still rejects with the failure when a failed-status handler aborts', async () => {
      const controller = new AbortController();
      fake.connect.mockRejectedValue(new Error('token expired'));
      const error = await CallTakeover.connect({
        url: 'wss://media.test',
        token: 'tok_join',
        signal: controller.signal,
        onStatusChange: (status) => {
          if (status === 'failed') controller.abort();
        },
      }).catch((err: unknown) => err);
      expect((error as SpekoClientError).code).toBe('CONNECTION_FAILED');
    });

    it('never joins when cancelled while the credentials are fetched', async () => {
      const controller = new AbortController();
      const { takeover } = await connectTakeover({
        signal: controller.signal,
        credentials: async () => {
          controller.abort();
          return { url: 'wss://fresh.test', token: 'tok_fresh' };
        },
      });
      expect(takeover.status).toBe('ended');
      expect(fake.connect).not.toHaveBeenCalled();
      expect(mic.stop).toHaveBeenCalled();
    });

    it('leaves at once when cancelled while waiting for the confirmation', async () => {
      const controller = new AbortController();
      fake.publishTrack.mockImplementation(async () => {
        queueMicrotask(() => controller.abort());
        return {};
      });
      const started = Date.now();
      const { takeover } = await connectTakeover({ signal: controller.signal });
      expect(takeover.status).toBe('ended');
      expect(fake.disconnect).toHaveBeenCalled();
      expect(mic.stop).toHaveBeenCalled();
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  it('ends as call_ended when the call ends while the microphone publishes', async () => {
    fake.publishTrack.mockImplementation(async () => {
      fire('disconnected', REASON.ROOM_DELETED);
      return {};
    });
    const { takeover, onEnded } = await connectTakeover();
    expect(takeover.status).toBe('ended');
    expect(onEnded).toHaveBeenCalledWith({ reason: 'call_ended' });
  });

  it('hands the call back: leaves, stops the microphone and reports handed_back once', async () => {
    const { takeover, onEnded, statuses } = await connectTakeover();
    await takeover.handBack();
    await takeover.handBack();
    expect(fake.disconnect).toHaveBeenCalled();
    expect(mic.stop).toHaveBeenCalled();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith({ reason: 'handed_back' });
    expect(statuses.at(-1)).toBe('ended');
  });

  it('reports call_ended when the call is over', async () => {
    const { takeover, onEnded, onError } = await connectTakeover();
    fire('disconnected', REASON.ROOM_DELETED);
    expect(takeover.status).toBe('ended');
    expect(onEnded).toHaveBeenCalledWith({ reason: 'call_ended' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('fails with DISCONNECTED when the connection is lost', async () => {
    const { takeover, onError } = await connectTakeover();
    fire('disconnected', REASON.CONNECTION_TIMEOUT);
    expect(takeover.status).toBe('failed');
    expect(onError.mock.calls[0]?.[0].code).toBe('DISCONNECTED');
  });

  it('mutes and unmutes the microphone while keeping the call', async () => {
    const { takeover } = await connectTakeover();
    await takeover.setMuted(true);
    expect(mic.mute).toHaveBeenCalled();
    expect(takeover.isMuted).toBe(true);
    await takeover.setMuted(false);
    expect(mic.unmute).toHaveBeenCalled();
    expect(takeover.isMuted).toBe(false);
    expect(takeover.status).toBe('live');
  });

  it('labels speakers as you, the agent and the caller', async () => {
    const { onSpeakersChange } = await connectTakeover();
    fire('activeSpeakersChanged', [
      { identity: 'sip_+1555', kind: KIND.SIP },
      { identity: 'web-join-1', kind: KIND.STANDARD },
    ]);
    expect(onSpeakersChange).toHaveBeenLastCalledWith(['you', 'caller']);
    fire('activeSpeakersChanged', [{ identity: 'agent-1', kind: KIND.AGENT }]);
    expect(onSpeakersChange).toHaveBeenLastCalledWith(['agent']);
  });

  it('plays the call audio while live', async () => {
    await connectTakeover();
    const el = document.createElement('audio');
    el.play = vi.fn(async () => {});
    fire('trackSubscribed', { kind: 'audio', attach: () => el, detach: () => [el] });
    expect(document.body.querySelectorAll('audio')).toHaveLength(1);
  });

  it('reports a microphone that fails while live without leaving the call', async () => {
    const { takeover, onError } = await connectTakeover();
    fire('mediaDevicesError', new Error('device unplugged'));
    expect(onError.mock.calls[0]?.[0].code).toBe('MICROPHONE_FAILED');
    expect(takeover.status).toBe('live');
  });
});
