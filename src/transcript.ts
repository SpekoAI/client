import type { ConversationMessage } from './types.js';

/**
 * Pure reconciler for streamed transcript messages.
 *
 * Ported verbatim-in-spirit from the proven `upsertMessage` + `sortByStartedAt`
 * reference implementation in apps/dashboard test-agent-modal.tsx.
 *
 * Rules:
 * - When `incoming.segmentId` is defined: UPSERT by (source, segmentId) —
 *   find the existing entry with the same source AND segmentId and REPLACE it
 *   in place, preserving the original `startedAt` so cumulative re-deliveries
 *   don't reshuffle the bubble. If no (source, segmentId) match exists, the
 *   message belongs to a turn we haven't keyed yet — but LiveKit's user-STT
 *   path publishes the interim under one segment id and then commits the FINAL
 *   under a *different* id, so a strict id match would append the final as a
 *   SECOND bubble next to its own interim. To coalesce, a FINAL with no id
 *   match falls back to the trailing non-final entry of the same source (its
 *   in-flight interim) and replaces that. The fallback is scoped to finals:
 *   distinct interim segments from one source can legitimately coexist, so an
 *   id-less interim stays a genuinely new bubble. Append only when there is no
 *   open interim to supersede.
 * - When `incoming.segmentId` is undefined (legacy data-channel / realtime
 *   path): if the last entry has the same source and is NOT final, replace it;
 *   otherwise append.
 * - After upsert/append, return a NEW array STABLE-SORTED by `startedAt`
 *   ascending. Entries without `startedAt` keep their relative arrival order.
 *
 * Pure: never mutates `prev`, always returns a new array.
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
    // Segment-keyed upsert path.
    let idx = prev.findIndex(
      (m) => m.segmentId === incoming.segmentId && m.source === incoming.source,
    );
    // No exact (source, segmentId) match. A committed FINAL can carry a
    // different id than the interim it supersedes (LiveKit user STT), so before
    // appending a fresh bubble, coalesce a final into this source's still-open
    // interim if one exists. Scoped to finals: distinct interim segments from
    // the same source can legitimately coexist (each is its own in-flight id),
    // so an interim that doesn't match an id is a genuinely new bubble.
    if (idx === -1 && incoming.isFinal) {
      idx = lastOpenInterimIndex(prev, incoming.source);
    }
    if (idx === -1) {
      next = [...prev, incoming];
    } else {
      // Replace in place, preserving the original utterance start time so the
      // cumulative re-deliveries (and interim→final supersession) don't
      // reshuffle the bubble.
      const merged: ConversationMessage = {
        ...incoming,
        startedAt: prev[idx]?.startedAt ?? incoming.startedAt,
      };
      next = [...prev];
      next[idx] = merged;
    }
  }

  return stableSortByStartedAt(next);
}

/**
 * Index of the trailing not-yet-final entry for `source` — the utterance still
 * streaming for that speaker. Finalized turns are never targeted, so a later
 * distinct turn from the same source never collapses into an earlier finalized
 * one. Returns -1 when this source has no open interim.
 */
function lastOpenInterimIndex(
  messages: readonly ConversationMessage[],
  source: ConversationMessage['source'],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined || m.source !== source) continue;
    return m.isFinal ? -1 : i;
  }
  return -1;
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
