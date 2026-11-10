import { applyPickupAction, canRequestPickup, distanceMetres, isActivePickup, isCoordinates, requestRecipients, resolveDestination } from '@deriro/contracts';
import type { Actor, Coordinates, Destination, LocationInput, Member, Pickup, PickupAction, PickupEvent, PickupPoint, Place, Requester, Vehicle } from '@deriro/contracts';

export type Person = Member & { name: string; phone?: string };
export type Rider = { id: string; familyId: string; name: string; phone?: string; kind: 'child' | 'adult'; connected: boolean; archivedAt?: number | null };
export type DemoPlace = Place & { kind: string };
export type Routine = { id: string; requester: Requester; placeId: string; days: number[]; time: string; assigneeId: string; vehicleId: string; before: number; enabled: boolean };
export type History = { pickupId: string; at: number; event: PickupEvent | 'requested' | 'nav_failed' | 'nav_ok' | 'request_declined'; actor: string; detail?: string };
export type PairCode = { code: string; expiresAt: number };
export type DemoVehicle = Vehicle & { name: string; range: number | null; rangeCollectedAt?: number | null; rangeStale?: boolean; isDemoValue?: boolean; parked: boolean; online: boolean; navFails: boolean; navError: boolean;
  /** F-05: set while the car is not connected to a family; the car shows V-01 and receives no cards. */
  revokedAt?: number | null; pairing?: PairCode | null };
export type DemoState = {
  schema: 1; startedAt: number; advance: number; familyName: string; live?: boolean; vehicles?: DemoVehicle[]; terminalAt?: Record<string, number>; departureAt?: Record<string, number>;
  pickupCapabilities?: Record<string, { cancel?: boolean; notMet?: boolean; ready?: boolean; escalation?: number; coordinates?: boolean }>;
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
    schema: 1, startedAt, advance: 0, familyName: '우리 가족', notifications: true, sms: false,
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

function makePickup(id: string, requester: Requester, destination: Destination, wantedAt: number, source: Pickup['source'], assigneeId: string | null = null, vehicleId: string | null = null): Pickup {
  return { id, familyId, requester, destination, wantedAt, source, assigneeId, vehicleId, status: assigneeId ? 'assigned' : 'open', assignmentRound: assigneeId ? 1 : 0, version: 1, destinationRevision: 1, acceptedAt: null, navigation: null, offer: null, readyAt: null, notMetAt: null };
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

export function createRequest(state: DemoState, requester: Requester, location: LocationInput, minutes: number, now: number, id: string): Change {
  if (!canRequestPickup(requester, familyId, state.members, state.riders)) return fail(state, 'FORBIDDEN');
  if (!requestRecipients({ familyId, requester }, state.members, [state.vehicle]).memberIds.length) return fail(state, 'NO_DRIVER');
  if (state.pickups.some((p) => p.source === 'request' && p.requester.id === requester.id && isActivePickup(p))) return fail(state, 'ACTIVE_REQUEST');
  const destination = resolveDestination(familyId, location, state.places, state.points);
  if (!destination || ![0, 10, 20, 30].includes(minutes)) return fail(state, 'VALIDATION');
  const pickup = makePickup(id, requester, destination, now + minutes * minute, 'request');
  return changed({ ...state, pickups: [pickup, ...state.pickups], history: [{ at: now, pickupId: id, event: 'requested', actor: requester.id }, ...state.history] });
}

export function routineOccurrence(state: DemoState, routine: Routine, now: number, id: string): Change {
  if (!demoRoutinesToday(state, now).some((item) => item.id === routine.id)) return fail(state, 'ROUTINE_ALREADY');
  const destination = resolveDestination(familyId, { source: 'saved_place', placeId: routine.placeId }, state.places);
  if (!destination) return fail(state, 'VALIDATION');
  const wantedAt = routineWanted(routine, now);
  const pickup = makePickup(id, routine.requester, destination, wantedAt, 'routine', routine.assigneeId || null, routine.vehicleId || null);
  return changed({ ...state, pickups: [...state.pickups, pickup], occurrences: { ...state.occurrences, [id]: routine.id }, history: [{ at: now, pickupId: id, event: 'requested', actor: 'system' }, ...state.history] });
}

export type ActionOptions = { confirmedSwitch?: boolean; detail?: string };

export function applyDemoAction(state: DemoState, pickupId: string, actor: Actor, action: PickupAction, now: number, options: ActionOptions = {}): Change {
  const pickup = state.pickups.find(({ id }) => id === pickupId);
  if (!pickup) return fail(state, 'NOT_FOUND');
  if (actor.kind === 'vehicle' && (!vehiclePaired(state.vehicle) || actor.id !== state.vehicle.id)) return fail(state, 'FORBIDDEN');
  if (actor.kind === 'vehicle' && !state.vehicle.online) return fail(state, 'OFFLINE');
  if (action.type === 'vehicle_start' && state.vehicle.activePickupId && state.vehicle.activePickupId !== pickup.id && !options.confirmedSwitch) return fail(state, 'VEHICLE_BUSY');
  const result = applyPickupAction(pickup, actor, action, { now, members: state.members, vehicles: [state.vehicle] });
  if (result.pickup === pickup && !result.events.length) return result.ok ? { ok: true, state, ignored: result.ignored } : fail(state, result.code);
  let vehicle = state.vehicle;
  if (result.ok && action.type === 'vehicle_start' && result.pickup.navigation) {
    vehicle = { ...vehicle, activePickupId: pickup.id, activeSessionId: result.pickup.navigation.sessionId, activeDestinationRevision: result.pickup.destinationRevision, navError: vehicle.navFails };
  }
  if (vehicle.activePickupId === pickup.id && (!isActivePickup(result.pickup) || result.ok && action.type === 'undo_en_route')) {
    vehicle = { ...vehicle, activePickupId: null, activeSessionId: null, activeDestinationRevision: null, navError: false };
  }
  const actorId = actor.kind === 'vehicle' ? actor.driverId : actor.kind === 'system' ? 'system' : actor.id;
  const updated = { ...state, vehicle, pickups: state.pickups.map((p) => p.id === pickupId ? result.pickup : p), history: [
    ...result.events.filter((event) => event !== 'arrival_ignored' && event !== 'navigation_requested').map((event) => ({ pickupId, at: now, event, actor: actorId, detail: options.detail })), ...state.history,
  ] };
  return result.ok ? { ok: true, state: updated, ignored: result.ignored } : fail(updated, result.code);
}

export function setDemoTime(state: DemoState, now: number): DemoState {
  let next = state;
  for (const routine of demoRoutinesToday(state, now)) {
    const wantedAt = routineWanted(routine, now);
    if (now >= wantedAt - routine.before * minute && now < wantedAt + 60 * minute) {
      next = routineOccurrence(next, routine, now, `${routine.id}-${wantedAt}`).state;
    }
  }
  for (const pickup of next.pickups) {
    if (pickup.status === 'open' && now >= pickup.wantedAt + 60 * minute) {
      next = applyDemoAction(next, pickup.id, { kind: 'system' }, { type: 'expire' }, now).state;
    } else if (pickup.status === 'arrived' && pickup.arrivedAt != null && now >= pickup.arrivedAt + 180 * minute) {
      next = applyDemoAction(next, pickup.id, { kind: 'system' }, { type: 'close_unconfirmed' }, now).state;
    } else if (pickup.offer?.status === 'pending' && pickup.offer.expiresAt <= now) {
      next = {
        ...next,
        pickups: next.pickups.map((item) => item.id === pickup.id && item.offer ? { ...item, offer: { ...item.offer, status: 'expired' } } : item),
        history: [{ at: now, pickupId: pickup.id, event: 'offer_expired', actor: 'system' }, ...next.history],
      };
    }
  }
  return next;
}
