import { addDays, familyDate, isActivePickup } from '@deriro/contracts';
import type { Pickup, Requester } from '@deriro/contracts';
import { copy, dateLabel, spokenClock } from './copy.ts';
import { minute } from './demo-domain.ts';
import type { DemoState } from './demo-domain.ts';
import { endedAt, fallbackStage, isNobodyAvailable } from './guardian-view.ts';
import type { FallbackStage } from './guardian-view.ts';

/** C-03 state IDs (11장, 24.5) that change what the main area shows. */
export type RiderScreen =
  | 'idle' | 'routine_card' | 'open' | 'open_escalated' | 'open_nobody' | 'assigned' | 'en_route' | 'arrived' | 'completed'
  | 'cancelled' | 'expired' | 'closed_unconfirmed' | 'no_driver' | 'no_driver_acked';

const priority: Record<Pickup['status'], number> = { arrived: 0, en_route: 1, assigned: 2, open: 3, completed: 4, cancelled: 4, expired: 4, closed_unconfirmed: 4 };

/** A routine occurrence still waiting for its time: the rider sees it as the routine card, not as a request. */
export const scheduledOccurrence = (pickup: Pickup) => pickup.source === 'routine' && pickup.readyAt == null &&
  (pickup.status === 'open' || pickup.status === 'assigned');

/**
 * What C-03 shows for one requester (rider or requesting guardian).
 * - A request or a trip under way comes first (S-69: a new request replaces the declaration screen).
 * - A `no_driver` declaration comes next: `no_driver` until "알겠어", then `no_driver_acked` for 10 minutes. It is not
 *   bound by the 60-second rule and takes the place of the routine card (24.5).
 * - A routine occurrence waiting for its time shows as the routine card. Like `rider_get_state`'s `today`, only one from
 *   an hour before to three hours after now: tomorrow's occurrences are not the rider's business yet.
 * - Otherwise the last ended pickup for 60 seconds (`closed_unconfirmed` for 10 minutes), unless it was put away.
 * `different` is "다른 데야"; `dismissed` is the ended pickup the requester put away.
 */
export function riderView(state: DemoState, requester: Requester, now: number, { different = false, dismissed = null as string | null } = {}) {
  const own = state.pickups.filter((pickup) => pickup.requester.kind === requester.kind && pickup.requester.id === requester.id);
  const inWindow = (pickup: Pickup) => !scheduledOccurrence(pickup) || (pickup.wantedAt >= now - 60 * minute && pickup.wantedAt <= now + 180 * minute);
  const active = own.filter((pickup) => isActivePickup(pickup) && inWindow(pickup))
    .sort((a, b) => Number(scheduledOccurrence(a)) - Number(scheduledOccurrence(b)) || priority[a.status] - priority[b.status] || a.wantedAt - b.wantedAt);
  const declared = own.map((pickup) => ({ pickup, stage: fallbackStage(state, pickup, now) }))
    .filter((item): item is { pickup: Pickup; stage: FallbackStage } => item.stage !== null && !(item.stage === 'acked' && item.pickup.id === dismissed))
    .sort((a, b) => (endedAt(state, b.pickup) ?? 0) - (endedAt(state, a.pickup) ?? 0))[0];
  const latest = own.filter((pickup) => !isActivePickup(pickup) && pickup.cancelReason !== 'no_driver')
    .map((pickup) => ({ pickup, at: state.terminalAt?.[pickup.id] ?? state.history.find((event) => event.pickupId === pickup.id &&
      ['completed', 'cancelled', 'expired', 'closed_unconfirmed'].includes(event.event))?.at ?? 0 }))
    .filter(({ pickup, at }) => now - at < (pickup.status === 'closed_unconfirmed' ? 600_000 : 60_000)).sort((a, b) => b.at - a.at)[0]?.pickup;

  const started = active.find((pickup) => !scheduledOccurrence(pickup) && (!different || pickup.source === 'request'));
  const routine = different ? undefined : active.find(scheduledOccurrence);
  const current = started ?? declared?.pickup ?? routine ?? (!different && latest?.id !== dismissed ? latest : undefined);
  const secondary = active.filter((pickup) => pickup.id !== current?.id);

  const capabilities = current ? state.pickupCapabilities?.[current.id] : undefined;
  const requestedAt = current && state.history.find((event) => event.event === 'requested' && event.pickupId === current.id)?.at;
  const escalated = current?.status === 'open' && ((capabilities?.escalation ?? 0) > 0 || requestedAt != null && now >= requestedAt + 300_000);
  const nobody = current?.status === 'open' && isNobodyAvailable(state, current);
  const notMetRecent = current?.notMetAt != null && now < current.notMetAt + 300_000;
  const stage = current && current === declared?.pickup ? declared.stage : null;

  let screen: RiderScreen = 'idle';
  if (current && stage) screen = stage === 'acked' ? 'no_driver_acked' : 'no_driver';
  else if (current && current === routine) screen = 'routine_card';
  else if (current?.status === 'open') screen = nobody ? 'open_nobody' : escalated ? 'open_escalated' : 'open';
  else if (current) screen = current.status;

  // 5 minutes without "알겠어" grows the call buttons, as open_escalated does (24.5).
  const callEmphasized = screen === 'open_nobody' || screen === 'open_escalated' || notMetRecent || stage === 'unacked' ||
    screen === 'expired' || screen === 'closed_unconfirmed';
  return { current, secondary, screen, escalated: Boolean(escalated), callEmphasized, notMetRecent };
}

/**
 * The day words of "오늘은 데리러 못 가" (24.5): the pickup's date against the family's today. A declaration made ahead
 * for tomorrow's occurrence reads "내일 5시 30분은 데리러 못 가".
 */
export function declarationDay(pickup: Pickup, now: number): 'today' | 'tomorrow' | 'other' {
  const day = familyDate(pickup.wantedAt);
  const today = familyDate(now);
  return day === today ? 'today' : day === addDays(today, 1) ? 'tomorrow' : 'other';
}

/** The `no_driver` headline for the pickup's date. */
export function declarationTitle(pickup: Pickup, now: number) {
  const time = spokenClock(pickup.wantedAt);
  return { today: copy.noDriverToday, tomorrow: copy.noDriverTomorrow(time), other: copy.noDriverOn(dateLabel(pickup.wantedAt), time) }[declarationDay(pickup, now)];
}
