import { z } from 'zod';
import type { Pickup, PickupOffer } from '@deriro/contracts';
import { baseState, mapMember, mapPickup, memberRow, pickupRow, placeRow, terminalTimes, toPlaces } from './models.ts';
import type { DemoState, DemoVehicle, PairCode, Person, Rider, VehicleAlertFacts, VehicleCardFacts } from '../demo-domain.ts';

const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const nullableId = z.string().nullish();
const pairCode = /^[A-HJKMNP-Z2-9]{6}$/;

/** `vehicle_pair_start`: a 6-character code without 0/O/1/I/L, valid for 10 minutes (F-05). */
export const pairTicketSchema = z.object({ code: z.string(), url: z.string().optional(), expires_at: timestamp })
  .transform((row): PairCode => ({ code: row.code.replace('-', ''), expiresAt: Date.parse(row.expires_at) }))
  .refine((ticket) => pairCode.test(ticket.code));

export const pairStatusSchema = z.object({ paired: z.boolean(), vehicle: z.unknown().optional() });

const feedVehicle = z.object({
  id: z.string(),
  family_id: z.string(),
  nickname: z.string(),
  family_name: z.string().nullish(),
  current_driver_member_id: nullableId,
  current_driver: z.object({ id: nullableId, display_name: z.string().nullish() }).nullish(),
  active_pickup_id: nullableId,
  active_nav_session_id: nullableId,
  active_destination_revision: z.number().int().nullish(),
});
const feedCard = pickupRow.extend({
  kind: z.string(),
  pickup_id: z.string(),
  offer_id: nullableId,
  offer_note: z.string().nullish(),
  from_name: z.string().nullish(),
  primary_action: z.string().nullish(),
  secondary_action: z.string().nullish(),
  required_km: z.number().nullish(),
  accuracy_m: z.number().nullish(),
});
// `nav_session_id` and `destination_revision` are the car's active guidance, which a navigation callback must carry.
const activeTrip = pickupRow.extend({
  pickup_id: z.string(),
  nav_session_id: nullableId,
  destination_revision: z.number().int().nullish().transform((value) => value ?? undefined),
  nav_status: z.string().nullish(),
});
export const vehicleStateRowSchema = z.object({
  gear: z.string().nullish(),
  range_km: z.number().nullish(),
  collected_at: timestamp.nullish(),
  is_demo_value: z.boolean().optional(),
  is_stale: z.boolean().optional(),
});
const feedAlert = z.object({
  id: z.string(),
  range_km: z.number(),
  required_km: z.number(),
  pickup_count: z.number().int(),
  acknowledged_at: timestamp.nullish(),
  resolved_at: timestamp.nullish(),
});

/** `vehicle_get_feed` (8.4), checked against `supabase/tests/fixtures/vehicle_get_feed.json`. */
export const vehicleFeedSchema = z.object({
  vehicle: feedVehicle,
  drivers: z.array(memberRow).default([]),
  state: vehicleStateRowSchema.nullish(),
  range: z.object({ verdict: z.string().optional(), required_km: z.number().nullish(), range_km: z.number().nullish() }).nullish(),
  cards: z.array(feedCard).default([]),
  active_trip: activeTrip.nullish(),
  today: z.array(pickupRow).default([]),
  alerts: z.array(feedAlert).default([]),
  nearby_places: z.array(placeRow.extend({ distance_m: z.number().nullish() })).default([]),
  server_time: timestamp,
});
export type VehicleFeed = z.infer<typeof vehicleFeedSchema>;
export type ActiveTrip = z.infer<typeof activeTrip>;

export const vehicleStartSchema = z.object({
  pickup: pickupRow,
  nav_session_id: z.string(),
  destination_revision: z.number().int(),
  dest: z.object({ lat: z.number(), lng: z.number(), label: z.string(), note: z.string().nullish() }),
});
export const vehicleUpsertSchema = z.object({ state: vehicleStateRowSchema.nullish(), alert: z.unknown().optional() });

/** Errors after which this browser is no longer a paired vehicle. */
export const vehicleLinkErrors: ReadonlySet<string> = new Set(['NOT_VEHICLE', 'VEHICLE_REVOKED', 'NOT_AUTHENTICATED']);
/** The request may not have reached the server; resending the same action ID is safe. */
export const transientErrors: ReadonlySet<string> = new Set(['NETWORK', 'RETRY']);

/** What the web simulator pretends to read from the car. */
export type SimulatedVehicle = { parked: boolean; rangeKm: number };
export const simulatedNavError = 'WEB_SIMULATED_FAILURE';

/**
 * `upsert_vehicle_state`. The web simulator has no sensors, so every upload is flagged as a demo value and carries only
 * the simulated gear and range. Gear P lets the server's 30-second parked check pass for parked-only RPCs.
 */
export function vehicleStateParams(sim: SimulatedVehicle, collectedAt: Date) {
  return {
    p_gear: sim.parked ? 'P' : 'D',
    p_collected_at: collectedAt.toISOString(),
    p_range_km: sim.rangeKm,
    p_is_demo_value: true,
  };
}

/** `report_nav_result` for the simulated navigation outcome of one session. */
export function navResultParams(pickupId: string, sessionId: string, ok: boolean) {
  return {
    p_pickup_id: pickupId,
    p_nav_session_id: sessionId,
    p_result: ok ? 'ok' : 'failed',
    p_error_code: ok ? undefined : simulatedNavError,
  };
}

export const declineParams = (pickup: Pick<Pickup, 'id' | 'version'>) => ({ p_pickup_id: pickup.id, p_expected_version: pickup.version });
export const driverParams = (memberId: string) => ({ p_member_id: memberId });
export const alertParams = (alertId: string) => ({ p_alert_id: alertId });

const ownCardKinds = new Set(['child_ready', 'not_departed', 'routine_reminder']);
// A finished trip of this car stays on the screen for a short while, like the server's cancelled_urgent window.
const terminalWindowMs = 10 * 60_000;

type FeedRow = z.infer<typeof pickupRow>;
type FeedCard = z.infer<typeof feedCard>;

/**
 * The vehicle feed sends the offer behind a card as `offer_id`, `from_name` and `offer_note` only. The screen needs an
 * offer object, so this rebuilds the part the card kind implies. The server still validates every response.
 */
function cardOffer(card: FeedCard, driverId: string | null, fromId: string | null): PickupOffer | null {
  if (!card.offer_id) return null;
  // The feed does not send the expiry; the server checks it on every response.
  const base = { id: card.offer_id, expiresAt: Number.POSITIVE_INFINITY, declinedBy: [], note: card.offer_note ?? undefined };
  if (card.kind === 'offer_to_me') return { ...base, status: 'pending', fromMemberId: fromId, toMemberId: driverId };
  if (card.kind === 'offer_expired_mine') return { ...base, status: 'expired', fromMemberId: driverId, toMemberId: null };
  // Only the assignee can hand off an assigned pickup, so a pending offer on the driver's own card is the driver's.
  if (ownCardKinds.has(card.kind)) return { ...base, status: 'pending', fromMemberId: driverId, toMemberId: null };
  return { ...base, status: 'pending', fromMemberId: null, toMemberId: null };
}

function keepTodayRow(row: FeedRow, vehicleId: string, serverNow: number) {
  if (['open', 'assigned', 'en_route', 'arrived'].includes(row.status)) return true;
  const finished = row.completed_at ?? row.cancelled_at;
  return row.vehicle_id === vehicleId && finished != null && serverNow - Date.parse(finished) <= terminalWindowMs;
}

/**
 * Projects `vehicle_get_feed` into the shape `VehicleScreen` already renders, as `guardianState` and `riderState` do for
 * `/p/` and `/c/`. Gear and range come from the simulator (`sim`); everything else is the server's.
 */
export function vehicleState(feed: VehicleFeed, sim: SimulatedVehicle, online: boolean, receivedAt = Date.now()): DemoState {
  const familyId = feed.vehicle.family_id;
  const serverNow = Date.parse(feed.server_time);
  const driverId = feed.vehicle.current_driver_member_id ?? null;
  const members: Person[] = feed.drivers.filter((row) => !row.left_at).map((row) => mapMember(row, familyId));
  const riders: Rider[] = [];
  // Names the screen shows for people who are not current drivers (requesters, assignees, handoff senders).
  function person(id: string | null | undefined, name: string | null | undefined) {
    if (!id || !name || members.some((member) => member.id === id)) return;
    members.push({ id, familyId, name, canDrive: false, canRequest: false });
  }
  person(driverId, feed.vehicle.current_driver?.display_name);

  const trip = feed.active_trip && ['en_route', 'arrived'].includes(feed.active_trip.status) ? feed.active_trip : null;
  const rows = new Map<string, FeedRow>();
  for (const row of feed.today) {
    if (keepTodayRow(row, feed.vehicle.id, serverNow)) rows.set(row.id, row);
  }
  for (const card of feed.cards) rows.set(card.pickup_id, card);
  if (trip) rows.set(trip.pickup_id, trip);

  for (const row of rows.values()) {
    if (row.rider_id && !riders.some((rider) => rider.id === row.rider_id)) {
      riders.push({ id: row.rider_id, familyId, name: row.rider_name ?? '', kind: 'child', connected: true });
    }
    person(row.rider_member_id, row.rider_name);
    person(row.assignee_member_id, row.assignee_display_name);
  }

  const cards: Record<string, VehicleCardFacts> = {};
  const offers = new Map<string, PickupOffer | null>();
  feed.cards.forEach((card, order) => {
    cards[card.pickup_id] = {
      kind: card.kind,
      order,
      primary: card.primary_action ?? null,
      secondary: card.secondary_action ?? null,
      requiredKm: card.required_km ?? null,
      accuracyM: card.accuracy_m ?? null,
    };
    const sender = card.from_name ? members.find((member) => member.name === card.from_name)?.id ?? `offer-from:${card.offer_id}` : null;
    person(sender, card.from_name);
    offers.set(card.pickup_id, cardOffer(card, driverId, sender));
  });

  const pickups = Array.from(rows.values()).map((row) => {
    const pickup = mapPickup(row, familyId, row.rider_id ?? undefined);
    return offers.has(row.id) ? { ...pickup, offer: offers.get(row.id) ?? null } : pickup;
  });
  const open = feed.alerts.find((alert) => !alert.acknowledged_at && !alert.resolved_at);
  const alert: VehicleAlertFacts | null = open ?
    { id: open.id, requiredKm: open.required_km, rangeKm: open.range_km, pickupCount: open.pickup_count } :
    null;
  const vehicle: DemoVehicle = {
    id: feed.vehicle.id,
    familyId,
    name: feed.vehicle.nickname,
    currentDriverId: driverId,
    activePickupId: trip?.pickup_id ?? null,
    activeSessionId: trip?.nav_session_id ?? null,
    activeDestinationRevision: trip?.destination_revision ?? null,
    range: sim.rangeKm,
    rangeStale: false,
    isDemoValue: true,
    parked: sim.parked,
    online,
    navFails: false,
    // A failed navigation leaves the trip en route; only the guidance is retried (F-13).
    navError: trip?.status === 'en_route' && trip.nav_status === 'failed',
    revokedAt: null,
    pairing: null,
  };
  const base = baseState(receivedAt);
  return {
    ...base,
    advance: serverNow - receivedAt,
    familyName: feed.vehicle.family_name ?? '',
    members,
    riders,
    places: toPlaces(feed.nearby_places, familyId),
    pickups,
    terminalAt: terminalTimes(Array.from(rows.values())),
    vehicle,
    vehicles: [vehicle],
    vehicleFeed: { cards, alert },
  };
}

/** V-01 before or between pairings: no family data, only the code this browser holds. */
export function pairingState(ticket: PairCode | null, sim: SimulatedVehicle, online: boolean): DemoState {
  const base = baseState();
  return {
    ...base,
    vehicle: { ...base.vehicle, range: sim.rangeKm, parked: sim.parked, online, revokedAt: 0, pairing: ticket },
  };
}
