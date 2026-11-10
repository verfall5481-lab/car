import { isActivePickup, requestRecipients } from '@deriro/contracts';
import type { Pickup } from '@deriro/contracts';
import { minute, rangeEstimate } from './demo-domain.ts';
import type { DemoState } from './demo-domain.ts';

/** What the car screen remembers by itself: closed cards, seen handoff results and a closed range warning. */
export type VehicleMemory = {
  hidden: readonly string[];
  seenOffers: readonly string[];
  rangeSeen: boolean;
};

export type DepartureAlert = 'reminder' | 'not_departed';

/** V-07. `alertId` is set when the warning comes from the server and must be acknowledged there. */
export type RangeWarning = {
  requiredKm: number;
  rangeKm: number;
  alertId?: string;
  pickupCount?: number;
};

/** How the main button of a card behaves. `null` leaves the decision to the demo rules on the screen. */
export type CardPrimary = 'start' | 'accept' | null;

/**
 * V-02/V-03 card selection for one car.
 *
 * The demo derives every card from the shared browser store. In live mode `state.vehicleFeed` carries the
 * server's own card decisions (`vehicle_get_feed`, 8.4); wherever it is present it takes precedence, so the
 * browser never second-guesses which pickup this car may answer.
 */
export function vehicleView(state: DemoState, now: number, memory: VehicleMemory) {
  const { vehicle } = state;
  const server = state.vehicleFeed;
  const driverId = vehicle.currentDriverId ?? '';
  const serverCard = (pickup: Pickup) => server?.cards[pickup.id];
  const active = state.pickups.find((pickup) => pickup.id === vehicle.activePickupId);

  // Same as the server feed's `own`: the current driver's pickup that has no car yet or already uses this car.
  const mine = (pickup: Pickup) => Boolean(driverId) && pickup.assigneeId === driverId &&
    (pickup.vehicleId == null || pickup.vehicleId === vehicle.id);

  // F-12: an open request this driver declined stays closed on this car only.
  const declinedHere = (pickup: Pickup) =>
    state.history.some((item) => item.pickupId === pickup.id && item.event === 'request_declined' && item.actor === driverId) ||
    pickup.offer?.status === 'pending' && pickup.offer.declinedBy.includes(driverId);

  // V-03 부탁 카드: a pending handoff from another member that this driver may answer.
  const receivedOffer = (pickup: Pickup) => {
    const offer = pickup.offer;
    return offer?.status === 'pending' && offer.fromMemberId != null && offer.fromMemberId !== driverId &&
      (!offer.toMemberId || offer.toMemberId === driverId) && !offer.declinedBy.includes(driverId) ? offer : null;
  };

  // V-03 "내가 보낸 부탁이 만료됨": the driver still owns the pickup after nobody accepted.
  const unansweredOffer = (pickup: Pickup) => {
    const offer = pickup.offer;
    return mine(pickup) && pickup.status === 'assigned' && offer && offer.fromMemberId === driverId &&
      (offer.status === 'expired' || offer.status === 'declined') && !memory.seenOffers.includes(offer.id) ? offer : null;
  };

  // F-15: routine reminder and not-departed re-alert for the assigned car.
  const departureAlert = (pickup: Pickup): DepartureAlert | null => {
    if (server) {
      const kind = serverCard(pickup)?.kind;
      return kind === 'routine_reminder' ? 'reminder' : kind === 'not_departed' ? 'not_departed' : null;
    }
    if (!mine(pickup) || pickup.status !== 'assigned') return null;
    if (pickup.source === 'routine') {
      const before = state.routines.find((routine) => routine.id === state.occurrences[pickup.id])?.before ?? 20;
      return now >= pickup.wantedAt + 5 * minute ? 'not_departed' : now >= pickup.wantedAt - before * minute ? 'reminder' : null;
    }
    return now >= Math.max(pickup.wantedAt, pickup.acceptedAt ?? pickup.wantedAt) + 10 * minute ? 'not_departed' : null;
  };

  const cardRank = (pickup: Pickup) => {
    if (server) return serverCard(pickup) ? 0 : 2;
    return pickup.status === 'open' || receivedOffer(pickup) || unansweredOffer(pickup) ? 0 :
      pickup.readyAt != null && pickup.status === 'assigned' || departureAlert(pickup) ? 1 : 2;
  };
  // The server sorts its cards by priority. The demo has no order of its own, so every pickup ties here.
  const cardOrder = (pickup: Pickup) => serverCard(pickup)?.order ?? 0;

  const visible = state.pickups.filter((pickup) => {
    if (memory.hidden.includes(pickup.id)) return false;
    if (mine(pickup)) return true;
    // The live feed lists only what this car may answer, including declines it already recorded.
    if (server) return Boolean(serverCard(pickup));
    if (!requestRecipients(pickup, state.members, [vehicle]).vehicleIds.includes(vehicle.id)) return false;
    return pickup.status === 'open' ? !declinedHere(pickup) : Boolean(receivedOffer(pickup));
  });
  const pending = visible.filter(isActivePickup).sort((a, b) => cardRank(a) - cardRank(b) || cardOrder(a) - cardOrder(b) ||
    Number(a.source === 'routine') - Number(b.source === 'routine') || a.wantedAt - b.wantedAt);
  const cards = pending.filter((item) => cardRank(item) < 2);

  // V-03 cancelled_urgent: a trip this car had started and that was cancelled recently shows before any other card.
  const urgentCancel = server ?
    visible.find((item) => serverCard(item)?.kind === 'cancelled_urgent') :
    visible.find((item) => item.status === 'cancelled' && item.vehicleId === vehicle.id && item.enRouteAt != null &&
      state.history.some((event) => event.pickupId === item.id && event.event === 'cancelled' && event.at >= now - 30 * minute));
  const shownActive = active && !memory.hidden.includes(active.id) ? active : undefined;
  const pickup = urgentCancel ?? shownActive ?? pending[0] ?? visible.find((item) => item.status === 'completed' || item.status === 'cancelled');

  const requiredKm = (item: Pickup) => server ? serverCard(item)?.requiredKm ?? null : rangeEstimate(state, [item], vehicle).requiredKm;

  let rangeWarning: RangeWarning | null = null;
  if (server) {
    rangeWarning = server.alert ? { ...server.alert, alertId: server.alert.id } : null;
  } else {
    const upcoming = pending.filter((item) => item.vehicleId === vehicle.id && item.status === 'assigned' && item.wantedAt >= now &&
      item.wantedAt <= now + 1440 * minute);
    const range = rangeEstimate(state, upcoming, vehicle);
    if (range.verdict === 'low' && !memory.rangeSeen && range.requiredKm != null && vehicle.range != null) {
      rangeWarning = { requiredKm: range.requiredKm, rangeKm: vehicle.range };
    }
  }

  /** The server's main action for a card: "출발하고 안내" (or the parked location check before it), or "수락" only. */
  const primary = (item: Pickup): CardPrimary => {
    const action = serverCard(item)?.primary;
    if (action === 'accept') return 'accept';
    return action === 'start_now' || action === 'confirm_location' ? 'start' : null;
  };
  const routineOpen = (item: Pickup) => serverCard(item)?.kind === 'routine_open';

  return {
    driverId,
    active,
    visible,
    pending,
    cards,
    pickup,
    rangeWarning,
    receivedOffer,
    unansweredOffer,
    departureAlert,
    cardRank,
    requiredKm,
    primary,
    routineOpen,
  };
}

export type VehicleView = ReturnType<typeof vehicleView>;
