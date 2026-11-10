import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPickupAction,
  canRequestPickup,
  requestRecipients,
  resolveDestination,
} from "../src/index.ts";
import type { Actor, Member, Pickup, PickupAction, PickupContext, PickupResult, Vehicle } from "../src/index.ts";

const now = Date.UTC(2026, 10, 9, 8);
const familyId = "family";
const mom = { kind: "member", id: "mom" } satisfies Actor;
const dad = { kind: "member", id: "dad" } satisfies Actor;
const rider = { kind: "rider", id: "grandma" } satisfies Actor;
const car = { kind: "vehicle", id: "car", driverId: dad.id, parked: false } satisfies Actor;
const members: Member[] = [
  { id: mom.id, familyId, canDrive: true, canRequest: true },
  { id: dad.id, familyId, canDrive: true, canRequest: true },
  { id: "passenger", familyId, canDrive: false, canRequest: true },
  { id: "left", familyId, canDrive: true, canRequest: true, leftAt: now },
  { id: "foreign", familyId: "other", canDrive: true, canRequest: true },
];
const vehicles: Vehicle[] = [
  { id: car.id, familyId, currentDriverId: dad.id },
  { id: "mom-car", familyId, currentDriverId: mom.id },
  { id: "passenger-car", familyId, currentDriverId: "passenger" },
  { id: "foreign-car", familyId: "other", currentDriverId: "foreign" },
];
const context: PickupContext = { now, members, vehicles };

function pickup(overrides: Partial<Pickup> = {}): Pickup {
  return {
    id: "pickup", familyId, requester: rider, source: "request", status: "open", version: 1,
    assignmentRound: 0, assigneeId: null, vehicleId: null,
    destination: { source: "map_pin", lat: 37.5, lng: 127, label: "후문", note: "벤치", confirmed: true },
    destinationRevision: 1, wantedAt: now, acceptedAt: null, navigation: null,
    offer: { id: "request-offer", status: "pending", fromMemberId: null, toMemberId: null,
      expiresAt: now + 3_600_000, declinedBy: [] },
    readyAt: null, notMetAt: null,
    ...overrides,
  };
}

function act(current: Pickup, actor: Actor, action: PickupAction, ctx = context): PickupResult {
  return applyPickupAction(current, actor, action, ctx);
}

function successful(result: PickupResult): Pickup {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.pickup;
}

function rejected(result: PickupResult, code: string): Pickup {
  if (result.ok) assert.fail(`expected ${code}, received ${result.pickup.status}`);
  assert.equal(result.code, code);
  return result.pickup;
}

test("one acceptance wins and a repeat from that assignee does not add an event", () => {
  const open = pickup();
  const accepted = act(open, mom, { type: "accept" });
  const assigned = successful(accepted);
  assert.deepEqual(accepted.events, ["accepted"]);
  assert.equal(assigned.assigneeId, mom.id);
  assert.equal(assigned.version, 2);
  assert.equal(assigned.assignmentRound, 1);
  assert.equal(open.status, "open");
  rejected(act(assigned, dad, { type: "accept" }), "ALREADY_TAKEN");
  const retry = act(assigned, mom, { type: "accept" });
  assert.equal(successful(retry), assigned);
  assert.deepEqual(retry.events, []);
  const departed = successful(act(assigned, mom, { type: "depart", expectedVersion: 2 }));
  rejected(act(departed, dad, { type: "accept" }), "ALREADY_TAKEN");
});

test("a default routine assignment needs an explicit first acceptance and may depart early", () => {
  const routine = pickup({
    source: "routine", status: "assigned", assigneeId: dad.id, vehicleId: car.id, assignmentRound: 1,
    wantedAt: now + 30 * 60_000,
  });
  const accepted = successful(act(routine, dad, { type: "accept" }));
  assert.equal(accepted.acceptedAt, now);
  assert.equal(accepted.assignmentRound, 1);
  assert.equal(accepted.version, 2);
  const start = successful(act(accepted, car, { type: "vehicle_start", expectedVersion: 2, actionId: "action", sessionId: "session" }));
  assert.equal(start.status, "en_route");
  rejected(act(pickup({ wantedAt: routine.wantedAt }), car, {
    type: "vehicle_start", expectedVersion: 1, actionId: "action", sessionId: "session",
  }), "INVALID_STATE");
});

test("a handoff keeps its assignee until acceptance, and departure cancels a pending offer", () => {
  const assigned = successful(act(pickup(), mom, { type: "accept" }));
  const offered = successful(act(assigned, mom, { type: "offer", expectedVersion: 2, offerId: "handoff", toMemberId: dad.id }));
  assert.equal(offered.assigneeId, mom.id);
  assert.equal(offered.offer?.status, "pending");
  assert.equal(offered.version, 2);
  const handedOff = successful(act(offered, dad, { type: "respond_offer", expectedVersion: 2, offerId: "handoff", response: "accept" }));
  assert.equal(handedOff.assigneeId, dad.id);
  assert.equal(handedOff.offer?.status, "accepted");
  assert.equal(handedOff.assignmentRound, 2);
  rejected(act(handedOff, mom, { type: "depart", expectedVersion: 2 }), "STALE_VERSION");
  const departed = successful(act(offered, mom, { type: "depart", expectedVersion: 2 }));
  assert.equal(departed.assigneeId, mom.id);
  assert.equal(departed.offer?.status, "cancelled");
  rejected(act(departed, dad, { type: "respond_offer", expectedVersion: 3, offerId: "handoff", response: "accept" }), "OFFER_NOT_PENDING");
});

test("expiry is carried in a rejected result and must be persisted by the caller", () => {
  const expired = rejected(act(pickup({ wantedAt: now - 3_600_000 }), dad, { type: "accept" }), "PICKUP_EXPIRED");
  assert.equal(expired.status, "expired");
  assert.equal(expired.offer?.status, "expired");
  const assigned = successful(act(pickup(), mom, { type: "accept" }));
  const offered = successful(act(assigned, mom, { type: "offer", expectedVersion: 2, offerId: "offer", toMemberId: dad.id }));
  const response = act(offered, dad, { type: "respond_offer", expectedVersion: 2, offerId: "offer", response: "accept" },
    { ...context, now: offered.offer!.expiresAt });
  assert.equal(rejected(response, "OFFER_NOT_PENDING").offer?.status, "expired");
});

test("vehicle handoff starts a trip atomically and ignores stale navigation sessions", () => {
  const assigned = successful(act(pickup(), mom, { type: "accept" }));
  const offered = successful(act(assigned, mom, { type: "offer", expectedVersion: 2, offerId: "offer", toMemberId: dad.id }));
  const start = act(offered, car, { type: "vehicle_start", expectedVersion: 2, actionId: "action", sessionId: "session", offerId: "offer" });
  const departed = successful(start);
  assert.deepEqual(start.events, ["offer_accepted", "en_route"]);
  assert.equal(departed.assigneeId, dad.id);
  assert.equal(departed.vehicleId, car.id);
  const callback = { type: "arrive", source: "nav_callback", sessionId: "session", destinationRevision: 1 } as const;
  const activeVehicle = { ...vehicles[0], activePickupId: departed.id, activeSessionId: "session", activeDestinationRevision: 1 };
  const switched = { ...context, vehicles: [{ ...activeVehicle, activePickupId: "other-trip" }] };
  const ignored = act(departed, car, callback, switched);
  assert.equal(successful(ignored).status, "en_route");
  assert.deepEqual(ignored.events, ["arrival_ignored"]);

  const changed = successful(act(departed, dad, {
    type: "confirm_location", expectedVersion: 3, destination: { ...departed.destination, lng: 127.1 },
  }));
  assert.equal(changed.destinationRevision, 2);
  assert.equal(changed.assignmentRound, departed.assignmentRound);
  const active = { ...context, vehicles: [activeVehicle] };
  assert.deepEqual(act(changed, car, callback, active).events, ["arrival_ignored"]);
  assert.equal(successful(act(departed, car, callback, active)).status, "arrived");
});

test("manual arrival does not board and vehicle boarding requires parked mode", () => {
  const enRoute = pickup({ status: "en_route", version: 2, assigneeId: dad.id, vehicleId: car.id });
  rejected(act(enRoute, rider, { type: "board", expectedVersion: 2 }), "INVALID_STATE");
  const arrived = successful(act(enRoute, car, { type: "arrive", source: "manual", expectedVersion: 2 }));
  assert.equal(arrived.status, "arrived");
  rejected(act(arrived, car, { type: "board", expectedVersion: 3 }), "FORBIDDEN");
  assert.equal(successful(act(arrived, rider, { type: "board", expectedVersion: 3 })).status, "completed");
});

test("a driver can correct departure within five minutes without reopening a cancelled offer", () => {
  const assigned = successful(act(pickup(), dad, { type: "accept", vehicleId: car.id }));
  const offered = successful(act(assigned, dad, { type: "offer", expectedVersion: 2, offerId: "offer", toMemberId: mom.id }));
  const departed = successful(act(offered, car, {
    type: "vehicle_start", expectedVersion: 2, actionId: "action", sessionId: "session",
  }));
  const corrected = successful(act(departed, dad, { type: "undo_en_route", expectedVersion: 3 }, { ...context, now: now + 5 * 60_000 }));
  assert.equal(corrected.status, "assigned");
  assert.equal(corrected.assigneeId, dad.id);
  assert.equal(corrected.navigation, null);
  assert.equal(corrected.offer?.status, "cancelled");
  rejected(act(departed, dad, { type: "undo_en_route", expectedVersion: 3 }, { ...context, now: now + 5 * 60_000 + 1 }), "INVALID_STATE");
});

test("requester role and recipient fan-out exclude requester, non-drivers, departed and foreign members", () => {
  const memberRequest = pickup({ requester: mom });
  assert.deepEqual(requestRecipients(memberRequest, members, vehicles), { memberIds: [dad.id], vehicleIds: [car.id] });
  assert.deepEqual(requestRecipients(pickup(), members, vehicles), { memberIds: [mom.id, dad.id], vehicleIds: [car.id, "mom-car"] });
  assert.equal(canRequestPickup(rider, familyId, members, [{ id: rider.id, familyId }]), true);
  assert.equal(canRequestPickup(rider, familyId, members, [{ id: rider.id, familyId, archivedAt: now }]), false);
  assert.equal(canRequestPickup(mom, familyId, [{ ...members[0], canRequest: false }], []), false);
  assert.equal(canRequestPickup({ kind: "member", id: "passenger" }, familyId, members, []), true);
  rejected(act(memberRequest, mom, { type: "accept" }), "FORBIDDEN");
});

test("a pin and a saved point are confirmed, GPS must be accurate or explicitly confirmed", () => {
  const places = [
    { id: "own", familyId, lat: 37.5001, lng: 127, label: "병원" },
    { id: "other", familyId: "other", lat: 37.5, lng: 127, label: "다른 가족 장소" },
  ];
  const gps = { source: "gps", lat: 37.5, lng: 127 } as const;
  const snapped = resolveDestination(familyId, gps, places);
  assert.equal(snapped?.confirmed, true);
  assert.equal(snapped?.placeId, "own");
  const unconfirmed = resolveDestination(familyId, { ...gps, accuracyM: 901 }, places);
  assert.ok(unconfirmed);
  assert.equal(unconfirmed.confirmed, false);
  assert.equal(unconfirmed.placeId, undefined);
  const point = resolveDestination(familyId, { source: "saved_point", pickupPointId: "gate" }, places,
    [{ id: "gate", familyId, placeId: "own", lat: 37.501, lng: 127, label: "후문", note: "벤치" }]);
  assert.equal(point?.confirmed, true);
  assert.equal(point?.lat, 37.501);
  assert.equal(point?.note, "벤치");
  const pin = resolveDestination(familyId, { source: "map_pin", lat: 37.5, lng: 127, note: "벤치" }, places);
  assert.equal(pin?.confirmed, true);
  assert.equal(pin?.note, "벤치");
  assert.equal(resolveDestination(familyId, { source: "map_pin", lat: 37.5, lng: 127, currentLocation: { lat: 35.1, lng: 129 } }, places), null);
  const assigned = pickup({ status: "assigned", assigneeId: dad.id, destination: unconfirmed });
  rejected(act(assigned, dad, { type: "depart", expectedVersion: 1 }), "LOCATION_UNCONFIRMED");
  const confirmed = successful(act(assigned, dad, { type: "confirm_location", expectedVersion: 1, destination: unconfirmed }));
  assert.equal(confirmed.destination.confirmed, true);
  assert.equal(confirmed.destinationRevision, 1);
  assert.equal(successful(act(confirmed, dad, { type: "depart", expectedVersion: 2 })).status, "en_route");
});

test("4.4 #5/#9: the default assignee confirming a trip they offered away withdraws the offer, not accepts it", () => {
  const routine = pickup({
    source: "routine", status: "assigned", assigneeId: dad.id, vehicleId: car.id, assignmentRound: 1,
    wantedAt: now + 60 * 60_000, offer: null,
  });
  const offered = successful(act(routine, dad, { type: "offer", expectedVersion: 1, offerId: "handoff", toMemberId: mom.id }));
  const confirmed = act(offered, dad, { type: "accept" });
  const accepted = successful(confirmed);
  assert.deepEqual(confirmed.events, ["accepted"]);
  assert.equal(accepted.assigneeId, dad.id);
  assert.equal(accepted.acceptedAt, now);
  assert.equal(accepted.assignmentRound, 1);
  assert.equal(accepted.offer?.status, "cancelled");
  assert.equal(accepted.offer?.acceptedBy, undefined);
  rejected(act(accepted, mom, { type: "respond_offer", expectedVersion: 2, offerId: "handoff", response: "accept" }),
    "OFFER_NOT_PENDING");

  // The same for the car's "못 가요", which offers to everyone in the driver's name.
  const declined = successful(act(routine, car, { type: "offer", expectedVersion: 1, offerId: "car-offer" }));
  const byPhone = successful(act(declined, dad, { type: "accept" }));
  assert.equal(byPhone.offer?.status, "cancelled");
  assert.equal(byPhone.offer?.acceptedBy, undefined);

  // A family-wide request offer is still accepted by whoever takes the request.
  const taken = successful(act(pickup(), mom, { type: "accept" }));
  assert.equal(taken.offer?.status, "accepted");
  assert.equal(taken.offer?.acceptedBy, mom.id);
});

test("permission parity with SQL: lost can_drive keeps handoff, blocks departure; a car offers only to everyone", () => {
  const held = pickup({ status: "assigned", assigneeId: "passenger", acceptedAt: now, offer: null, version: 2 });
  rejected(act(held, { kind: "member", id: "passenger" }, { type: "depart", expectedVersion: 2 }), "FORBIDDEN");
  const handedOff = successful(act(held, { kind: "member", id: "passenger" }, { type: "offer", expectedVersion: 2, offerId: "o1", toMemberId: dad.id, note: "야근" }));
  assert.equal(handedOff.offer?.toMemberId, dad.id);
  assert.equal(handedOff.assigneeId, "passenger");
  const dads = pickup({ status: "assigned", assigneeId: dad.id, vehicleId: car.id, acceptedAt: now, offer: null, version: 2 });
  rejected(act(dads, car, { type: "offer", expectedVersion: 2, offerId: "o2", toMemberId: mom.id }), "FORBIDDEN");
  rejected(act(dads, car, { type: "offer", expectedVersion: 2, offerId: "o3", note: "못 가요" }), "FORBIDDEN");
  const toEveryone = successful(act(dads, car, { type: "offer", expectedVersion: 2, offerId: "o4" }));
  assert.equal(toEveryone.offer?.toMemberId, null);
});
