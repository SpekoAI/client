import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from './types.js';

/**
 * Tests the room-event fan-in that drives live transcripts. The real
 * `Room` is replaced with a capture shim so the spec can fire
 * TranscriptionReceived / DataReceived exactly as livekit-client would:
 * cumulative same-id segment updates for the agent (word-by-word),
 * full-text re-publishes for the user (final delivered twice).
 */

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();

vi.mock('livekit-client', () => {
  class FakeRoom {
    localParticipant = { identity: 'local-user' };
    name = 'room_test';
    on(event: string, cb: Handler): this {
      handlers.set(event, cb);
      return this;
    }
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
  }
  return {
    Room: FakeRoom,
    RoomEvent: {
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      DataReceived: 'dataReceived',
      TranscriptionReceived: 'transcriptionReceived',
      ActiveSpeakersChanged: 'activeSpeakersChanged',
      Disconnected: 'disconnected',
      MediaDevicesError: 'mediaDevicesError',
    },
    Track: { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } },
    DisconnectReason: { CLIENT_INITIATED: 1 },
    createLocalAudioTrack: vi.fn(),
  };
});

import { WebRTCConnection } from './webrtc-connection.js';

function setup() {
  handlers.clear();
  const onMessage = vi.fn<(message: ConversationMessage) => void>();
  const onError = vi.fn();
  new WebRTCConnection({
    conversationToken: 'token',
    livekitUrl: 'wss://example.test',
    callbacks: { onMessage, onError },
  });
  const fire = (event: string, ...args: unknown[]) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`no handler bound for ${event}`);
    handler(...args);
  };
  return { onMessage, onError, fire };
}

describe('WebRTCConnection transcription handling', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('forwards segment id, source attribution, and finality', () => {
    const { onMessage, fire } = setup();

    fire(
      'transcriptionReceived',
      [{ id: 'SG_1', text: 'hey', final: false }],
      { identity: 'local-user' }, // local participant → user
    );
    fire(
      'transcriptionReceived',
      [{ id: 'SG_2', text: "You're", final: false }],
      { identity: 'agent-AJ_x' }, // remote participant → agent
    );

    expect(onMessage).toHaveBeenNthCalledWith(1, {
      source: 'user',
      text: 'hey',
      isFinal: false,
      segmentId: 'SG_1',
    });
    expect(onMessage).toHaveBeenNthCalledWith(2, {
      source: 'agent',
      text: "You're",
      isFinal: false,
      segmentId: 'SG_2',
    });
  });

  it('keeps the same segment id across cumulative agent updates', () => {
    const { onMessage, fire } = setup();
    const agent = { identity: 'agent-AJ_x' };

    // The worker's TTS-aligned transcript: one event per spoken word,
    // same id, growing text, final only at flush.
    fire('transcriptionReceived', [{ id: 'SG_a', text: "You're", final: false }], agent);
    fire('transcriptionReceived', [{ id: 'SG_a', text: "You're right", final: false }], agent);
    fire(
      'transcriptionReceived',
      [{ id: 'SG_a', text: "You're right to ask", final: true }],
      agent,
    );

    const ids = onMessage.mock.calls.map(([m]) => m.segmentId);
    expect(ids).toEqual(['SG_a', 'SG_a', 'SG_a']);
    expect(onMessage.mock.calls[2]?.[0]).toMatchObject({
      text: "You're right to ask",
      isFinal: true,
    });
  });

  it('attributes segments without a participant to the agent and skips empty text', () => {
    const { onMessage, fire } = setup();

    fire(
      'transcriptionReceived',
      [
        { id: 'SG_empty', text: '', final: false },
        { id: 'SG_b', text: 'hello', final: true },
      ],
      undefined,
    );

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      source: 'agent',
      text: 'hello',
      isFinal: true,
      segmentId: 'SG_b',
    });
  });

  it('omits segmentId when the transport provides none', () => {
    const { onMessage, fire } = setup();

    fire('transcriptionReceived', [{ id: '', text: 'hi', final: true }], {
      identity: 'local-user',
    });

    const [message] = onMessage.mock.calls[0] ?? [];
    expect(message).toEqual({ source: 'user', text: 'hi', isFinal: true });
    expect(message && 'segmentId' in message).toBe(false);
  });

  it('ignores non-protocol data packets instead of erroring the session', () => {
    const { onMessage, onError, fire } = setup();

    // Server control topic payload — valid JSON, unknown type → dropped.
    fire('dataReceived', new TextEncoder().encode(JSON.stringify({ type: 'credits_exhausted' })));
    // Garbage from an unrelated publisher → dropped, NOT a fatal error.
    fire('dataReceived', new TextEncoder().encode('not-json'));

    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
