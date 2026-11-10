import {
  applyPickupAction, canRequestPickup, declineFromVehicle, distanceMetres, guidanceAfter, isActivePickup, isCoordinates,
  newOccurrencePickup, newRequestPickup, resolveDestination, reviseOccurrence, sweepPickup,
} from '@deriro/contracts';
import type {
  Actor, Coordinates, Destination, LocationInput, Member, OccurrencePlan, Pickup, PickupAction, PickupEvent, PickupPoint,
  PickupResult, Place, Requester, Vehicle,
} from '@deriro/contracts';

export type Person = Member & { name: string; phone?: string };
export type Rider = { id: string; familyId: string; name: string; phone?: string; kind: 'child' | 'adult'; connected: boolean; archivedAt?: number | null };
export type DemoPlace = Place & { kind: string };
export type Routine = { id: string; requester: Requester; placeId: string; days: number[]; time: string; assigneeId: string; vehicleId: string; before: number; enabled: boolean };
export type History = { pickupId: string; at: number; event: PickupEvent | 'requested' | 'nav_failed' | 'nav_ok' | 'request_declined'; actor: string; detail?: string };
export type PairCode = { code: string; expiresAt: number };
export type DemoVehicle = Vehicle & { name: string; range: number | null; rangeCollectedAt?: number | null; rangeStale?: boolean; isDemoValue?: boolean; parked: boolean; online: boolean; navFails: boolean; navError: boolean;
  /** F-05: set while the car is not connected to a family; the car shows V-01 and receives no cards. */
  revokedAt?: number | null; pairing?: PairCode | null };
/** One card of the live vehicle feed (8.4), as the server decided it. */
export type VehicleCardFacts = {
  kind: string;
  /** Position in the server's priority order. */
  order: number;
  primary: string | null;
  secondary: string | null;
  requiredKm: number | null;
  /** GPS accuracy of an unconfirmed location, when the server has it. */
  accuracyM: number | null;
};
/** V-07 warning from the live feed. The server returns it only while parked and short of range. */
export type VehicleAlertFacts = { id: string; requiredKm: number; rangeKm: number; pickupCount: number };
/** Live `/v/` only. The demo derives cards from its own data; the live feed already decided them. */
export type VehicleFeedFacts = { cards: Record<string, VehicleCardFacts>; alert: VehicleAlertFacts | null };
/**
 * 2: requests carry their family-wide offer and occurrences their notify time, as on the server. A stored demo of an
 * older schema starts afresh. Live states are never stored and keep 1.
 */
export const demoSchema = 2;
export type DemoState = {
  schema: 1 | typeof demoSchema; startedAt: number; advance: number; familyName: string; live?: boolean; vehicles?: DemoVehicle[]; terminalAt?: Record<string, number>; departureAt?: Record<string, number>;
  pickupCapabilities?: Record<string, { cancel?: boolean; notMet?: boolean; ready?: boolean; escalation?: number; coordinates?: boolean }>;
  vehicleFeed?: VehicleFeedFacts;
  smsFailures?: number;
  members: Person[]; riders: Rider[]; places: DemoPlace[]; points: PickupPoint[]; routines: Routine[];
  pickups: Pickup[]; occurrences: Record<string, string>; history: History[]; vehicle: DemoVehicle;
  invite: { code: string; riderId: string; expiresAt: number; used: boolean };
  notifications: boolean; sms: boolean;
};
export type Change = { ok: true; state: DemoState; ignored?: true } | { ok: false; state: DemoState; code: string };
export const minute = 60_000;
export const familyId = 'demo-family';
export const demoStart = Date.parse('2026-11-04T17:02:00+09:00');
export const exampleGps = { source: 'gps', lat: 37.4981, lng: 127.0441, accuracyM: 220, label: '역삼동 근처' } as const;

export function freshDemo(startedAt = Date.now()): DemoState {
  return {
    schema: demoSchema, startedAt, advance: 0, familyName: '우리 가족', notifications: true, sms: false,
    members: [
      { id: 'mom', familyId, name: '엄마', canDrive: true, canRequest: true },
      { id: 'dad', familyId, name: '아빠', canDrive: true, canRequest: true },
      { id: 'aunt', familyId, name: '이모', canDrive: false, canRequest: true },
    ],
    riders: [
      { id: 'minjun', familyId, name: '민준', kind: 'child', connected: true },
      { id: 'seoyeon', familyId, name: '서연', kind: 'child', connected: false },
      { id: 'grandma', familyId, name: '할머니', kind: 'adult', connected: true },
    ],
    places: [
      { id: 'academy', familyId, label: '수학학원', kind: '학원', lat: 37.5001, lng: 127.0371 },
      { id: 'school', familyId, label: '학교', kind: '학교', lat: 37.5010, lng: 127.0304 },
      { id: 'home', familyId, label: '집', kind: '집', lat: 37.5222, lng: 127.0465 },
      { id: 'piano', familyId, label: '피아노', kind: '학원', lat: 37.5050, lng: 127.0436 },
    ],
    points: [
      { id: 'front', familyId, placeId: 'academy', label: '정문', lat: 37.5001, lng: 127.0371 },
      { id: 'back', familyId, placeId: 'academy', label: '후문 주차장', note: '후문 벤치 앞', lat: 37.5006, lng: 127.0374 },
    ],
    routines: [
      { id: 'math', requester: { kind: 'rider', id: 'minjun' }, placeId: 'academy', days: [0, 2, 4], time: '17:30', assigneeId: 'dad', vehicleId: 'our-car', before: 20, enabled: true },
      { id: 'music', requester: { kind: 'rider', id: 'seoyeon' }, placeId: 'piano', days: [1, 3], time: '19:00', assigneeId: '', vehicleId: '', before: 20, enabled: true },
    ],
    vehicle: { id: 'our-car', familyId, name: '우리 차', currentDriverId: 'dad', range: 48, parked: true, online: true, navFails: false, navError: false },
    pickups: [], occurrences: {}, history: [], invite: { code: '48217730', riderId: 'minjun', expiresAt: demoStart + 10 * minute, used: false },
  };
}

export function demoNow(state: DemoState, wall = Date.now()) {
  return state.live ? wall + state.advance : demoStart + Math.max(wall - state.startedAt, 0) + state.advance;
}

export function weekdayAt(now: number) {
  return (new Date(now + 9 * 60 * minute).getUTCDay() + 6) % 7;
}

const day = 1440 * minute;
const koreanOffset = 9 * 60 * minute;
function dayStart(now: number) { return Math.floor((now + koreanOffset) / day) * day - koreanOffset; }
function routineWanted(routine: Routine, now: number) {
  const [hour, min] = routine.time.split(':').map(Number);
  return dayStart(now) + (hour * 60 + min) * minute;
}

export function demoRoutinesToday(state: DemoState, now: number) {
  return state.routines.filter((routine) => routine.enabled && routine.days.includes(weekdayAt(now)) &&
    !state.pickups.some((pickup) => state.occurrences[pickup.id] === routine.id && dayStart(pickup.wantedAt) === dayStart(now)));
}

export function nameOf(state: DemoState, id?: string | null) {
  return state.members.find((member) => member.id === id)?.name ?? state.riders.find((rider) => rider.id === id)?.name ?? '';
}

export function destinationLabel(state: DemoState, destination: Destination) {
  const place = state.places.find(({ id }) => id === destination.placeId);
  const names = destination.source === 'saved_point' && place ? [place.label, destination.label] : [destination.label];
  return [...names, destination.note].filter(Boolean).join(', ');
}

export function rangeEstimate(state: DemoState, pickups: readonly Pickup[], vehicle: DemoVehicle) {
  const origin = state.places.find((place) => ['home', '집'].includes(place.kind) && !place.archivedAt && isCoordinates(place));
  const total = pickups.length;
  let computable = 0;
  let distance = 0;
  for (const pickup of pickups) {
    if (!origin || state.pickupCapabilities?.[pickup.id]?.coordinates === false || !pickup.destination.confirmed || !isCoordinates(pickup.destination)) continue;
    distance += distanceMetres(origin, pickup.destination) * 0.0026;
    computable++;
  }
  const requiredKm = computable ? Math.round(distance * 10) / 10 : null;
  const available = vehicle.rangeStale ? null : vehicle.range;
  const low = requiredKm != null && available != null && available < requiredKm + Math.max(15, requiredKm * 0.2);
  const verdict = low ? 'low' : available != null && computable > 0 && computable === total ? 'sufficient' : 'check';
  return { requiredKm, computable, total, verdict };
}

export function nearbyPlaces(state: DemoState, point: Coordinates) {
  return state.places.filter((place) => !place.archivedAt && isCoordinates(place))
    .map((place) => ({ place, distance: distanceMetres(point, place) }))
    .sort((a, b) => a.distance - b.distance).slice(0, 2);
}

const fail = (state: DemoState, code: string): Change => ({ ok: false, code, state });
export const changed = (state: DemoState): Change => ({ ok: true, state });

// F-05: 6 characters without the confusable 0/O, 1/I/L; valid for 10 minutes.
const pairAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const pairCodeLength = 6;
export const normalizePairCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, pairCodeLength);
export const formatPairCode = (code: string) => code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
export const vehiclePaired = (vehicle: DemoVehicle) => vehicle.revokedAt == null;
export function newPairCode(now: number): PairCode {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(pairCodeLength)), (value) => pairAlphabet[value % pairAlphabet.length]).join('');
  return { code, expiresAt: now + 10 * minute };
}
const driverAllowed = (state: DemoState, memberId: string) => state.members.some((person) => person.id === memberId && person.canDrive && person.leftAt == null);

/** Mirrors `revoke_vehicle`: active pickups keep their assignee but lose the car, and routines drop it as default. */
export function unpairVehicle(state: DemoState, now: number): Change {
  const { vehicle } = state;
  if (!vehiclePaired(vehicle)) return changed(state);
  const active = new Set(['assigned', 'en_route', 'arrived']);
  return changed({
    ...state,
    vehicle: { ...vehicle, revokedAt: now, pairing: newPairCode(now), currentDriverId: null, activePickupId: null, activeSessionId: null, activeDestinationRevision: null, navError: false, range: null, rangeCollectedAt: null },
    pickups: state.pickups.map((pickup) => pickup.vehicleId === vehicle.id && active.has(pickup.status) ? { ...pickup, vehicleId: null, navigation: null } : pickup),
    routines: state.routines.map((routine) => routine.vehicleId === vehicle.id ? { ...routine, vehicleId: '' } : routine),
  });
}

export function renewPairCode(state: DemoState, now: number): Change {
  if (vehiclePaired(state.vehicle)) return fail(state, 'ALREADY_PAIRED');
  if (!state.vehicle.parked) return fail(state, 'FORBIDDEN');
  return changed({ ...state, vehicle: { ...state.vehicle, pairing: newPairCode(now) } });
}

/** Mirrors `vehicle_pair_confirm`: the guardian checks the code shown on the car, names it and picks who drives. */
export function pairVehicle(state: DemoState, code: string, name: string, driverId: string, now: number): Change {
  const { vehicle } = state;
  if (vehiclePaired(vehicle)) return fail(state, 'ALREADY_PAIRED');
  if (!vehicle.pairing || vehicle.pairing.code !== normalizePairCode(code)) return fail(state, 'CODE_INVALID');
  if (vehicle.pairing.expiresAt <= now) return fail(state, 'CODE_EXPIRED');
  const nickname = name.trim();
  if (!nickname || nickname.length > 20 || !driverAllowed(state, driverId)) return fail(state, 'VALIDATION');
  return changed({ ...state, vehicle: { ...vehicle, revokedAt: null, pairing: null, name: nickname, currentDriverId: driverId, range: 48, rangeCollectedAt: now, isDemoValue: true } });
}

/** Mirrors `vehicle_set_driver`; the demo also keeps the driver while a trip is being guided, as P-15 does. */
export function setVehicleDriver(state: DemoState, driverId: string): Change {
  if (!vehiclePaired(state.vehicle)) return fail(state, 'FORBIDDEN');
  if (state.vehicle.activePickupId) return fail(state, 'VEHICLE_BUSY');
  if (!driverAllowed(state, driverId)) return fail(state, 'NOT_FOUND');
  return changed({ ...state, vehicle: { ...state.vehicle, currentDriverId: driverId } });
}

/**
 * `rider_create_request` / `member_create_request`: an open request with its family-wide offer. Like the server, a
 * request is not refused when nobody can drive right now; it escalates and expires as any open request does (F-15).
 */
export function createRequest(state: DemoState, requester: Requester, location: LocationInput, minutes: number, now: number, id: string): Change {
  if (!canRequestPickup(requester, familyId, state.members, state.riders)) return fail(state, 'FORBIDDEN');
  if (state.pickups.some((p) => p.source === 'request' && p.requester.id === requester.id && isActivePickup(p))) return fail(state, 'ACTIVE_REQUEST');
  const destination = resolveDestination(familyId, location, state.places, state.points);
  if (!destination || ![0, 10, 20, 30].includes(minutes)) return fail(state, 'VALIDATION');
  const pickup = newRequestPickup({ id, familyId, requester, destination, wantedAt: now + minutes * minute });
  return changed({ ...state, pickups: [pickup, ...state.pickups], history: [{ at: now, pickupId: id, event: 'requested', actor: requester.id }, ...state.history] });
}

/** `ensure_occurrences` for today's occurrence of a routine. */
export function routineOccurrence(state: DemoState, routine: Routine, now: number, id: string): Change {
  if (!demoRoutinesToday(state, now).some((item) => item.id === routine.id)) return fail(state, 'ROUTINE_ALREADY');
  const destination = resolveDestination(familyId, { source: 'saved_place', placeId: routine.placeId }, state.places);
  if (!destination) return fail(state, 'VALIDATION');
  const pickup = newOccurrencePickup({
    id, familyId, requester: routine.requester, destination, wantedAt: routineWanted(routine, now),
    assigneeId: routine.assigneeId || null, vehicleId: routine.vehicleId || null, notifyBeforeMin: routine.before,
  }, { members: state.members, vehicles: [state.vehicle] });
  return changed({ ...state, pickups: [...state.pickups, pickup], occurrences: { ...state.occurrences, [id]: routine.id }, history: [{ at: now, pickupId: id, event: 'requested', actor: 'system' }, ...state.history] });
}

export type ActionOptions = { confirmedSwitch?: boolean; detail?: string };

function context(state: DemoState, now: number) {
  return { now, members: state.members, vehicles: [state.vehicle] };
}

/** Stores a result as the server would: the pickup (also when rejected), the car's guidance and the history rows. */
function record(state: DemoState, before: Pickup, actor: Actor, type: string, result: PickupResult, now: number, detail?: string): Change {
  if (result.pickup === before && !result.events.length) return result.ok ? { ok: true, state, ignored: result.ignored } : fail(state, result.code);
  const guidance = guidanceAfter(state.vehicle, actor, { type }, result);
  const vehicle = guidance ? { ...state.vehicle, ...guidance, navError: guidance.activePickupId ? state.vehicle.navFails : false } : state.vehicle;
  const actorId = actor.kind === 'vehicle' ? actor.driverId : actor.kind === 'system' ? 'system' : actor.id;
  const rows = result.events.filter((event) => event !== 'arrival_ignored' && event !== 'navigation_requested')
    .map((event) => ({ pickupId: before.id, at: now, event, actor: actorId, detail }));
  const updated = { ...state, vehicle, pickups: state.pickups.map((p) => p.id === before.id ? result.pickup : p), history: [...rows, ...state.history] };
  return result.ok ? { ok: true, state: updated, ignored: result.ignored } : fail(updated, result.code);
}

function vehicleRefusal(state: DemoState, actor: Actor): Change | null {
  if (actor.kind !== 'vehicle') return null;
  if (!vehiclePaired(state.vehicle) || actor.id !== state.vehicle.id) return fail(state, 'FORBIDDEN');
  return state.vehicle.online ? null : fail(state, 'OFFLINE');
}

export function applyDemoAction(state: DemoState, pickupId: string, actor: Actor, action: PickupAction, now: number, options: ActionOptions = {}): Change {
  const pickup = state.pickups.find(({ id }) => id === pickupId);
  if (!pickup) return fail(state, 'NOT_FOUND');
  const refused = vehicleRefusal(state, actor);
  if (refused) return refused;
  if (action.type === 'vehicle_start' && state.vehicle.activePickupId && state.vehicle.activePickupId !== pickup.id && !options.confirmedSwitch) return fail(state, 'VEHICLE_BUSY');
  const result = applyPickupAction(pickup, actor, action, context(state, now));
  return record(state, pickup, actor, action.type, result, now, options.detail);
}

/** F-12 "못 가요" from the car, as `vehicle_decline`. */
export function declineFromCar(state: DemoState, pickupId: string, actor: Actor, expectedVersion: number, now: number, offerId: string): Change {
  const pickup = state.pickups.find(({ id }) => id === pickupId);
  if (!pickup) return fail(state, 'NOT_FOUND');
  const refused = vehicleRefusal(state, actor);
  if (refused) return refused;
  const result = declineFromVehicle(pickup, actor, { expectedVersion, offerId }, context(state, now));
  return record(state, pickup, actor, 'vehicle_decline', result, now);
}

/** Where an occurrence of a routine goes now: its day at the routine's time and place, or nowhere. */
function occurrencePlan(state: DemoState, routine: Routine, pickup: Pickup): OccurrencePlan | null {
  if (!routine.days.includes(weekdayAt(pickup.wantedAt))) return null;
  const destination = resolveDestination(familyId, { source: 'saved_place', placeId: routine.placeId }, state.places);
  if (!destination) return null;
  return {
    wantedAt: routineWanted(routine, pickup.wantedAt), destination, requester: routine.requester,
    assigneeId: routine.assigneeId || null, vehicleId: routine.vehicleId || null, notifyBeforeMin: routine.before,
  };
}

/**
 * `revise_routine` after a routine is saved (`archived` when it is deleted): its non-customized upcoming occurrences
 * follow it or are cancelled by the system; occurrences someone accepted, handed off or changed stay (S-16, S-28).
 * A paused routine changes nothing, as on the server.
 */
export function reviseRoutine(state: DemoState, routine: Routine, now: number, archived = false): DemoState {
  if (!archived && !routine.enabled) return state;
  let next = state;
  for (const pickup of state.pickups) {
    if (state.occurrences[pickup.id] !== routine.id) continue;
    const plan = archived ? null : occurrencePlan(state, routine, pickup);
    next = record(next, pickup, { kind: 'system' }, 'revise_routine', reviseOccurrence(pickup, plan, context(next, now)), now).state;
  }
  return next;
}

/** `upsert_routine(active=false, cancel_future=true)`: this guardian skips every upcoming open or assigned occurrence. */
export function skipOccurrences(state: DemoState, routine: Routine, memberId: string, now: number): Change {
  let next = state;
  for (const pickup of state.pickups) {
    if (state.occurrences[pickup.id] !== routine.id || pickup.wantedAt < now || !['open', 'assigned'].includes(pickup.status)) continue;
    const cancel: PickupAction = { type: 'cancel', expectedVersion: pickup.version, reason: 'skipped' };
    const update = applyDemoAction(next, pickup.id, { kind: 'member', id: memberId }, cancel, now);
    if (!update.ok) return { ...update, state };
    next = update.state;
  }
  return changed(next);
}

/** The demo clock: today's occurrences at their notify time, then one scheduler pass over every pickup (9장). */
export function setDemoTime(state: DemoState, now: number): DemoState {
  let next = state;
  for (const routine of demoRoutinesToday(state, now)) {
    const wantedAt = routineWanted(routine, now);
    if (now >= wantedAt - routine.before * minute && now < wantedAt + 60 * minute) {
      next = routineOccurrence(next, routine, now, `${routine.id}-${wantedAt}`).state;
    }
  }
  for (const pickup of next.pickups) {
    next = record(next, pickup, { kind: 'system' }, 'sweep', sweepPickup(pickup, context(next, now)), now).state;
  }
  return next;
}
