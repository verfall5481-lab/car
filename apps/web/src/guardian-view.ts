import type { Pickup, PickupOffer } from '@deriro/contracts';

/**
 * How a guardian stands to a pickup's pending offer (P-04, P-05). A family-wide offer has no sender: the offer of an
 * open request (4.4 #2) or of an announced open routine occurrence (4.4 #4). It is not a handoff, so it is answered
 * with "내가 갈게" (`accept_pickup`), also by a driver who declined it earlier (4.3 #3). Only a handoff from another
 * member to me or to everyone is "나에게 온 부탁", answered with "수락" or "거절".
 */
export function guardianOffer(pickup: Pickup, memberId: string, eligible: boolean): {
  sent: PickupOffer | null;
  received: PickupOffer | null;
  canAccept: boolean;
} {
  const pending = pickup.offer?.status === 'pending' ? pickup.offer : null;
  const sent = pending?.fromMemberId === memberId ? pending : null;
  const handoff = pending !== null && pending.fromMemberId != null && pending.fromMemberId !== memberId;
  const received = handoff && eligible && (!pending.toMemberId || pending.toMemberId === memberId) &&
    !pending.declinedBy.includes(memberId) ? pending : null;
  const familyWide = pending !== null && pending.fromMemberId == null;
  return { sent, received, canAccept: pickup.status === 'open' && eligible && (!pending || familyWide || received !== null) };
}
