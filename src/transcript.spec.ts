import { describe, expect, it } from 'vitest';
import { reconcileTranscript } from './transcript.js';
import type { ConversationMessage } from './types.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function agent(
  text: string,
  opts: Partial<Omit<ConversationMessage, 'source' | 'text'>> = {},
): ConversationMessage {
  return { source: 'agent', text, isFinal: false, ...opts };
}

function user(
  text: string,
  opts: Partial<Omit<ConversationMessage, 'source' | 'text'>> = {},
): ConversationMessage {
  return { source: 'user', text, isFinal: false, ...opts };
}

// ─── pure function contract ──────────────────────────────────────────────────

describe('reconcileTranscript — purity', () => {
  it('returns a new array instance', () => {
    const prev: ConversationMessage[] = [];
    const next = reconcileTranscript(prev, agent('hello', { segmentId: 's1' }));
    expect(next).not.toBe(prev);
  });

  it('does not mutate prev', () => {
    const prev = [agent('first', { segmentId: 's1', isFinal: true })];
    const frozen = Object.freeze([...prev]);
    reconcileTranscript(frozen, agent('second', { segmentId: 's2' }));
    expect(prev).toHaveLength(1);
  });
});

// ─── segmentId upsert path ───────────────────────────────────────────────────

describe('reconcileTranscript — segmentId upsert path', () => {
  it('(a) interim updates of one segmentId collapse to one entry that grows', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('hel', { segmentId: 's1', isFinal: false }));
    t = reconcileTranscript(t, agent('hello', { segmentId: 's1', isFinal: false }));
    t = reconcileTranscript(t, agent('hello world', { segmentId: 's1', isFinal: false }));
    expect(t).toHaveLength(1);
    expect(t[0]?.text).toBe('hello world');
    expect(t[0]?.isFinal).toBe(false);
  });

  it('(b) re-delivered finals do NOT duplicate', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('hello', { segmentId: 's1', isFinal: false }));
    t = reconcileTranscript(t, agent('hello world', { segmentId: 's1', isFinal: true }));
    // Re-deliver the final (common with LiveKit user STT path).
    t = reconcileTranscript(t, agent('hello world', { segmentId: 's1', isFinal: true }));
    expect(t).toHaveLength(1);
    expect(t[0]?.isFinal).toBe(true);
  });

  it('(c) two different segmentIds from the same source stay separate', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('first turn', { segmentId: 's1', isFinal: true }));
    t = reconcileTranscript(t, agent('second turn', { segmentId: 's2', isFinal: false }));
    expect(t).toHaveLength(2);
    expect(t[0]?.text).toBe('first turn');
    expect(t[1]?.text).toBe('second turn');
  });

  it('(d) user vs agent kept separate even when segmentId collides across sources', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('agent says', { segmentId: 'shared-id', isFinal: false }));
    t = reconcileTranscript(t, user('user says', { segmentId: 'shared-id', isFinal: false }));
    expect(t).toHaveLength(2);
    expect(t.find((m) => m.source === 'agent')?.text).toBe('agent says');
    expect(t.find((m) => m.source === 'user')?.text).toBe('user says');
  });

  it('preserves startedAt from first delivery when the segment is updated', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('hel', { segmentId: 's1', isFinal: false, startedAt: 1000 }));
    t = reconcileTranscript(
      t,
      // Subsequent delivery has a different startedAt (shouldn't happen in
      // practice but we guard against it).
      agent('hello', { segmentId: 's1', isFinal: true, startedAt: 9999 }),
    );
    expect(t[0]?.startedAt).toBe(1000);
  });
});

// ─── ordering ────────────────────────────────────────────────────────────────

describe('reconcileTranscript — ordering by startedAt', () => {
  it('(e) orders entries by startedAt ascending', () => {
    let t: readonly ConversationMessage[] = [];
    // Arrive out of order by wall-clock delivery, but agent started earlier.
    t = reconcileTranscript(t, user('user turn', { segmentId: 'u1', startedAt: 2000 }));
    t = reconcileTranscript(t, agent('agent turn', { segmentId: 'a1', startedAt: 1000 }));
    expect(t[0]?.source).toBe('agent');
    expect(t[1]?.source).toBe('user');
  });

  it('entries without startedAt keep their insertion order relative to each other', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('first', { segmentId: 's1' }));
    t = reconcileTranscript(t, agent('second', { segmentId: 's2' }));
    t = reconcileTranscript(t, agent('third', { segmentId: 's3' }));
    expect(t.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  it('ties in startedAt preserve insertion order', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('first at 1000', { segmentId: 's1', startedAt: 1000 }));
    t = reconcileTranscript(t, user('second at 1000', { segmentId: 'u1', startedAt: 1000 }));
    // Both have startedAt = 1000, so insertion order wins.
    expect(t[0]?.text).toBe('first at 1000');
    expect(t[1]?.text).toBe('second at 1000');
  });
});

// ─── interim → final coalescing for one utterance ────────────────────────────
//
// Reproduces the "Test agent" dialog dup: the live transcript rendered each
// utterance TWICE — an italic interim (isFinal=false) immediately followed by a
// solid final (isFinal=true) — for both the user and the agent. The dialog does
// NO merging of its own (it renders `transcript` by array index), so two entries
// per utterance means the reconciler returned two. LiveKit's user-STT path
// publishes the interim under one segment id and then commits the FINAL under a
// *different* id, so a strict (source, segmentId) upsert never coalesces them and
// the final is appended as a second bubble.

describe('reconcileTranscript — interim → final coalescing', () => {
  it('(g) a final supersedes the prior interim of the same source even when segmentId differs', () => {
    let t: readonly ConversationMessage[] = [];
    // LiveKit STT: interim arrives under one id…
    t = reconcileTranscript(
      t,
      user('What do you have on the', { segmentId: 'u-interim', isFinal: false, startedAt: 1000 }),
    );
    // …then the committed final arrives under a DIFFERENT id.
    t = reconcileTranscript(
      t,
      user('What do you have on the menu?', {
        segmentId: 'u-final',
        isFinal: true,
        startedAt: 1000,
      }),
    );
    expect(t).toHaveLength(1);
    expect(t[0]?.text).toBe('What do you have on the menu?');
    expect(t[0]?.isFinal).toBe(true);
    // The final inherits the interim's start time so the bubble doesn't reshuffle.
    expect(t[0]?.startedAt).toBe(1000);
  });

  it('(h) interleaved user/agent interims each coalesce into a single final bubble', () => {
    let t: readonly ConversationMessage[] = [];
    // Agent greeting streams word-by-word (same id), then commits its final
    // under a fresh id — same pattern the user STT path uses.
    t = reconcileTranscript(
      t,
      agent('Welcome to', { segmentId: 'a-i', isFinal: false, startedAt: 100 }),
    );
    t = reconcileTranscript(
      t,
      agent('Welcome to Tony', { segmentId: 'a-i', isFinal: false, startedAt: 100 }),
    );
    // User starts talking while the agent's bubble is still interim.
    t = reconcileTranscript(
      t,
      user('What do', { segmentId: 'u-i', isFinal: false, startedAt: 200 }),
    );
    // Agent commits its final under a new id.
    t = reconcileTranscript(
      t,
      agent("Welcome to Tony's Pizzeria!", { segmentId: 'a-f', isFinal: true, startedAt: 100 }),
    );
    // User commits its final under a new id.
    t = reconcileTranscript(
      t,
      user('What do you have on the menu?', { segmentId: 'u-f', isFinal: true, startedAt: 200 }),
    );

    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({
      source: 'agent',
      text: "Welcome to Tony's Pizzeria!",
      isFinal: true,
    });
    expect(t[1]).toMatchObject({
      source: 'user',
      text: 'What do you have on the menu?',
      isFinal: true,
    });
  });

  it('(i) a redelivered final does NOT collapse into an earlier finalized turn of the same source', () => {
    // Guard against over-coalescing: once a turn is final, a LATER distinct
    // turn from the same source must stay separate even though the earlier one
    // is final and shares the source.
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(
      t,
      user('first turn', { segmentId: 'u1', isFinal: true, startedAt: 100 }),
    );
    t = reconcileTranscript(
      t,
      user('second turn', { segmentId: 'u2', isFinal: true, startedAt: 200 }),
    );
    expect(t).toHaveLength(2);
    expect(t.map((m) => m.text)).toEqual(['first turn', 'second turn']);
  });
});

// ─── legacy no-segmentId coalesce path ───────────────────────────────────────

describe('reconcileTranscript — legacy no-segmentId coalesce path', () => {
  it('(f) replaces last entry if same source and not final', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('partial 1', { isFinal: false }));
    t = reconcileTranscript(t, agent('partial 2', { isFinal: false }));
    expect(t).toHaveLength(1);
    expect(t[0]?.text).toBe('partial 2');
  });

  it('appends when the last entry IS final', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('first', { isFinal: true }));
    t = reconcileTranscript(t, agent('second', { isFinal: false }));
    expect(t).toHaveLength(2);
  });

  it('appends when sources differ even if last is not final', () => {
    let t: readonly ConversationMessage[] = [];
    t = reconcileTranscript(t, agent('agent partial', { isFinal: false }));
    t = reconcileTranscript(t, user('user partial', { isFinal: false }));
    expect(t).toHaveLength(2);
  });

  it('appends on empty list', () => {
    const t = reconcileTranscript([], agent('hello', { isFinal: false }));
    expect(t).toHaveLength(1);
    expect(t[0]?.text).toBe('hello');
  });

  it('mixed: no-segmentId coalesces independently from segmentId entries', () => {
    let t: readonly ConversationMessage[] = [];
    // A segmentId entry first.
    t = reconcileTranscript(t, agent('seg entry', { segmentId: 's1', isFinal: true }));
    // Then a no-segmentId stream from user.
    t = reconcileTranscript(t, user('partial', { isFinal: false }));
    t = reconcileTranscript(t, user('partial grown', { isFinal: false }));
    expect(t).toHaveLength(2);
    expect(t.find((m) => m.source === 'user')?.text).toBe('partial grown');
  });
});
