import type { ConversationMessage } from './types.js';

/**
 * Pure reconciler for streamed transcript messages.
 *
 * ## Model: bubbles are TURNS, not segments
 *
 * A rendered bubble is one speaker *turn*, not one STT segment. LiveKit's user
 * STT commits MULTIPLE final segments — each a distinct `segmentId` — for one
 * uninterrupted speaker-turn (it segments on pauses). Keying a bubble per
 * segmentId therefore scatters a single turn across many bubbles:
 *   You: Okay
 *   You: , am
 *   You: I audible
 * So we coalesce consecutive same-source segments into ONE turn bubble. A turn
 * ends only when the OTHER source speaks; the next same-source segment opens a
 * new turn.
 *
 * Each turn tracks its component segments in a module-private side-table (a
 * `WeakMap` keyed by the bubble object) — the public `ConversationMessage` shape
 * is unchanged. A turn's `text` is its segments' texts joined in arrival order;
 * its `isFinal` follows the trailing segment; its `startedAt` is pinned to the
 * FIRST segment so the bubble never reshuffles as later segments arrive. Because
 * the identity is stable, the bubble's public `segmentId` is the first segment's
 * id (a stable render key across the turn's growth).
 *
 * ### Handling one incoming segment (segmentId defined)
 * 1. **Re-delivery** — the id already names a segment of an existing same-source
 *    turn. Segment updates are CUMULATIVE (interims re-publish growing text; the
 *    final may be re-delivered), so REPLACE that segment's contribution. This
 *    never appends, so re-deliveries can't duplicate.
 * 2. **Interim→final supersession** — a committed FINAL can carry a *different*
 *    id than the interim it supersedes (LiveKit user STT). If the id is unknown
 *    and `incoming.isFinal`, fold it into the most-recent same-source turn whose
 *    trailing segment is still an open interim, replacing that segment. Scoped to
 *    finals: a new interim is never a supersession.
 * 3. **New segment** — otherwise the segment is new. If the source's turn is the
 *    latest activity (the last bubble is the same source), append it as another
 *    segment of that turn; else the other source spoke last, so open a new turn.
 *
 * ### segmentId === undefined (legacy data-channel / realtime path)
 * No segment identity: if the last entry has the same source and is NOT final,
 * replace it; otherwise append. (Unchanged.)
 *
 * After upsert/append, return a NEW array STABLE-SORTED by `startedAt` ascending;
 * entries without `startedAt` keep their relative arrival order.
 *
 * Pure with respect to `prev`: never mutates `prev` or its entries, always
 * returns a new array. The per-turn side-table is the one sanctioned internal
 * state; each returned bubble is a fresh object registered with a freshly-cloned
 * turn state, so a retained `prev` is never corrupted.
 */
export function reconcileTranscript(
  prev: readonly ConversationMessage[],
  incoming: ConversationMessage,
): ConversationMessage[] {
  let next: ConversationMessage[];

  if (incoming.segmentId === undefined) {
    // Legacy coalesce path: no segment identity, coalesce into last same-source
    // non-final entry.
    const lastIdx = prev.length - 1;
    const last = prev[lastIdx];
    if (last !== undefined && last.source === incoming.source && !last.isFinal) {
      next = [...prev];
      next[lastIdx] = incoming;
    } else {
      next = [...prev, incoming];
    }
  } else {
    next = reconcileSegment(prev, incoming);
  }

  return stableSortByStartedAt(next);
}

/** One STT segment's latest contribution to its turn. */
interface TurnSegment {
  readonly id: string | undefined;
  readonly text: string;
  readonly isFinal: boolean;
}

/** The segments composing one turn bubble, in arrival order, plus the turn's
 * anchored start time (the first segment's `startedAt`). */
interface TurnState {
  readonly segments: readonly TurnSegment[];
  readonly startedAt: number | undefined;
}

// Module-private side-table mapping each turn bubble to its component segments.
// Keyed by the bubble object (a WeakMap, so entries are collected with their
// bubbles) — this keeps per-segment bookkeeping out of the public message shape.
const turnStates = new WeakMap<ConversationMessage, TurnState>();

/** Segment-keyed reconciliation. Returns a new array; never mutates `prev`. */
function reconcileSegment(
  prev: readonly ConversationMessage[],
  incoming: ConversationMessage,
): ConversationMessage[] {
  const id = incoming.segmentId;

  // 1. Re-delivery of a segment we already track (same source, same id) →
  //    replace that segment's contribution (cumulative interim or re-sent final).
  for (let i = 0; i < prev.length; i++) {
    const bubble = prev[i];
    if (bubble === undefined || bubble.source !== incoming.source) continue;
    const state = turnStateOf(bubble);
    const segIdx = state.segments.findIndex((s) => s.id === id);
    if (segIdx !== -1) {
      return replaceBubble(prev, i, incoming.source, {
        segments: withSegmentAt(state.segments, segIdx, {
          id,
          text: incoming.text,
          isFinal: incoming.isFinal,
        }),
        startedAt: state.startedAt,
      });
    }
  }

  // 2. A final under an unknown id supersedes the most-recent same-source turn
  //    whose trailing segment is still an open interim (LiveKit commits the
  //    final under a fresh id). Scoped to finals; scanned from the end so a
  //    finalized turn never absorbs a later segment here.
  if (incoming.isFinal) {
    for (let i = prev.length - 1; i >= 0; i--) {
      const bubble = prev[i];
      if (bubble === undefined || bubble.source !== incoming.source) continue;
      const state = turnStateOf(bubble);
      const trailing = state.segments[state.segments.length - 1];
      if (trailing !== undefined && !trailing.isFinal) {
        return replaceBubble(prev, i, incoming.source, {
          segments: withSegmentAt(state.segments, state.segments.length - 1, {
            id,
            text: incoming.text,
            isFinal: true,
          }),
          startedAt: state.startedAt,
        });
      }
      // First same-source turn from the end is already final: nothing to
      // supersede. Fall through to (3), which decides join-vs-new-turn.
      break;
    }
  }

  // 3. A genuinely new segment. If the source's turn is the latest activity
  //    (last bubble is the same source, i.e. the other source hasn't spoken
  //    since), append it to that turn; otherwise open a new turn.
  const last = prev[prev.length - 1];
  if (last !== undefined && last.source === incoming.source) {
    const state = turnStateOf(last);
    return replaceBubble(prev, prev.length - 1, incoming.source, {
      segments: [...state.segments, { id, text: incoming.text, isFinal: incoming.isFinal }],
      startedAt: state.startedAt,
    });
  }

  return [
    ...prev,
    buildBubble(incoming.source, {
      segments: [{ id, text: incoming.text, isFinal: incoming.isFinal }],
      startedAt: incoming.startedAt,
    }),
  ];
}

/** The turn state for a bubble — from the side-table, or reconstructed from the
 * bubble's own fields when it wasn't produced here (hand-built or legacy). */
function turnStateOf(bubble: ConversationMessage): TurnState {
  const existing = turnStates.get(bubble);
  if (existing !== undefined) return existing;
  return {
    segments: [{ id: bubble.segmentId, text: bubble.text, isFinal: bubble.isFinal }],
    startedAt: bubble.startedAt,
  };
}

/** Copy `segments` with the entry at `idx` replaced (never mutates the input). */
function withSegmentAt(
  segments: readonly TurnSegment[],
  idx: number,
  next: TurnSegment,
): TurnSegment[] {
  const copy = segments.slice();
  copy[idx] = next;
  return copy;
}

/** Return a copy of `prev` with entry `idx` rebuilt from `state`. */
function replaceBubble(
  prev: readonly ConversationMessage[],
  idx: number,
  source: ConversationMessage['source'],
  state: TurnState,
): ConversationMessage[] {
  const next = prev.slice();
  next[idx] = buildBubble(source, state);
  return next;
}

/** Materialize a turn into a `ConversationMessage` and register its state. */
function buildBubble(source: ConversationMessage['source'], state: TurnState): ConversationMessage {
  const trailing = state.segments[state.segments.length - 1];
  // Stable render key: the FIRST segment's id anchors the turn across growth.
  const anchorId = state.segments[0]?.id;
  const bubble: ConversationMessage = {
    source,
    text: joinTurnText(state.segments),
    isFinal: trailing?.isFinal ?? false,
    ...(anchorId !== undefined ? { segmentId: anchorId } : {}),
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
  };
  turnStates.set(bubble, state);
  return bubble;
}

// Punctuation that should hug the preceding word (no space before it).
const NO_LEADING_SPACE = /^[,.!?;:)\]}%'"]/;

/** Join a turn's segment texts in arrival order with sensible spacing. */
function joinTurnText(segments: readonly TurnSegment[]): string {
  let out = '';
  for (const segment of segments) {
    const piece = segment.text.trim();
    if (piece === '') continue;
    if (out === '') {
      out = piece;
    } else {
      out += NO_LEADING_SPACE.test(piece) ? piece : ` ${piece}`;
    }
  }
  return out;
}

/**
 * Stable sort by `startedAt` ascending. Entries without `startedAt` keep their
 * existing relative order (decorate-sort-undecorate by original index).
 */
function stableSortByStartedAt(messages: ConversationMessage[]): ConversationMessage[] {
  return messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const at = a.m.startedAt;
      const bt = b.m.startedAt;
      if (at === undefined || bt === undefined) return a.i - b.i;
      return at !== bt ? at - bt : a.i - b.i;
    })
    .map((entry) => entry.m);
}
