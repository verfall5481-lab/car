import { addDays, familyDate, nobodyAvailable } from '@deriro/contracts';
import type { Pickup, PickupOffer } from '@deriro/contracts';
import { dayAt, minute, nameOf, pickupDay, unavailableFor, unavailableOnDay, weekdayAt } from './demo-domain.ts';
import type { DemoState, Routine } from './demo-domain.ts';

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

// 24장 갈 사람이 없을 때. The live feeds carry the server's own answers in `state.pickupFacts`; the demo derives them.

const hour = 60 * minute;

/** "갈 사람 없음" (24.2): an open pickup without any available driver. The live feed's flag wins over local data. */
export function isNobodyAvailable(state: DemoState, pickup: Pickup): boolean {
  if (pickup.status !== 'open') return false;
  return state.pickupFacts?.[pickup.id]?.nobodyAvailable ?? nobodyAvailable(pickup, state.members, unavailableFor(state, pickup));
}

/** The destination place's "못 갈 때 안내", or null for a pin, a location without a place, or a place without one. */
export function waitNoteFor(state: DemoState, pickup: Pickup): string | null {
  const fact = state.pickupFacts?.[pickup.id]?.waitNote;
  if (fact !== undefined) return fact || null;
  const placeId = pickup.destination.placeId;
  return (placeId && state.places.find((place) => place.id === placeId)?.fallbackNote) || null;
}

/** The guardian who declared "못 간다고 알리기", by the name the family uses. */
export function fallbackByName(state: DemoState, pickup: Pickup): string {
  return nameOf(state, pickup.fallbackBy) || state.pickupFacts?.[pickup.id]?.fallbackByName || '';
}

/** When the pickup ended: the server's `cancelled_at` in live mode, the history row in the demo. */
export function endedAt(state: DemoState, pickup: Pickup): number | null {
  return state.terminalAt?.[pickup.id] ??
    state.history.find((event) => event.pickupId === pickup.id && (event.event === 'no_driver' || event.event === 'cancelled'))?.at ?? null;
}

/**
 * Where a `cancelled(no_driver)` pickup stands (24.5), or null once nobody is shown it any more:
 * - `sent`: not acknowledged yet, within 5 minutes of the declaration;
 * - `unacked`: not acknowledged after 5 minutes (the requester's call buttons grow, guardians see "아직 확인하지 않았어요");
 * - `acked`: acknowledged, for 10 minutes.
 * An unacknowledged one is shown until max(wanted time, declaration) + 3 hours, as `rider_get_state` lists it.
 */
export type FallbackStage = 'sent' | 'unacked' | 'acked';
export function fallbackStage(state: DemoState, pickup: Pickup, now: number): FallbackStage | null {
  if (pickup.status !== 'cancelled' || pickup.cancelReason !== 'no_driver') return null;
  if (pickup.fallbackAckAt != null) return now < pickup.fallbackAckAt + 10 * minute ? 'acked' : null;
  const at = endedAt(state, pickup) ?? pickup.wantedAt;
  if (now >= Math.max(pickup.wantedAt, at) + 3 * hour) return null;
  const escalated = (state.pickupCapabilities?.[pickup.id]?.escalation ?? 0) > 0;
  return escalated || now >= at + 5 * minute ? 'unacked' : 'sent';
}

const ownedBy = (pickup: Pickup, memberId: string) => pickup.requester.kind === 'member' && pickup.requester.id === memberId;

/**
 * P-04 sections for one guardian (24.5). `visible` is what this guardian may see on P-04 at all.
 * - `nobody`: open pickups of today (or overdue) with nobody available, shown first in "지금" instead of a request card;
 * - `fallback`: other people's `no_driver` pickups at their current stage, unless this guardian closed that stage;
 * - `ownFallback`: this guardian's own request that someone declared, still waiting for their "알겠어";
 * - `tomorrow`: tomorrow's open routine occurrences for the "내일" section.
 */
export function noDriverSections(state: DemoState, memberId: string, visible: readonly Pickup[], now: number, dismissed: readonly string[]) {
  const today = familyDate(now);
  const tomorrowDay = addDays(today, 1);
  const nobody = visible.filter((pickup) => pickup.status === 'open' && pickupDay(pickup) <= today && !ownedBy(pickup, memberId) &&
    isNobodyAvailable(state, pickup));
  const staged = state.pickups.map((pickup) => ({ pickup, stage: fallbackStage(state, pickup, now) }))
    .filter((item): item is { pickup: Pickup; stage: FallbackStage } => item.stage !== null);
  const fallback = staged.filter(({ pickup, stage }) => !ownedBy(pickup, memberId) && !dismissed.includes(fallbackKey(pickup, stage)))
    .sort((a, b) => Number(a.stage === 'acked') - Number(b.stage === 'acked') || (endedAt(state, b.pickup) ?? 0) - (endedAt(state, a.pickup) ?? 0));
  const ownFallback = staged.find(({ pickup, stage }) => ownedBy(pickup, memberId) && stage !== 'acked')?.pickup ?? null;
  const tomorrow = visible.filter((pickup) => pickup.status === 'open' && pickup.source === 'routine' && pickupDay(pickup) === tomorrowDay &&
    !ownedBy(pickup, memberId)).sort((a, b) => a.wantedAt - b.wantedAt);
  return { nobody, fallback, ownFallback, tomorrow };
}

/** A guardian closes one stage of a declaration card; an unacknowledged card closed early comes back at 5 minutes. */
export const fallbackKey = (pickup: Pickup, stage: FallbackStage) => `${pickup.id}:${stage}`;

/**
 * P-18 "대신 할 일" choices: the place's own note first (preselected), then the presets without repeating it. A pin or a
 * location without a saved place has only the presets (24.5).
 */
export function fallbackOptions(placeNote: string | null, presets: readonly string[]) {
  return [...(placeNote ? [{ note: placeNote, place: true }] : []),
    ...presets.filter((preset) => preset !== placeNote).map((note) => ({ note, place: false }))];
}

function runsOn(routine: Routine, day: string) {
  return routine.enabled && routine.days.includes(weekdayAt(dayAt(day, '12:00'))) &&
    (!routine.startDate || day >= routine.startDate) && (!routine.endDate || day <= routine.endDate);
}

/** The guardians who can drive a routine's pickups: its rider is never their own driver (23.3). */
function routineDrivers(state: DemoState, routine: Routine) {
  return state.members.filter((member) => member.canDrive && member.leftAt == null &&
    !(routine.requester.kind === 'member' && routine.requester.id === member.id)).map((member) => member.id);
}

/**
 * P-08 "이번엔 담당 없음": the routine runs today or tomorrow and its default driver marked that day off (24.5).
 */
export function routineGap(state: DemoState, routine: Routine, now: number): boolean {
  if (!routine.assigneeId) return false;
  const today = familyDate(now);
  return [today, addDays(today, 1)].some((day) => runsOn(routine, day) && unavailableOnDay(state, day).includes(routine.assigneeId));
}

export type DriverGap = { day: string; wantedAt: number; routine: Routine; pickup: Pickup | null; nobody: boolean };

/**
 * P-19 "갈 사람을 정해야 하는 픽업": routine days in the next `days` days whose default driver marked the day off. An
 * occurrence already made (today, tomorrow) is listed while it is still open; one somebody holds, or that ended, needs no
 * decision. "갈 수 있는 사람이 없어요" when every guardian who could drive it is off that day.
 */
export function driverGaps(state: DemoState, now: number, days = 14): DriverGap[] {
  const today = familyDate(now);
  const gaps: DriverGap[] = [];
  for (let index = 0; index < days; index++) {
    const day = addDays(today, index);
    const off = unavailableOnDay(state, day);
    for (const routine of state.routines) {
      if (!routine.assigneeId || !off.includes(routine.assigneeId) || !runsOn(routine, day)) continue;
      const pickup = state.pickups.find((item) => state.occurrences[item.id] === routine.id && pickupDay(item) === day) ?? null;
      const wantedAt = pickup?.wantedAt ?? dayAt(day, routine.time);
      if (pickup ? pickup.status !== 'open' : wantedAt < now) continue;
      const nobody = pickup ? isNobodyAvailable(state, pickup) : routineDrivers(state, routine).every((id) => off.includes(id));
      gaps.push({ day, wantedAt, routine, pickup, nobody });
    }
  }
  return gaps.sort((a, b) => a.wantedAt - b.wantedAt);
}

/** P-19 grid: today and the next 13 days. */
export function unavailableGrid(now: number, days = 14) {
  const today = familyDate(now);
  return Array.from({ length: days }, (_, index) => addDays(today, index));
}
