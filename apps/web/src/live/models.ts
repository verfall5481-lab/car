import { z } from 'zod';
import type { Pickup, PickupEvent, PickupOffer } from '@deriro/contracts';
import type { DemoState, DemoVehicle, History, Person } from '../demo-domain.ts';

const nullableId = z.string().nullish();
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const nullableDate = timestamp.nullish();
export const familyRow = z.object({ id: z.string(), name: z.string(), timezone: z.string().optional(), is_demo: z.boolean().optional(), demo_time_scale: z.number().optional() });
export const memberRow = z.object({
  id: z.string(), family_id: z.string().optional(), display_name: z.string(), role: z.enum(['owner', 'guardian']).optional(),
  can_drive: z.boolean().default(true), can_request: z.boolean().default(true), left_at: nullableDate,
  phone_e164: z.string().nullish(), sms_opt_in: z.boolean().optional(), location_consented_at: nullableDate,
});
export const deviceRow = z.object({ id: z.string(), rider_id: z.string().optional(), user_agent: z.string().nullish(), created_at: nullableDate, last_seen_at: nullableDate, revoked_at: nullableDate });
export const riderRow = z.object({
  id: z.string(), family_id: z.string().optional(), display_name: z.string(), kind: z.enum(['child', 'adult']), birth_year: z.number().nullish(),
  consent_basis: z.enum(['guardian', 'self']).optional(), location_consented_at: nullableDate, phone_e164: z.string().nullish(), archived_at: nullableDate,
  devices: z.array(deviceRow).optional(), device_count: z.number().int().optional(),
});
export const placeRow = z.object({ id: z.string(), family_id: z.string().optional(), label: z.string(), kind: z.string().optional(), lat: z.number(), lng: z.number(), radius_m: z.number().default(50), archived_at: nullableDate });
export const pointRow = z.object({ id: z.string(), family_id: z.string().optional(), place_id: z.string(), label: z.string(), lat: z.number(), lng: z.number(), note: z.string().nullish(), archived_at: nullableDate });
export const vehicleStateRow = z.object({ range_km: z.number().nullish(), fuel_pct: z.number().nullish(), soc_pct: z.number().nullish(), collected_at: nullableDate, is_demo_value: z.boolean().optional(), is_stale: z.boolean().optional() });
export const vehicleRow = z.object({ id: z.string(), family_id: z.string().optional(), nickname: z.string(), current_driver_member_id: nullableId,
  active_pickup_id: nullableId, active_nav_session_id: nullableId, active_destination_revision: z.number().nullish(), revoked_at: nullableDate,
  state: vehicleStateRow.nullish(), vehicle_state: vehicleStateRow.nullish(),
});
export const routineRow = z.object({ id: z.string(), rider_id: nullableId, rider_member_id: nullableId, place_id: z.string(), pickup_point_id: nullableId,
  weekdays: z.number().int().min(1).max(127), time_local: z.string(), notify_before_min: z.number(), default_assignee_member_id: nullableId,
  default_vehicle_id: nullableId, start_date: z.string(), end_date: z.string().nullish(), archived_at: nullableDate, is_active: z.boolean().optional(), active: z.boolean().optional(),
});
export const offerRow = z.object({
  id: z.string(), pickup_id: z.string().optional(), status: z.enum(['pending', 'accepted', 'declined', 'expired', 'cancelled', 'superseded']),
  from_member_id: nullableId, to_member_id: nullableId, note: z.string().nullish(), expires_at: timestamp, resolved_by_member_id: nullableId,
  declined_by: z.array(z.string()).optional(),
});
export const pickupRow = z.object({
  id: z.string(), family_id: z.string().optional(), rider_id: nullableId, rider_member_id: nullableId, rider_name: z.string().nullish(),
  status: z.enum(['open', 'assigned', 'en_route', 'arrived', 'completed', 'cancelled', 'expired', 'closed_unconfirmed']), source: z.enum(['request', 'routine']), routine_id: nullableId,
  assignee_member_id: nullableId, assignee_display_name: z.string().nullish(), vehicle_id: nullableId, place_id: nullableId, pickup_point_id: nullableId,
  location_source: z.enum(['saved_place', 'saved_point', 'map_pin', 'gps']).optional(), location_confirmed: z.boolean().optional(),
  dest_lat: z.number().optional(), dest_lng: z.number().optional(), dest_label: z.string(), pin_note: z.string().nullish(),
  version: z.number().int(), assignment_round: z.number().int().optional(), destination_revision: z.number().int().optional(),
  nav_session_id: nullableId, nav_destination_revision: z.number().nullish(), last_start_action_id: nullableId,
  wanted_at: timestamp, created_at: nullableDate, requested_at: nullableDate, accepted_at: nullableDate, en_route_at: nullableDate,
  arrived_at: nullableDate, completed_at: nullableDate, cancelled_at: nullableDate, expired_at: nullableDate, closed_unconfirmed_at: nullableDate, updated_at: nullableDate, rider_ready_at: nullableDate, not_met_reported_at: nullableDate,
  can_report_not_met: z.boolean().optional(), can_ready_early: z.boolean().optional(), can_cancel: z.boolean().optional(),
  offer: offerRow.nullish(), offers: z.array(offerRow).optional(), escalation_stage: z.number().optional(),
});
const pickupWithOffer = z.union([pickupRow, z.object({ pickup: pickupRow, offer: offerRow.nullish() }).transform(({ pickup, offer }) => ({ ...pickup, offer }))]);
const guardianPickupRow = pickupRow.required({ dest_lat: true, dest_lng: true, location_source: true, location_confirmed: true });
const eventRow = z.object({ pickup_id: z.string().optional(), event_type: z.string(), actor_id: nullableId, created_at: timestamp, payload: z.record(z.string(), z.unknown()).optional() });
const alertRow = z.object({ id: z.string(), vehicle_id: z.string(), required_km: z.number().nullish(), range_km: z.number().nullish(), acknowledged_at: nullableDate, resolved_at: nullableDate });
export const overviewSchema = z.object({ family: familyRow, me: memberRow, members: z.array(memberRow), riders: z.array(riderRow), vehicles: z.array(vehicleRow), places: z.array(placeRow),
  pickup_points: z.array(pointRow).default([]), routines: z.array(routineRow).default([]), rider_devices: z.array(deviceRow).default([]), setup_checklist: z.unknown().optional(),
  consents: z.array(z.object({ purpose: z.enum(['privacy', 'member_location', 'rider_location']), granted_at: nullableDate, version: z.string().optional() })).default([]),
}).transform((row) => ({ ...row, devices: row.rider_devices }));
export const todaySchema = z.object({ active: z.array(guardianPickupRow), timeline: z.array(guardianPickupRow), pending_offers_to_me: z.array(offerRow).default([]), alerts: z.array(alertRow).default([]), server_time: nullableDate,
  notification_failures: z.object({ sms_failed: z.number().int().nonnegative() }).optional(),
});
const rangeSummary = z.object({ required_km: z.number().nullish(), range_km: z.number().nullish(), verdict: z.string().optional(), computable: z.number().optional(), total: z.number().optional(), origin_source: z.string().nullish() });
export const pickupSchema = z.object({ pickup: guardianPickupRow, offers: z.array(offerRow).default([]), events: z.array(eventRow).default([]), assignee: memberRow.nullish(), vehicle: vehicleRow.nullish(), vehicle_state: vehicleStateRow.nullish(), required_km: z.number().nullish(), range: rangeSummary.nullish() });
export const riderStateSchema = z.object({
  rider: riderRow, callable_guardians: z.array(z.object({ id: z.string().optional(), display_name: z.string(), phone_e164: z.string() })),
  places: z.array(placeRow), pickup_points: z.array(pointRow).default([]), actives: z.array(pickupWithOffer), today: z.array(pickupWithOffer), server_time: timestamp,
});
export const inviteSchema = z.object({ code: z.string(), url: z.string(), expires_at: timestamp });
export const claimSchema = z.union([z.object({ rider: riderRow }), z.object({ needs_switch_confirm: z.object({ from: z.string().optional(), to: z.string().optional() }) })]);
export type Overview = z.infer<typeof overviewSchema>;
export type Today = z.infer<typeof todaySchema>;
export type PickupDetailData = z.infer<typeof pickupSchema>;
export type RiderState = z.infer<typeof riderStateSchema>;
export type VehicleRow = z.infer<typeof vehicleRow>;

const date = (value?: string | null) => value ? Date.parse(value) : null;
const distinct = <T extends { id: string }>(rows: T[]) => Array.from(new Map(rows.map((row) => [row.id, row])).values());

export function mapMember(row: z.infer<typeof memberRow>, familyId: string): Person {
  return { id: row.id, familyId, name: row.display_name, canDrive: row.can_drive, canRequest: row.can_request, leftAt: date(row.left_at), phone: row.phone_e164 ?? undefined };
}

// `resolved_by_member_id` names whoever closed the offer: the acceptor, but also whoever declined or withdrew it.
export function mapOffer(row: z.infer<typeof offerRow>): PickupOffer {
  const acceptedBy = row.status === 'accepted' ? row.resolved_by_member_id ?? undefined : undefined;
  return { id: row.id, fromMemberId: row.from_member_id ?? null, toMemberId: row.to_member_id ?? null, expiresAt: Date.parse(row.expires_at),
    status: row.status, note: row.note ?? undefined, declinedBy: row.declined_by ?? [], acceptedBy };
}

export function mapPickup(row: z.infer<typeof pickupRow>, familyId: string, requesterId?: string, offers: z.infer<typeof offerRow>[] = []): Pickup {
  const offer = row.offer ?? [...(row.offers ?? []), ...offers].filter((item) => item.pickup_id === row.id || item.pickup_id == null)
    .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || Date.parse(b.expires_at) - Date.parse(a.expires_at))[0];
  return {
    id: row.id, familyId, requester: row.rider_member_id ? { kind: 'member', id: row.rider_member_id } : { kind: 'rider', id: row.rider_id ?? requesterId ?? '' },
    source: row.source, status: row.status, version: row.version, assignmentRound: row.assignment_round ?? 0, assigneeId: row.assignee_member_id ?? row.assignee_display_name ?? null,
    vehicleId: row.vehicle_id ?? null, enRouteAt: date(row.en_route_at), destination: { label: row.dest_label, lat: row.dest_lat ?? 0, lng: row.dest_lng ?? 0, confirmed: row.location_confirmed ?? false,
      source: row.location_source ?? 'gps', note: row.pin_note ?? undefined, placeId: row.place_id ?? undefined, pickupPointId: row.pickup_point_id ?? undefined },
    destinationRevision: row.destination_revision ?? 1, wantedAt: Date.parse(row.wanted_at), acceptedAt: date(row.accepted_at), arrivedAt: date(row.arrived_at),
    navigation: row.nav_session_id ? { sessionId: row.nav_session_id, actionId: row.last_start_action_id ?? '', destinationRevision: row.nav_destination_revision ?? 1 } : null,
    offer: offer ? mapOffer(offer) : null, readyAt: date(row.rider_ready_at), notMetAt: date(row.not_met_reported_at),
  };
}

function mapVehicle(row: VehicleRow, familyId: string): DemoVehicle {
  const state = row.state ?? row.vehicle_state;
  return { id: row.id, familyId, name: row.nickname, currentDriverId: row.current_driver_member_id ?? null, activePickupId: row.active_pickup_id,
    activeSessionId: row.active_nav_session_id, activeDestinationRevision: row.active_destination_revision, range: state?.range_km ?? null,
    rangeCollectedAt: date(state?.collected_at), rangeStale: state?.is_stale, isDemoValue: state?.is_demo_value,
    parked: false, online: true, navFails: false, navError: false };
}

export function toPlaces(rows: z.infer<typeof placeRow>[], familyId: string) {
  return rows.map((row) => ({ id: row.id, familyId, label: row.label, kind: row.kind ?? 'other', lat: row.lat, lng: row.lng, radiusM: row.radius_m, archivedAt: date(row.archived_at) }));
}
function toPoints(rows: z.infer<typeof pointRow>[], familyId: string) {
  return rows.map((row) => ({ id: row.id, familyId, placeId: row.place_id, label: row.label, lat: row.lat, lng: row.lng, note: row.note ?? undefined, archivedAt: date(row.archived_at) }));
}

export function baseState(now = Date.now()): DemoState {
  return { schema: 1, startedAt: now, advance: 0, live: true, familyName: '', members: [], riders: [], places: [], points: [], routines: [], pickups: [], occurrences: {}, history: [],
    vehicle: { id: '', familyId: '', name: '', currentDriverId: null, range: null, parked: false, online: false, navFails: false, navError: false },
    vehicles: [], invite: { code: '', riderId: '', expiresAt: 0, used: true }, notifications: false, sms: false };
}

export function terminalTimes(rows: z.infer<typeof pickupRow>[]) {
  return Object.fromEntries(rows.flatMap((row) => {
    const at = date(row.completed_at ?? row.cancelled_at ?? row.expired_at ?? row.closed_unconfirmed_at);
    return at == null ? [] : [[row.id, at]];
  }));
}

const eventKinds: readonly (PickupEvent | 'requested' | 'nav_failed' | 'nav_ok' | 'request_declined')[] = ['requested', 'accepted', 'offered', 'offer_accepted', 'offer_declined', 'offer_cancelled', 'offer_expired', 'took_over', 'en_route', 'en_route_undone', 'navigation_requested', 'nav_failed', 'nav_ok', 'request_declined', 'arrived', 'arrival_ignored', 'completed', 'cancelled', 'expired', 'location_confirmed', 'rider_ready', 'not_met_reported', 'closed_unconfirmed'];
function mapEvent(event: z.infer<typeof eventRow>, id: string): History | null {
  const kind = event.event_type === 'created' ? 'requested' : eventKinds.find((key) => key === event.event_type);
  return kind ? { pickupId: event.pickup_id ?? id, at: Date.parse(event.created_at), event: kind, actor: event.actor_id ?? 'system' } : null;
}

export function guardianState(overview: Overview, today?: Today, detail?: PickupDetailData, receivedAt = Date.now()): DemoState {
  const familyId = overview.family.id;
  const rows = distinct([...(today?.active ?? []), ...(today?.timeline ?? []), ...(detail ? [detail.pickup] : [])]);
  const vehicles = overview.vehicles.filter((row) => !row.revoked_at).map((row) => mapVehicle(row, familyId));
  const history = detail ? detail.events.map((event) => mapEvent(event, detail.pickup.id)).filter((event) => event != null) : [];
  const base = baseState();
  return { ...base, advance: today?.server_time ? Date.parse(today.server_time) - receivedAt : 0, terminalAt: terminalTimes(rows), departureAt: Object.fromEntries(rows.flatMap((row) => row.en_route_at ? [[row.id, Date.parse(row.en_route_at)]] : [])), smsFailures: today?.notification_failures?.sms_failed,
    familyName: overview.family.name, members: overview.members.map((row) => mapMember(row, familyId)),
    riders: overview.riders.map((row) => ({ id: row.id, familyId, name: row.display_name, kind: row.kind, phone: row.phone_e164 ?? undefined, connected: Boolean(row.device_count || row.devices?.some((item) => !item.revoked_at) || overview.devices.some((item) => item.rider_id === row.id && !item.revoked_at)), archivedAt: date(row.archived_at) })),
    places: toPlaces(overview.places, familyId), points: toPoints(overview.pickup_points, familyId), vehicles, vehicle: vehicles[0] ?? base.vehicle,
    routines: overview.routines.map((row) => ({ id: row.id, requester: row.rider_member_id ? { kind: 'member', id: row.rider_member_id } : { kind: 'rider', id: row.rider_id ?? '' },
      placeId: row.place_id, time: row.time_local.slice(0, 5), days: Array.from({ length: 7 }, (_, index) => index).filter((index) => (row.weekdays & (1 << index)) !== 0),
      before: row.notify_before_min, enabled: !row.archived_at && (row.is_active ?? row.active ?? true), assigneeId: row.default_assignee_member_id ?? '', vehicleId: row.default_vehicle_id ?? '' })),
    pickups: rows.map((row) => mapPickup(row, familyId, undefined, [...(today?.pending_offers_to_me ?? []), ...(detail?.offers ?? [])])),
    occurrences: Object.fromEntries(rows.filter((row) => row.routine_id).map((row) => [row.id, row.routine_id!])), history,
  };
}

export function riderState(data: RiderState, receivedAt = Date.now()): DemoState {
  const familyId = data.rider.family_id ?? '';
  const rows = distinct([...data.today, ...data.actives]);
  const members: Person[] = data.callable_guardians.map((row) => ({ id: row.id ?? row.display_name, name: row.display_name, familyId, canDrive: true, canRequest: true, phone: row.phone_e164 }));
  for (const row of rows) {
    const id = row.assignee_member_id ?? row.assignee_display_name;
    if (id && row.assignee_display_name && !members.some((member) => member.id === id)) {
      members.push({ id, name: row.assignee_display_name, familyId, canDrive: true, canRequest: true });
    }
  }
  const local = baseState();
  return { ...local, advance: Date.parse(data.server_time) - receivedAt, terminalAt: terminalTimes(rows),
    pickupCapabilities: Object.fromEntries(rows.map((row) => [row.id, { cancel: row.can_cancel, notMet: row.can_report_not_met, ready: row.can_ready_early,
      escalation: row.escalation_stage, coordinates: row.dest_lat !== undefined && row.dest_lng !== undefined }])),
    members, riders: [{ id: data.rider.id, familyId, name: data.rider.display_name, kind: data.rider.kind, connected: true }],
    places: toPlaces(data.places, familyId), points: toPoints(data.pickup_points, familyId), pickups: rows.map((row) => mapPickup(row, familyId, data.rider.id)),
  };
}
