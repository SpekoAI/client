import { DisconnectReason } from 'livekit-client';

/**
 * The server ends a live call by deleting its room, and removes a listener
 * when the call is over, so these reasons are the "call ended" signal for a
 * browser that joined a call (`CallListener`, `CallTakeover`). Any other
 * reason means the connection broke.
 */
export const CALL_OVER_REASONS: ReadonlySet<DisconnectReason | undefined> = new Set([
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.ROOM_CLOSED,
]);

export function reasonName(reason: DisconnectReason | undefined): string | undefined {
  return reason === undefined ? undefined : DisconnectReason[reason];
}
