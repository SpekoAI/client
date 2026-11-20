import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  connect: vi.fn(async (_url: string, _token: string, _opts?: unknown): Promise<void> => {}),
  disconnect: vi.fn(async (): Promise<void> => {}),
  startAudio: vi.fn(async (): Promise<void> => {}),
  publishTrack: vi.fn(async () => ({})),
  publishData: vi.fn(async () => {}),
  sendText: vi.fn(async () => {}),
  setMicrophoneEnabled: vi.fn(async () => {}),
  createLocalAudioTrack: vi.fn(),
  createLocalTracks: vi.fn(),
  canPlaybackAudio: true,
}));

vi.mock('livekit-client', () => {
  class FakeRoom {
    localParticipant = {
      identity: 'listen-1',
      publishTrack: fake.publishTrack,
      publishData: fake.publishData,
      sendText: fake.sendText,
      setMicrophoneEnabled: fake.setMicrophoneEnabled,
    };
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
    DUPLICATE_IDENTITY: 2,
    SERVER_SHUTDOWN: 3,
    PARTICIPANT_REMOVED: 4,
    ROOM_DELETED: 5,
    STATE_MISMATCH: 6,
    JOIN_FAILURE: 7,
    ROOM_CLOSED: 10,
    CONNECTION_TIMEOUT: 14,
    MEDIA_FAILURE: 15,
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
      Connected: 'connected',
      Reconnected: 'reconnected',
    },
    Track: { Kind: { Audio: 'audio', Video: 'video' }, Source: { Microphone: 'microphone' } },
    ParticipantKind: { STANDARD: 0, INGRESS: 1, EGRESS: 2, SIP: 3, AGENT: 4 },
    DisconnectReason,
    createLocalAudioTrack: fake.createLocalAudioTrack,
    createLocalTracks: fake.createLocalTracks,
  };
});

import {
  CallListener,
  type CallListenerEndDetails,
  type CallListenerStatus,
  type CallSpeakerRole,
  SpekoClientError,
} from './index.js';

const REASON = {
  CLIENT_INITIATED: 1,
  PARTICIPANT_REMOVED: 4,
  ROOM_DELETED: 5,
  ROOM_CLOSED: 10,
  CONNECTION_TIMEOUT: 14,
};
const KIND = { STANDARD: 0, EGRESS: 2, SIP: 3, AGENT: 4 };

function fire(event: string, ...args: unknown[]): void {
  const handler = fake.handlers.get(event);
  if (!handler) throw new Error(`no handler bound for ${event}`);
  handler(...args);
}

function audioTrack(play: () => Promise<void> = async () => {}) {
  const el = document.createElement('audio');
  el.play = vi.fn(play);
  return {
    el,
    track: { kind: 'audio', attach: () => el, detach: () => [el] },
  };
}

function playingElements(): HTMLAudioElement[] {
  return Array.from(document.body.querySelectorAll('audio'));
}

async function connectListener(extra: { volume?: number; outputDeviceId?: string } = {}) {
  const statuses: CallListenerStatus[] = [];
  const onEnded = vi.fn<(details: CallListenerEndDetails) => void>();
  const onError = vi.fn<(error: SpekoClientError) => void>();
  const onSpeakersChange = vi.fn<(speakers: readonly CallSpeakerRole[]) => void>();
  const onAudioPlaybackBlocked = vi.fn();
  const onOutputDeviceError = vi.fn<(error: Error) => void>();
  const listener = await CallListener.connect({
    url: 'wss://media.test',
    token: 'tok_listen',
    ...extra,
    onStatusChange: (status) => statuses.push(status),
    onEnded,
    onError,
    onSpeakersChange,
    onAudioPlaybackBlocked,
    onOutputDeviceError,
  });
  return {
    listener,
    statuses,
    onEnded,
    onError,
    onSpeakersChange,
    onAudioPlaybackBlocked,
    onOutputDeviceError,
  };
}

beforeEach(() => {
  fake.handlers.clear();
  fake.canPlaybackAudio = true;
  fake.connect.mockImplementation(async () => {});
  fake.disconnect.mockImplementation(async () => {});
  fake.startAudio.mockImplementation(async () => {});
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe('CallListener.connect', () => {
  it('joins with the minted url and token, subscribes to every track, and reports listening', async () => {
    const { listener, statuses } = await connectListener();

    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.connect).toHaveBeenCalledWith('wss://media.test', 'tok_listen', {
      autoSubscribe: true,
    });
    expect(statuses).toEqual(['connecting', 'listening']);
    expect(listener.status).toBe('listening');
  });

  it('rejects with CONNECTION_FAILED and ends in failed when the join fails', async () => {
    const cause = new Error('token expired');
    fake.connect.mockRejectedValueOnce(cause);
    const statuses: CallListenerStatus[] = [];
    const onError = vi.fn();

    const error = await CallListener.connect({
      url: 'wss://media.test',
      token: 'tok_old',
      onStatusChange: (status) => statuses.push(status),
      onError,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpekoClientError);
    expect(error).toMatchObject({ code: 'CONNECTION_FAILED', cause });
    expect(statuses).toEqual(['connecting', 'failed']);
    expect(onError).not.toHaveBeenCalled();
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('CallListener.connect when the room disconnects before the join settles', () => {
  function connectWithEarlyDisconnect(reason: number, join: 'resolves' | 'rejects') {
    const early = audioTrack();
    fake.connect.mockImplementationOnce(async () => {
      fire('trackSubscribed', early.track, {}, { kind: KIND.AGENT });
      fire('disconnected', reason);
      if (join === 'rejects') throw new Error('left during join');
    });
    const statuses: CallListenerStatus[] = [];
    const onEnded = vi.fn<(details: CallListenerEndDetails) => void>();
    const onError = vi.fn<(error: SpekoClientError) => void>();
    const outcome = CallListener.connect({
      url: 'wss://media.test',
      token: 'tok_listen',
      onStatusChange: (status) => statuses.push(status),
      onEnded,
      onError,
    }).then(
      (listener) => ({ listener, error: undefined }),
      (error: unknown) => ({ listener: undefined, error }),
    );
    return { outcome, statuses, onEnded, onError };
  }

  it.each([
    ['PARTICIPANT_REMOVED', REASON.PARTICIPANT_REMOVED, 'resolves'],
    ['ROOM_DELETED', REASON.ROOM_DELETED, 'resolves'],
    ['ROOM_CLOSED', REASON.ROOM_CLOSED, 'resolves'],
    ['PARTICIPANT_REMOVED', REASON.PARTICIPANT_REMOVED, 'rejects'],
  ] as const)('resolves to an ended listener when %s arrives and the join %s', async (_name, reason, join) => {
    const { outcome, statuses, onEnded, onError } = connectWithEarlyDisconnect(reason, join);

    const { listener, error } = await outcome;

    expect(error).toBeUndefined();
    expect(listener?.status).toBe('ended');
    expect(statuses).toEqual(['connecting', 'ended']);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith({ reason: 'call_ended' });
    expect(onError).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);

    fire('disconnected', reason);
    await listener?.disconnect();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['connecting', 'ended']);
  });

  it('rejects with CONNECTION_FAILED when the connection drops although the join resolves', async () => {
    const { outcome, statuses, onEnded, onError } = connectWithEarlyDisconnect(
      REASON.CONNECTION_TIMEOUT,
      'resolves',
    );

    const { listener, error } = await outcome;

    expect(listener).toBeUndefined();
    expect(error).toBeInstanceOf(SpekoClientError);
    expect(error).toMatchObject({ code: 'CONNECTION_FAILED', cause: 'CONNECTION_TIMEOUT' });
    expect(statuses).toEqual(['connecting', 'failed']);
    expect(onEnded).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);

    fire('disconnected', REASON.CONNECTION_TIMEOUT);
    expect(onError).not.toHaveBeenCalled();
    expect(statuses).toEqual(['connecting', 'failed']);
  });

  it('closes the room when a retried join succeeds after the server removed the listener', async () => {
    const retried = audioTrack();
    fake.connect.mockImplementationOnce(async () => {
      fire('disconnected', REASON.PARTICIPANT_REMOVED);
      fire('trackSubscribed', retried.track, {}, { kind: KIND.AGENT });
    });
    const onEnded = vi.fn<(details: CallListenerEndDetails) => void>();

    const listener = await CallListener.connect({
      url: 'wss://media.test',
      token: 'tok_listen',
      onEnded,
    });

    expect(listener.status).toBe('ended');
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith({ reason: 'call_ended' });
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(retried.el.play).not.toHaveBeenCalled();

    const late = audioTrack();
    fire('trackSubscribed', late.track, {}, { kind: KIND.AGENT });

    expect(late.el.play).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);
  });
});

describe('CallListener after it is over', () => {
  it.each([
    'connected',
    'reconnected',
  ])('closes a connection that comes up (%s) after the call ended', async (event) => {
    const { listener } = await connectListener();
    fire('disconnected', REASON.PARTICIPANT_REMOVED);
    expect(listener.status).toBe('ended');
    const closedBefore = fake.disconnect.mock.calls.length;

    fire(event);

    expect(fake.disconnect.mock.calls.length).toBe(closedBefore + 1);
    expect(listener.status).toBe('ended');
  });

  it('leaves a connection that reconnects during a live call alone', async () => {
    const { listener } = await connectListener();

    fire('reconnected');

    expect(fake.disconnect).not.toHaveBeenCalled();
    expect(listener.status).toBe('listening');
  });
});

describe('CallListener is receive-only', () => {
  it('never asks for the microphone and never publishes audio, data, or text', async () => {
    const { listener } = await connectListener();
    const { track } = audioTrack();
    fire('trackSubscribed', track, {}, { kind: KIND.AGENT });
    fire('activeSpeakersChanged', [{ kind: KIND.AGENT }]);
    await listener.startAudio();
    listener.setVolume(0.5);
    await listener.disconnect();

    expect(fake.createLocalAudioTrack).not.toHaveBeenCalled();
    expect(fake.createLocalTracks).not.toHaveBeenCalled();
    expect(fake.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(fake.publishTrack).not.toHaveBeenCalled();
    expect(fake.publishData).not.toHaveBeenCalled();
    expect(fake.sendText).not.toHaveBeenCalled();
  });
});

describe('CallListener playback', () => {
  it('plays one hidden audio element per subscribed audio track at the set volume', async () => {
    await connectListener({ volume: 0.4 });
    const agent = audioTrack();
    const caller = audioTrack();

    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });
    fire('trackSubscribed', caller.track, {}, { kind: KIND.SIP });
    fire('trackSubscribed', { kind: 'video' }, {}, { kind: KIND.STANDARD });

    expect(playingElements()).toEqual([agent.el, caller.el]);
    expect(agent.el.play).toHaveBeenCalledTimes(1);
    expect(caller.el.play).toHaveBeenCalledTimes(1);
    expect(agent.el.volume).toBe(0.4);
  });

  it('applies a volume change to every element and clamps it to 0..1', async () => {
    const { listener } = await connectListener();
    const agent = audioTrack();
    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });

    listener.setVolume(0.25);
    expect(agent.el.volume).toBe(0.25);
    listener.setVolume(7);
    expect(agent.el.volume).toBe(1);
  });

  it('removes the element when its track is unsubscribed', async () => {
    await connectListener();
    const agent = audioTrack();
    const caller = audioTrack();
    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });
    fire('trackSubscribed', caller.track, {}, { kind: KIND.SIP });

    fire('trackUnsubscribed', caller.track, {});

    expect(playingElements()).toEqual([agent.el]);
  });

  it('reports blocked autoplay and recovers through startAudio', async () => {
    const { listener, onAudioPlaybackBlocked } = await connectListener();
    fake.canPlaybackAudio = false;
    const agent = audioTrack(async () => {
      throw new Error('NotAllowedError');
    });

    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });
    await Promise.resolve();
    await Promise.resolve();
    expect(onAudioPlaybackBlocked).toHaveBeenCalledTimes(1);

    fire('audioPlaybackStatusChanged');
    expect(onAudioPlaybackBlocked).toHaveBeenCalledTimes(2);

    fake.canPlaybackAudio = true;
    await listener.startAudio();

    expect(fake.startAudio).toHaveBeenCalledTimes(1);
    expect(agent.el.play).toHaveBeenCalledTimes(2);
  });

  it('does not report a block while the browser allows playback', async () => {
    const { onAudioPlaybackBlocked } = await connectListener();

    fire('audioPlaybackStatusChanged');

    expect(onAudioPlaybackBlocked).not.toHaveBeenCalled();
  });

  it('reports the block again when startAudio is refused', async () => {
    const { listener, onAudioPlaybackBlocked } = await connectListener();
    fake.startAudio.mockRejectedValueOnce(new Error('NotAllowedError'));

    await listener.startAudio();

    expect(onAudioPlaybackBlocked).toHaveBeenCalledTimes(1);
  });
});

describe('CallListener playback on a chosen output device', () => {
  type SetSinkId = (deviceId: string) => Promise<void>;
  const mediaElement = HTMLMediaElement.prototype as unknown as { setSinkId?: SetSinkId };
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play');

  function browserRoutesWith(route: SetSinkId) {
    const setSinkId = vi.fn(route);
    mediaElement.setSinkId = setSinkId;
    return setSinkId;
  }

  function attachableTrack() {
    const attach = vi.fn((el?: HTMLAudioElement) => el ?? document.createElement('audio'));
    return { attach, track: { kind: 'audio', attach, detach: () => [] } };
  }

  async function routingSettled(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    play.mockImplementation(async () => {});
  });

  afterEach(() => {
    delete mediaElement.setSinkId;
  });

  it('emits no sound until the element is routed to the device, then plays', async () => {
    let routed: () => void = () => {};
    const setSinkId = browserRoutesWith(() => new Promise<void>((resolve) => (routed = resolve)));
    const { onOutputDeviceError } = await connectListener({
      outputDeviceId: 'speaker-2',
      volume: 0.3,
    });
    const agent = attachableTrack();

    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });
    await routingSettled();

    expect(setSinkId).toHaveBeenCalledWith('speaker-2');
    expect(agent.attach).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);

    routed();
    await routingSettled();

    const [el] = playingElements();
    expect(agent.attach).toHaveBeenCalledTimes(1);
    expect(agent.attach).toHaveBeenCalledWith(el);
    expect(setSinkId.mock.contexts).toEqual([el]);
    expect(play.mock.contexts).toEqual([el]);
    expect(el?.volume).toBe(0.3);
    expect(onOutputDeviceError).not.toHaveBeenCalled();
  });

  it('stays silent and reports once when the browser refuses the device', async () => {
    const cause = new Error('NotFoundError');
    browserRoutesWith(async () => {
      throw cause;
    });
    const { listener, onOutputDeviceError, onError } = await connectListener({
      outputDeviceId: 'unplugged',
    });
    const agent = attachableTrack();
    const caller = attachableTrack();

    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });
    fire('trackSubscribed', caller.track, {}, { kind: KIND.SIP });
    await routingSettled();

    expect(agent.attach).not.toHaveBeenCalled();
    expect(caller.attach).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);
    expect(onOutputDeviceError).toHaveBeenCalledTimes(1);
    expect(onOutputDeviceError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onOutputDeviceError.mock.calls[0]?.[0].cause).toBe(cause);
    expect(onError).not.toHaveBeenCalled();
    expect(listener.status).toBe('listening');
  });

  it('stays silent and reports once when the browser cannot choose an output device', async () => {
    const { onOutputDeviceError } = await connectListener({ outputDeviceId: 'speaker-2' });
    const agent = attachableTrack();
    const caller = attachableTrack();

    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });
    fire('trackSubscribed', caller.track, {}, { kind: KIND.SIP });
    await routingSettled();

    expect(agent.attach).not.toHaveBeenCalled();
    expect(caller.attach).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);
    expect(onOutputDeviceError).toHaveBeenCalledTimes(1);
    expect(onOutputDeviceError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it.each([
    [
      'the track is unsubscribed',
      (_: CallListener, track: unknown) => fire('trackUnsubscribed', track, {}),
    ],
    ['the listener stops', (listener: CallListener) => listener.disconnect()],
  ] as const)('plays nothing when %s before routing finishes', async (_name, stop) => {
    let routed: () => void = () => {};
    browserRoutesWith(() => new Promise<void>((resolve) => (routed = resolve)));
    const { listener, onOutputDeviceError } = await connectListener({
      outputDeviceId: 'speaker-2',
    });
    const agent = attachableTrack();
    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });

    await stop(listener, agent.track);
    routed();
    await routingSettled();

    expect(agent.attach).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);
    expect(onOutputDeviceError).not.toHaveBeenCalled();
  });

  it('plays at once on the default device when no output device is chosen', async () => {
    const setSinkId = browserRoutesWith(async () => {});
    await connectListener();
    const agent = attachableTrack();

    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });

    expect(agent.attach).toHaveBeenCalledTimes(1);
    expect(playingElements()).toHaveLength(1);
    expect(play.mock.contexts).toEqual(playingElements());
    expect(setSinkId).not.toHaveBeenCalled();
  });
});

describe('CallListener end of call', () => {
  it.each([
    ['PARTICIPANT_REMOVED', REASON.PARTICIPANT_REMOVED],
    ['ROOM_DELETED', REASON.ROOM_DELETED],
    ['ROOM_CLOSED', REASON.ROOM_CLOSED],
  ])('ends with call_ended when the server disconnects it (%s)', async (_name, reason) => {
    const { listener, statuses, onEnded, onError } = await connectListener();
    const agent = audioTrack();
    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });

    fire('disconnected', reason);

    expect(listener.status).toBe('ended');
    expect(statuses).toEqual(['connecting', 'listening', 'ended']);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith({ reason: 'call_ended' });
    expect(onError).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['CONNECTION_TIMEOUT', REASON.CONNECTION_TIMEOUT],
    ['no reason', undefined],
  ])('fails with DISCONNECTED when the connection is lost (%s)', async (_name, reason) => {
    const { listener, statuses, onEnded, onError } = await connectListener();
    const agent = audioTrack();
    fire('trackSubscribed', agent.track, {}, { kind: KIND.AGENT });

    fire('disconnected', reason);

    expect(listener.status).toBe('failed');
    expect(statuses).toEqual(['connecting', 'listening', 'failed']);
    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(SpekoClientError);
    expect(error?.code).toBe('DISCONNECTED');
    expect(onEnded).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it('plays no track that arrives after the call ended', async () => {
    await connectListener();
    fire('disconnected', REASON.ROOM_DELETED);
    const late = audioTrack();

    fire('trackSubscribed', late.track, {}, { kind: KIND.AGENT });

    expect(late.el.play).not.toHaveBeenCalled();
    expect(playingElements()).toEqual([]);
  });

  it('stays ended when closing the room fails', async () => {
    fake.disconnect.mockRejectedValue(new Error('already closed'));
    const { listener, statuses, onEnded, onError } = await connectListener();

    fire('disconnected', REASON.ROOM_DELETED);
    await listener.disconnect();

    expect(statuses).toEqual(['connecting', 'listening', 'ended']);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('stays in its terminal state when a second disconnect event arrives', async () => {
    const { listener, statuses, onEnded, onError } = await connectListener();

    fire('disconnected', REASON.ROOM_DELETED);
    fire('disconnected', REASON.CONNECTION_TIMEOUT);

    expect(listener.status).toBe('ended');
    expect(statuses).toEqual(['connecting', 'listening', 'ended']);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('CallListener.disconnect', () => {
  it('ends with stopped, leaves the call, and removes every audio element', async () => {
    const { listener, statuses, onEnded } = await connectListener();
    fire('trackSubscribed', audioTrack().track, {}, { kind: KIND.AGENT });
    fire('trackSubscribed', audioTrack().track, {}, { kind: KIND.SIP });
    expect(playingElements()).toHaveLength(2);

    await listener.disconnect();

    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(listener.status).toBe('ended');
    expect(statuses).toEqual(['connecting', 'listening', 'ended']);
    expect(onEnded).toHaveBeenCalledWith({ reason: 'stopped' });
    expect(playingElements()).toEqual([]);
  });

  it('is idempotent, including after the transport confirms the disconnect', async () => {
    const { listener, statuses, onEnded } = await connectListener();

    await listener.disconnect();
    fire('disconnected', REASON.CLIENT_INITIATED);
    await listener.disconnect();

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['connecting', 'listening', 'ended']);
  });

  it('closes the room again when called after the call already ended', async () => {
    const { listener, onEnded } = await connectListener();
    fire('disconnected', REASON.ROOM_DELETED);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);

    await listener.disconnect();

    expect(fake.disconnect).toHaveBeenCalledTimes(2);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith({ reason: 'call_ended' });
  });

  it('plays no track that arrives after the listener stopped', async () => {
    const { listener } = await connectListener();
    await listener.disconnect();

    fire('trackSubscribed', audioTrack().track, {}, { kind: KIND.AGENT });

    expect(playingElements()).toEqual([]);
  });
});

describe('CallListener speakers', () => {
  it('reports the agent and people on the call by role, not by local or remote', async () => {
    const { onSpeakersChange } = await connectListener();

    fire('activeSpeakersChanged', [{ kind: KIND.AGENT }]);
    fire('activeSpeakersChanged', [{ kind: KIND.SIP }]);
    fire('activeSpeakersChanged', [{ kind: KIND.STANDARD }, { kind: KIND.AGENT }]);
    fire('activeSpeakersChanged', []);

    expect(onSpeakersChange.mock.calls.map(([speakers]) => speakers)).toEqual([
      ['agent'],
      ['caller'],
      ['agent', 'caller'],
      [],
    ]);
  });

  it('reports one agent role when two AI agents speak, so it cannot tell them apart', async () => {
    const { onSpeakersChange } = await connectListener();

    fire('activeSpeakersChanged', [{ kind: KIND.AGENT }, { kind: KIND.AGENT }]);

    expect(onSpeakersChange).toHaveBeenCalledTimes(1);
    expect(onSpeakersChange).toHaveBeenCalledWith(['agent']);
  });

  it('reports only when the set of roles changes and ignores non-call participants', async () => {
    const { onSpeakersChange } = await connectListener();

    fire('activeSpeakersChanged', [{ kind: KIND.SIP }]);
    fire('activeSpeakersChanged', [{ kind: KIND.SIP }, { kind: KIND.STANDARD }]);
    fire('activeSpeakersChanged', [{ kind: KIND.SIP }, { kind: KIND.EGRESS }]);

    expect(onSpeakersChange).toHaveBeenCalledTimes(1);
    expect(onSpeakersChange).toHaveBeenCalledWith(['caller']);
  });

  it('clears the speakers when the call ends', async () => {
    const { onSpeakersChange } = await connectListener();
    fire('activeSpeakersChanged', [{ kind: KIND.AGENT }]);

    fire('disconnected', REASON.ROOM_DELETED);

    expect(onSpeakersChange).toHaveBeenLastCalledWith([]);
  });
});
