// SPEC 24 "갈 사람이 없을 때": "못 간다고 알리기" (24.3 #20, #21), "알겠어" (#22), 갈 수 있는 운전자 and 못 가는 날.
import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  applyPickupAction,
  availableDrivers,
  declineFromVehicle,
  fallbackNoteText,
  familyDate,
  newOccurrencePickup,
  newRequestPickup,
  nobodyAvailable,
  reviseForUnavailableDay,
  reviseOccurrence,
  setUnavailableDay,
  sweepPickup,
  unavailableOn,
} from "../src/index.ts";
import type { Actor, Destination, Member, Pickup, PickupContext, PickupResult, Vehicle } from "../src/index.ts";

const minute = 60_000;
/** 17:00 on Friday 2026-11-13 in Seoul. */
const now = Date.UTC(2026, 10, 13, 8);
const familyId = "family";
const mom = { kind: "member", id: "mom" } as const;
const dad = { kind: "member", id: "dad" } as const;
const aunt = { kind: "member", id: "aunt" } as const;
const minjun = { kind: "rider", id: "minjun" } as const;
const car = { kind: "vehicle", id: "car", driverId: dad.id, parked: true } as const;
const members: Member[] = [
  { id: mom.id, familyId, canDrive: true, canRequest: true },
  { id: dad.id, familyId, canDrive: true, canRequest: true },
  { id: aunt.id, familyId, canDrive: false, canRequest: true },
];
const vehicles: Vehicle[] = [{ id: car.id, familyId, currentDriverId: dad.id }];
const context: PickupContext = { now, members, vehicles };
const academy: Destination = { source: "saved_place", lat: 37.5001, lng: 127.0371, label: "수학학원", confirmed: true, placeId: "academy" };
const today = familyDate(now);

function request(overrides: Partial<Pickup> = {}): Pickup {
  return { ...newRequestPickup({ id: "p", familyId, requester: minjun, destination: academy, wantedAt: now }), ...overrides };
}

function occurrence(assigneeId: string | null, ctx: PickupContext = context, wantedAt = now + 60 * minute): Pickup {
  return newOccurrencePickup({
    id: "r", familyId, requester: minjun, destination: academy, wantedAt, notifyBeforeMin: 20, assigneeId,
    vehicleId: assigneeId === dad.id ? car.id : null,
  }, ctx);
}

function ok(result: PickupResult): Pickup {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.pickup;
}

function code(result: PickupResult): string {
  return result.ok ? "ok" : result.code;
}

const declare = (version = 1, note = "학원 안에서 기다리기") => ({ type: "no_driver", expectedVersion: version, note }) as const;

test("24.3 #20, S-59: a guardian ends an open request with the line to do instead; the family offer is cancelled", () => {
  const result = applyPickupAction(request(), mom, declare(1, "  학원 안에서 기다리기  "), context);
  const cancelled = ok(result);
  assert.deepEqual(result.events, ["no_driver"]);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelReason, "no_driver");
  assert.equal(cancelled.fallbackNote, "학원 안에서 기다리기");
  assert.equal(cancelled.fallbackBy, mom.id);
  assert.equal(cancelled.fallbackAckAt, null);
  assert.equal(cancelled.offer?.status, "cancelled");
  assert.equal(cancelled.customized, true);
  assert.equal(cancelled.version, 2);
  assert.equal(cancelled.assigneeId, null);
  // A guardian who cannot drive may also tell the requester (24.3 #20 주체: 보호자).
  assert.equal(code(applyPickupAction(request(), aunt, declare(), context)), "ok");
});

test("24.3 #21, S-62, S-63: on an assigned trip only the assignee declares it; not once the trip has started", () => {
  const assigned = ok(applyPickupAction(request(), dad, { type: "accept" }, context));
  const refused = applyPickupAction(assigned, mom, declare(2), context);
  assert.equal(code(refused), "NOT_ASSIGNEE");
  assert.equal(refused.pickup.assigneeId, dad.id);
  const declared = ok(applyPickupAction(assigned, dad, declare(2), context));
  assert.equal(declared.status, "cancelled");
  assert.equal(declared.fallbackBy, dad.id);
  assert.equal(declared.assigneeId, dad.id);
  const enRoute = ok(applyPickupAction(assigned, dad, { type: "depart", expectedVersion: 2 }, context));
  assert.equal(code(applyPickupAction(enRoute, dad, declare(3), context)), "INVALID_STATE");
  const arrived = ok(applyPickupAction(enRoute, dad, { type: "arrive", source: "manual", expectedVersion: 3 }, context));
  assert.equal(code(applyPickupAction(arrived, dad, declare(4), context)), "INVALID_STATE");
  assert.equal(code(applyPickupAction(declared, dad, declare(3), context)), "INVALID_STATE");
  // A handoff in progress does not change who may declare it (책임 유지).
  const offered = ok(applyPickupAction(assigned, dad, { type: "offer", expectedVersion: 2, offerId: "h", toMemberId: mom.id }, context));
  assert.equal(code(applyPickupAction(offered, mom, declare(2), context)), "NOT_ASSIGNEE");
  const withOffer = ok(applyPickupAction(offered, dad, declare(2), context));
  assert.equal(withOffer.offer?.status, "cancelled");
});

test("24.3: the requester, a car, a rider and a stale version are refused; the note is 1-40 characters after trimming", () => {
  const guardianRequest = request({ requester: mom });
  assert.equal(code(applyPickupAction(guardianRequest, mom, declare(), context)), "FORBIDDEN");
  assert.equal(code(applyPickupAction(guardianRequest, dad, declare(), context)), "ok");
  assert.equal(code(applyPickupAction(request(), car, declare(), context)), "FORBIDDEN");
  assert.equal(code(applyPickupAction(request(), minjun, declare(), context)), "FORBIDDEN");
  // A car is refused whatever pickup it names, before the pickup is considered at all (S-64).
  assert.equal(code(applyPickupAction(request({ familyId: "other" }), car, declare(), context)), "FORBIDDEN");
  assert.equal(code(applyPickupAction(request(), { kind: "member", id: "stranger" }, declare(), context)), "NOT_FOUND");
  assert.equal(code(applyPickupAction(request(), mom, declare(2), context)), "STALE_VERSION");
  assert.equal(code(applyPickupAction(request(), mom, declare(1, "   "), context)), "VALIDATION");
  assert.equal(code(applyPickupAction(request(), mom, declare(1, "가".repeat(41)), context)), "VALIDATION");
  assert.equal(ok(applyPickupAction(request(), mom, declare(1, "가".repeat(40)), context)).fallbackNote, "가".repeat(40));
  assert.equal(fallbackNoteText(" \t셔틀 타기\n"), "셔틀 타기");
  assert.equal(fallbackNoteText(""), null);
  assert.equal(fallbackNoteText(undefined), null);
  // 4.5: an open pickup past wanted_at + 60 minutes expires instead.
  const late = applyPickupAction(request({ wantedAt: now - 60 * minute }), mom, declare(), context);
  assert.equal(code(late), "PICKUP_EXPIRED");
  assert.equal(late.pickup.status, "expired");
});

test("24.3 #22, S-60: the requester acknowledges once; a repeat changes neither the time nor the events", () => {
  const cancelled = ok(applyPickupAction(request(), mom, declare(), context));
  const first = applyPickupAction(cancelled, minjun, { type: "ack_fallback" }, { ...context, now: now + 2 * minute });
  const acked = ok(first);
  assert.deepEqual(first.events, ["fallback_acknowledged"]);
  assert.equal(acked.fallbackAckAt, now + 2 * minute);
  assert.equal(acked.version, cancelled.version);
  const again = applyPickupAction(acked, minjun, { type: "ack_fallback" }, { ...context, now: now + 9 * minute });
  assert.equal(ok(again), acked);
  assert.deepEqual(again.events, []);
  assert.equal(code(applyPickupAction(cancelled, mom, { type: "ack_fallback" }, context)), "FORBIDDEN");
  assert.equal(code(applyPickupAction(cancelled, car, { type: "ack_fallback" }, context)), "FORBIDDEN");
  assert.equal(code(applyPickupAction(cancelled, { kind: "rider", id: "seoyeon" }, { type: "ack_fallback" }, context)), "NOT_FOUND");
  // Only a no_driver cancellation can be acknowledged.
  const ordinary = ok(applyPickupAction(request(), mom, { type: "cancel", expectedVersion: 1 }, context));
  assert.equal(ordinary.cancelReason, "cancelled");
  assert.equal(code(applyPickupAction(ordinary, minjun, { type: "ack_fallback" }, context)), "INVALID_STATE");
  assert.equal(code(applyPickupAction(request(), minjun, { type: "ack_fallback" }, context)), "INVALID_STATE");
  // A guardian who requested acknowledges their own.
  const guardians = ok(applyPickupAction(request({ requester: mom }), dad, declare(), context));
  assert.equal(code(applyPickupAction(guardians, mom, { type: "ack_fallback" }, context)), "ok");
  assert.equal(code(applyPickupAction(guardians, dad, { type: "ack_fallback" }, context)), "FORBIDDEN");
});

test("cancel_reason follows the SQL mapping: aliases, a rider's own cancellation, skipped, routine archive", () => {
  const reason = (actor: Actor, action: Parameters<typeof applyPickupAction>[2], pickup = request()) =>
    ok(applyPickupAction(pickup, actor, action, context)).cancelReason;
  assert.equal(reason(minjun, { type: "cancel", expectedVersion: 1 }), "child_cancelled");
  assert.equal(reason(mom, { type: "cancel", expectedVersion: 1, reason: "phone_resolved" }), "resolved_by_phone");
  assert.equal(reason(mom, { type: "cancel", expectedVersion: 1, reason: "misclick" }), "mistake");
  assert.equal(reason(mom, { type: "cancel", expectedVersion: 1, reason: "other_transport" }), "other_way_home");
  assert.equal(reason(mom, { type: "cancel", expectedVersion: 1, reason: "skipped" }, occurrence(dad.id)), "skipped");
  assert.equal(reviseOccurrence(occurrence(dad.id), null, context).pickup.cancelReason, "routine_archived");
});

test("24.2: available drivers are the recipients minus the day's unavailable members and the family offer's decliners", () => {
  const open = request();
  assert.deepEqual(availableDrivers(open, members), [mom.id, dad.id]);
  assert.deepEqual(availableDrivers(open, members, [mom.id]), [dad.id]);
  assert.equal(nobodyAvailable(open, members, [mom.id]), false);
  // S-57: everyone who can drive marked today.
  assert.equal(nobodyAvailable(open, members, [mom.id, dad.id]), true);
  // S-58: dad's car says "못 가요" and mom cannot drive today; mom may still accept.
  const declined = ok(declineFromVehicle(open, car, { expectedVersion: 1, offerId: "x" }, context));
  assert.deepEqual(availableDrivers(declined, members), [mom.id]);
  assert.equal(nobodyAvailable(declined, members, [mom.id]), true);
  assert.equal(ok(applyPickupAction(declined, mom, { type: "accept" }, { ...context, unavailable: [mom.id] })).assigneeId, mom.id);
  // A guardian's own request is not theirs to drive; a handoff's decliners are not the family offer's.
  assert.deepEqual(availableDrivers(request({ requester: mom }), members), [dad.id]);
  const handoff = ok(applyPickupAction(ok(applyPickupAction(open, mom, { type: "accept" }, context)), mom,
    { type: "offer", expectedVersion: 2, offerId: "h" }, context));
  const handoffDeclined = ok(applyPickupAction(handoff, dad, { type: "respond_offer", expectedVersion: 2, offerId: "h", response: "decline" }, context));
  assert.deepEqual(availableDrivers(handoffDeclined, members), [mom.id, dad.id]);
  assert.equal(nobodyAvailable(handoffDeclined, members, [mom.id, dad.id]), false, "only an open pickup can have nobody");
});

test("24.3 회차 생성, S-65: an occurrence on its default driver's unavailable day is created open, never given to another", () => {
  const open = occurrence(dad.id, { ...context, unavailable: [dad.id] });
  assert.equal(open.status, "open");
  assert.equal(open.assigneeId, null);
  assert.equal(open.vehicleId, null);
  assert.equal(occurrence(dad.id, { ...context, unavailable: [mom.id] }).assigneeId, dad.id);
  // A routine edit recomputes by the same rule.
  const plan = { wantedAt: now + 90 * minute, destination: academy, assigneeId: dad.id, vehicleId: car.id, notifyBeforeMin: 20 };
  const revised = reviseOccurrence(occurrence(dad.id), plan, { ...context, unavailable: [dad.id] });
  assert.equal(revised.pickup.status, "open");
  assert.deepEqual(revised.events, ["routine_reassigned"]);
});

test("set_unavailable_day: own days only, from today to 60 days ahead, by a guardian who can drive", () => {
  const change = { memberId: dad.id, day: today, unavailable: true };
  const marked = setUnavailableDay([], members[1], change, today);
  assert.deepEqual(marked, { ok: true, days: [{ memberId: dad.id, day: today }] });
  assert.ok(marked.ok);
  assert.deepEqual(setUnavailableDay(marked.days, members[1], change, today), marked, "marking twice keeps one row");
  assert.deepEqual(setUnavailableDay(marked.days, members[1], { ...change, unavailable: false }, today), { ok: true, days: [] });
  assert.equal(setUnavailableDay([], members[1], { ...change, day: addDays(today, 60) }, today).ok, true);
  assert.deepEqual(setUnavailableDay([], members[1], { ...change, day: addDays(today, 61) }, today), { ok: false, code: "VALIDATION", days: [] });
  assert.deepEqual(setUnavailableDay([], members[1], { ...change, day: addDays(today, -1) }, today), { ok: false, code: "VALIDATION", days: [] });
  assert.deepEqual(setUnavailableDay([], members[1], { ...change, day: "2026-02-30" }, today), { ok: false, code: "VALIDATION", days: [] });
  assert.deepEqual(setUnavailableDay([], members[2], { ...change, memberId: aunt.id }, today), { ok: false, code: "FORBIDDEN", days: [] });
  assert.deepEqual(unavailableOn([{ memberId: dad.id, day: today }, { memberId: mom.id, day: addDays(today, 1) }], today), [dad.id]);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(familyDate(Date.UTC(2026, 10, 13, 15, 30)), "2026-11-14", "00:30 in Seoul is the next day");
});

test("S-65, S-66: marking reopens the member's untouched occurrence; clearing restores it unless already announced", () => {
  const routine = { assigneeId: dad.id, vehicleId: car.id };
  const assigned = occurrence(dad.id);
  const marked = reviseForUnavailableDay(assigned, { memberId: dad.id, unavailable: true, routine }, { ...context, unavailable: [dad.id] });
  assert.deepEqual(marked.events, ["routine_reassigned"]);
  assert.equal(marked.pickup.status, "open");
  assert.equal(marked.pickup.assigneeId, null);
  assert.equal(marked.pickup.vehicleId, null);
  assert.equal(marked.pickup.assignmentRound, assigned.assignmentRound + 1);
  assert.equal(marked.pickup.version, assigned.version + 1);
  const cleared = reviseForUnavailableDay(marked.pickup, { memberId: dad.id, unavailable: false, routine }, context);
  assert.deepEqual(cleared.events, ["routine_reassigned"]);
  assert.equal(cleared.pickup.status, "assigned");
  assert.equal(cleared.pickup.assigneeId, dad.id);
  assert.equal(cleared.pickup.vehicleId, car.id);
  // Announced to everyone while open: clearing leaves it open (24.3).
  const announced = sweepPickup(marked.pickup, { ...context, now: assigned.wantedAt - 20 * minute }).pickup;
  assert.equal(announced.offer?.status, "pending");
  const kept = reviseForUnavailableDay(announced, { memberId: dad.id, unavailable: false, routine }, { ...context, now: assigned.wantedAt - 19 * minute });
  assert.deepEqual(kept.events, []);
  assert.equal(kept.pickup, announced);
  const accepted = ok(applyPickupAction(assigned, dad, { type: "accept" }, context));
  assert.equal(reviseForUnavailableDay(accepted, { memberId: dad.id, unavailable: true, routine }, context).pickup, accepted,
    "an accepted occurrence keeps its driver");
  assert.equal(reviseForUnavailableDay(assigned, { memberId: mom.id, unavailable: true, routine }, context).pickup, assigned,
    "another member's day leaves it");
  assert.equal(reviseForUnavailableDay(request(), { memberId: dad.id, unavailable: true, routine }, context).pickup.status, "open");
  const past = occurrence(dad.id, context, now - minute);
  assert.equal(reviseForUnavailableDay(past, { memberId: dad.id, unavailable: true, routine }, context).pickup, past);
  // Clearing a day whose routine default is someone else, or a member who cannot drive any more, assigns nobody.
  const momsRoutine = reviseForUnavailableDay(marked.pickup, { memberId: dad.id, unavailable: false, routine: { assigneeId: mom.id, vehicleId: null } }, context);
  assert.deepEqual(momsRoutine.events, []);
  const lostDrive = reviseForUnavailableDay(marked.pickup, { memberId: dad.id, unavailable: false, routine },
    { ...context, members: members.map((m) => m.id === dad.id ? { ...m, canDrive: false } : m) });
  assert.deepEqual(lostDrive.events, []);
});
