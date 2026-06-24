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
 *   don't reshuffle the bubble. If none found, append.
 * - When `incoming.segmentId` is undefined (legacy data-channel path): if the
 *   last entry has the same source and is NOT final, replace it; otherwise append.
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
    const idx = prev.findIndex(
      (m) => m.segmentId === incoming.segmentId && m.source === incoming.source,
    );
    if (idx === -1) {
      next = [...prev, incoming];
    } else {
      // Replace in place, preserving the original utterance start time so the
      // cumulative re-deliveries don't reshuffle the bubble.
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
