import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPickupAction,
  declineFromVehicle,
  guidanceAfter,
  newOccurrencePickup,
  newRequestPickup,
  reviseOccurrence,
  sweepPickup,
} from "../src/index.ts";
import type { Actor, Destination, Member, Pickup, PickupContext, PickupResult, Vehicle } from "../src/index.ts";

const minute = 60_000;
const now = Date.UTC(2026, 10, 9, 8);
const familyId = "family";
const mom = { kind: "member", id: "mom" } as const;
const dad = { kind: "member", id: "dad" } as const;
const rider = { kind: "rider", id: "minjun" } as const;
const car = { kind: "vehicle", id: "car", driverId: dad.id, parked: true } as const;
const members: Member[] = [
  { id: mom.id, familyId, canDrive: true, canRequest: true },
  { id: dad.id, familyId, canDrive: true, canRequest: true },
  { id: "aunt", familyId, canDrive: false, canRequest: true },
];
const vehicles: Vehicle[] = [{ id: car.id, familyId, currentDriverId: dad.id }];
const context: PickupContext = { now, members, vehicles };
const academy: Destination = { source: "saved_place", lat: 37.5001, lng: 127.0371, label: "수학학원", confirmed: true, placeId: "academy" };
const home: Destination = { source: "saved_place", lat: 37.5222, lng: 127.0465, label: "집", confirmed: true, placeId: "home" };

function request(overrides: Partial<Pickup> = {}): Pickup {
  return { ...newRequestPickup({ id: "p", familyId, requester: rider, destination: academy, wantedAt: now }), ...overrides };
}

function occurrence(holder: { assigneeId: string | null; vehicleId: string | null }, wantedAt = now + 60 * minute): Pickup {
  return newOccurrencePickup({
    id: "r", familyId, requester: rider, destination: academy, wantedAt, notifyBeforeMin: 20, ...holder,
  }, context);
}

function ok(result: PickupResult): Pickup {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.pickup;
}

test("create_request: a request is open with a family-wide offer that lapses with it (4.3 #1, 4.4 #2)", () => {
  const pickup = request();
  assert.equal(pickup.status, "open");
  assert.deepEqual(pickup.offer, {
    id: "p:request", status: "pending", fromMemberId: null, toMemberId: null, expiresAt: now + 60 * minute, declinedBy: [],
  });
  const accepted = ok(applyPickupAction(pickup, mom, { type: "accept" }, context));
  assert.equal(accepted.offer?.status, "accepted");
  assert.equal(accepted.offer?.acceptedBy, mom.id);
  assert.equal(Boolean(accepted.customized), false);
});

test("ensure_occurrences: an occurrence goes to the eligible default driver and the car that driver drives", () => {
  const assigned = occurrence({ assigneeId: dad.id, vehicleId: car.id });
  assert.equal(assigned.status, "assigned");
  assert.equal(assigned.assignmentRound, 1);
  assert.equal(assigned.vehicleId, car.id);
  assert.equal(assigned.notifyBeforeMin, 20);
  assert.equal(assigned.offer, null);
  assert.equal(occurrence({ assigneeId: mom.id, vehicleId: car.id }).vehicleId, null);
  const noDriver = occurrence({ assigneeId: "aunt", vehicleId: null });
  assert.equal(noDriver.status, "open");
  assert.equal(noDriver.assigneeId, null);
  assert.equal(noDriver.assignmentRound, 0);
});

test("routine occurrences are customized once someone takes or changes them, as is_customized", () => {
  const routine = occurrence({ assigneeId: dad.id, vehicleId: car.id });
  assert.equal(ok(applyPickupAction(routine, dad, { type: "accept" }, context)).customized, true);
  assert.equal(ok(applyPickupAction(routine, dad, { type: "offer", expectedVersion: 1, offerId: "o", toMemberId: mom.id }, context))
    .customized, true);
  assert.equal(ok(applyPickupAction(routine, mom, { type: "take_over", expectedVersion: 1 }, context)).customized, true);
  assert.equal(ok(applyPickupAction(routine, mom, { type: "confirm_location", expectedVersion: 1, destination: home }, context))
    .customized, true);
  assert.equal(Boolean(ok(applyPickupAction(routine, dad, { type: "depart", expectedVersion: 1 }, context)).customized), false);
  assert.equal(Boolean(ok(applyPickupAction(routine, rider, { type: "ready", expectedVersion: 1 }, context)).customized), false);
});

test("run_escalations: expiry, offer expiry, closing unconfirmed after 3 hours", () => {
  const expired = sweepPickup(request(), { ...context, now: now + 60 * minute });
  assert.deepEqual(expired.events, ["expired"]);
  assert.equal(expired.pickup.status, "expired");
  assert.equal(expired.pickup.offer?.status, "expired");
  assert.deepEqual(sweepPickup(request(), { ...context, now: now + 59 * minute }).events, []);

  const handoff = ok(applyPickupAction(occurrence({ assigneeId: mom.id, vehicleId: null }), mom,
    { type: "offer", expectedVersion: 1, offerId: "o", toMemberId: dad.id }, context));
  const lapsed = sweepPickup(handoff, { ...context, now: handoff.offer!.expiresAt });
  assert.deepEqual(lapsed.events, ["offer_expired"]);
  assert.equal(lapsed.pickup.offer?.status, "expired");
  assert.equal(lapsed.pickup.version, handoff.version);

  const arrived = { ...request(), status: "arrived" as const, assigneeId: dad.id, arrivedAt: now, offer: null };
  assert.deepEqual(sweepPickup(arrived, { ...context, now: now + 179 * minute }).events, []);
  const closed = sweepPickup(arrived, { ...context, now: now + 180 * minute });
  assert.deepEqual(closed.events, ["closed_unconfirmed"]);
  assert.equal(closed.pickup.status, "closed_unconfirmed");
});

test("run_escalations: an open occurrence is offered to every driver at its notify time, once (4.4 #4, A.4)", () => {
  const open = occurrence({ assigneeId: null, vehicleId: null }, now + 15 * minute);
  assert.equal(sweepPickup(open, { ...context, now: now - 10 * minute }).pickup, open);
  const announced = sweepPickup(open, context).pickup;
  assert.deepEqual(announced.offer, {
    id: "r:routine", status: "pending", fromMemberId: null, toMemberId: null, expiresAt: now + 15 * minute, declinedBy: [],
  });
  assert.equal(announced.routineOfferAt, now);
  assert.equal(announced.version, open.version);
  const lapsed = sweepPickup(announced, { ...context, now: now + 15 * minute });
  assert.equal(lapsed.pickup.offer?.status, "expired");
  assert.equal(sweepPickup(lapsed.pickup, { ...context, now: now + 16 * minute }).pickup.offer?.status, "expired");
  // "일찍 끝났어" already announced it, so the scheduler does not add another.
  const ready = ok(applyPickupAction(open, rider, { type: "ready", expectedVersion: 1 }, { ...context, now: now - 30 * minute }));
  assert.equal(ready.offer?.status, "pending");
  assert.equal(sweepPickup(ready, context).pickup.offer, ready.offer);
});

test("vehicle_decline on an open request records the refusal once; the last eligible driver closes the offer", () => {
  const first = declineFromVehicle(request(), car, { expectedVersion: 1, offerId: "x" }, context);
  assert.deepEqual(first.events, ["request_declined"]);
  assert.equal(ok(first).offer?.status, "pending");
  assert.deepEqual(ok(first).offer?.declinedBy, [dad.id]);
  assert.equal(ok(first).version, 1);
  const again = declineFromVehicle(ok(first), car, { expectedVersion: 1, offerId: "x" }, context);
  assert.deepEqual(again.events, []);
  // 4.3 #3: a driver who declined may still accept.
  assert.equal(ok(applyPickupAction(ok(first), dad, { type: "accept" }, context)).assigneeId, dad.id);

  const momsRequest = request({ requester: mom });
  const last = ok(declineFromVehicle(momsRequest, car, { expectedVersion: 1, offerId: "x" }, context));
  assert.equal(last.offer?.status, "declined");
  assert.equal(last.status, "open");

  assert.equal(declineFromVehicle(request(), car, { expectedVersion: 2, offerId: "x" }, context).ok, false);
  const ownRequest = request({ requester: dad });
  const refused = declineFromVehicle(ownRequest, car, { expectedVersion: 1, offerId: "x" }, context);
  assert.equal(refused.ok ? "ok" : refused.code, "NOT_FOUND");
  const noDriver: PickupContext = { ...context, members: members.map((m) => m.id === dad.id ? { ...m, canDrive: false } : m) };
  const forbidden = declineFromVehicle(request(), car, { expectedVersion: 1, offerId: "x" }, noDriver);
  assert.equal(forbidden.ok ? "ok" : forbidden.code, "FORBIDDEN");
});

test("vehicle_decline on the driver's own trip offers it to everyone; on a handoff to the driver it declines", () => {
  const own = occurrence({ assigneeId: dad.id, vehicleId: car.id });
  const offered = declineFromVehicle(own, car, { expectedVersion: 1, offerId: "car-offer" }, context);
  assert.deepEqual(offered.events, ["offered"]);
  assert.deepEqual({ ...ok(offered).offer, expiresAt: 0 }, {
    id: "car-offer", status: "pending", fromMemberId: dad.id, toMemberId: null, expiresAt: 0, note: undefined, declinedBy: [],
  });
  assert.equal(ok(offered).assigneeId, dad.id);

  const momsTrip = ok(applyPickupAction(occurrence({ assigneeId: mom.id, vehicleId: null }), mom,
    { type: "offer", expectedVersion: 1, offerId: "o", toMemberId: dad.id }, context));
  const declined = declineFromVehicle(momsTrip, car, { expectedVersion: 1, offerId: "unused" }, context);
  assert.deepEqual(declined.events, ["offer_declined"]);
  assert.equal(ok(declined).offer?.status, "declined");
  const none = declineFromVehicle(ok(declined), car, { expectedVersion: 1, offerId: "unused" }, context);
  assert.equal(none.ok ? "ok" : none.code, "OFFER_NOT_PENDING");
});

test("revise_routine: a non-customized occurrence follows the routine; a new holder withdraws the family offer (4.4 #12)", () => {
  const open = sweepPickup(occurrence({ assigneeId: null, vehicleId: null }, now + 15 * minute), context).pickup;
  const plan = { wantedAt: open.wantedAt, destination: academy, assigneeId: dad.id, vehicleId: car.id, notifyBeforeMin: 20 };
  const result = reviseOccurrence(open, plan, context);
  assert.deepEqual(result.events, ["routine_reassigned"]);
  assert.equal(result.pickup.status, "assigned");
  assert.equal(result.pickup.assigneeId, dad.id);
  assert.equal(result.pickup.vehicleId, car.id);
  assert.equal(result.pickup.assignmentRound, 1);
  assert.equal(result.pickup.version, open.version + 1);
  assert.equal(result.pickup.offer?.status, "cancelled");
  assert.equal(result.pickup.routineOfferAt, now);

  const assigned = result.pickup;
  const moved = reviseOccurrence(assigned, { ...plan, wantedAt: plan.wantedAt + 30 * minute, destination: home }, context);
  assert.deepEqual(moved.events, []);
  assert.equal(moved.pickup.wantedAt, plan.wantedAt + 30 * minute);
  assert.equal(moved.pickup.destinationRevision, assigned.destinationRevision + 1);
  assert.equal(moved.pickup.version, assigned.version + 1);
  assert.equal(moved.pickup.assignmentRound, assigned.assignmentRound);
  assert.equal(reviseOccurrence(assigned, plan, context).pickup.version, assigned.version);

  const cancelled = reviseOccurrence(assigned, null, context);
  assert.deepEqual(cancelled.events, ["cancelled"]);
  assert.equal(cancelled.pickup.status, "cancelled");
  assert.equal(reviseOccurrence(assigned, { ...plan, wantedAt: now - minute }, context).pickup.status, "cancelled");
});

test("revise_routine leaves customized, past and started occurrences alone, but they follow notify_before_min", () => {
  const routine = occurrence({ assigneeId: dad.id, vehicleId: car.id });
  const accepted = ok(applyPickupAction(routine, dad, { type: "accept" }, context));
  const plan = { wantedAt: routine.wantedAt, destination: home, assigneeId: mom.id, vehicleId: null, notifyBeforeMin: 45 };
  const kept = reviseOccurrence(accepted, plan, context);
  assert.deepEqual(kept.events, []);
  assert.equal(kept.pickup.assigneeId, dad.id);
  assert.equal(kept.pickup.version, accepted.version);
  assert.equal(kept.pickup.notifyBeforeMin, 45);
  assert.equal(reviseOccurrence(accepted, null, context).pickup.status, "assigned");
  const departed = ok(applyPickupAction(routine, dad, { type: "depart", expectedVersion: 1 }, context));
  assert.equal(reviseOccurrence(departed, plan, context).pickup.assigneeId, dad.id);
  assert.equal(reviseOccurrence(routine, plan, { ...context, now: routine.wantedAt + minute }).pickup.assigneeId, dad.id);
});

test("a car's one active guidance follows its start, and ends with the pickup or an undone departure (8.3.1)", () => {
  const start = applyPickupAction(request(), car, { type: "vehicle_start", expectedVersion: 1, actionId: "a", sessionId: "s" },
    context);
  const guidance = guidanceAfter(vehicles[0], car, { type: "vehicle_start" }, start);
  assert.deepEqual(guidance, { activePickupId: "p", activeSessionId: "s", activeDestinationRevision: 1 });
  const guided = { ...vehicles[0], ...guidance };
  const undone = applyPickupAction(start.pickup, dad, { type: "undo_en_route", expectedVersion: 2 }, context);
  assert.deepEqual(guidanceAfter(guided, dad, { type: "undo_en_route" }, undone),
    { activePickupId: null, activeSessionId: null, activeDestinationRevision: null });
  const actor: Actor = rider;
  const cancelled = applyPickupAction(start.pickup, actor, { type: "cancel", expectedVersion: 2 }, context);
  assert.equal(guidanceAfter(guided, actor, { type: "cancel" }, cancelled)?.activePickupId, null);
  const ignored = applyPickupAction(start.pickup, car, { type: "arrive", source: "nav_callback", sessionId: "old", destinationRevision: 1 },
    { ...context, vehicles: [guided] });
  assert.equal(guidanceAfter(guided, car, { type: "arrive" }, ignored), null);
});
