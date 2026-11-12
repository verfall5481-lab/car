// What the server does around single transitions: creating requests and routine occurrences, the scheduler pass,
// the car's "못 가요", routine revision, days a guardian cannot drive, and the car's one active guidance. Each function
// mirrors the SQL function it names. The browser demo and the conformance suite call these, so the demo behaves as the
// backend does.
import { addDays, applyPickupAction, familyOfferId, isActivePickup, requestRecipients, routineFamilyOffer } from "./index.ts";
import type {
  Actor,
  Destination,
  Member,
  Pickup,
  PickupContext,
  PickupError,
  PickupEvent,
  PickupResult,
  Requester,
  UnavailableDay,
  Vehicle,
} from "./index.ts";

const minute = 60_000;

type NewPickup = { id: string; familyId: string; requester: Requester; destination: Destination; wantedAt: number };

function blankPickup(input: NewPickup, source: Pickup["source"]): Pickup {
  return {
    id: input.id, familyId: input.familyId, requester: input.requester, source, status: "open", version: 1,
    assignmentRound: 0, assigneeId: null, vehicleId: null, destination: input.destination, destinationRevision: 1,
    wantedAt: input.wantedAt, acceptedAt: null, navigation: null, offer: null, readyAt: null, notMetAt: null,
  };
}

/** `create_request`: an open request with its family-wide offer, which lapses with the request (4.3 #1, 4.4 #2). */
export function newRequestPickup(input: NewPickup): Pickup {
  return {
    ...blankPickup(input, "request"),
    offer: {
      id: familyOfferId(input.id, "request"), status: "pending", fromMemberId: null, toMemberId: null,
      expiresAt: input.wantedAt + 60 * minute, declinedBy: [],
    },
  };
}

type Holder = { assigneeId: string | null; vehicleId: string | null };
type HolderInput = Pick<Pickup, "familyId" | "requester"> & Holder;
type Family = Pick<PickupContext, "members" | "vehicles" | "unavailable">;

/**
 * The default holder of a routine occurrence, by the rule `ensure_occurrences` and `revise_routine` share: the default
 * driver only while still an eligible driver (23.1) who has not marked the occurrence's date as a day they cannot drive
 * (24.3: the occurrence is then open, never given to someone else), the default car only while that driver drives it.
 */
export function routineHolder(input: HolderInput, family: Family): Holder {
  const assigneeId = input.assigneeId;
  if (assigneeId === null || !requestRecipients(input, family.members).memberIds.includes(assigneeId) ||
      family.unavailable?.includes(assigneeId)) {
    return { assigneeId: null, vehicleId: null };
  }
  const vehicle = family.vehicles?.find((entry) =>
    entry.id === input.vehicleId && entry.familyId === input.familyId && entry.currentDriverId === assigneeId
  );
  return { assigneeId, vehicleId: vehicle?.id ?? null };
}

export type OccurrenceInput = NewPickup & Holder & { notifyBeforeMin: number };

/** `ensure_occurrences`: assigned to the eligible default driver, otherwise open (also on the driver's 못 가는 날). */
export function newOccurrencePickup(input: OccurrenceInput, family: Family): Pickup {
  const holder = routineHolder(input, family);
  return {
    ...blankPickup(input, "routine"),
    status: holder.assigneeId ? "assigned" : "open",
    assignmentRound: holder.assigneeId ? 1 : 0,
    assigneeId: holder.assigneeId,
    vehicleId: holder.vehicleId,
    notifyBeforeMin: input.notifyBeforeMin,
  };
}

/**
 * One scheduler pass over a pickup (`run_escalations`, 9장): an open pickup expires at wanted_at + 60 minutes; a pending
 * offer past its expiry is stored expired; an open routine occurrence reaching its notify time is offered to every
 * driver once (4.4 #4, F-15); an arrival without boarding closes unconfirmed after 3 hours (F-13). Notifications are
 * the server's business and are not modelled.
 */
export function sweepPickup(pickup: Pickup, context: PickupContext): PickupResult {
  const { now } = context;
  if (pickup.status === "open" && now >= pickup.wantedAt + 60 * minute) {
    return applyPickupAction(pickup, { kind: "system" }, { type: "expire" }, context);
  }
  let next = pickup;
  const events: PickupEvent[] = [];
  if (next.offer?.status === "pending" && next.offer.expiresAt <= now) {
    next = { ...next, offer: { ...next.offer, status: "expired" } };
    events.push("offer_expired");
  }
  const notifyAt = next.wantedAt - (next.notifyBeforeMin ?? 20) * minute;
  if (next.source === "routine" && next.status === "open" && next.routineOfferAt == null && now >= notifyAt) {
    // A pending offer stays; the occurrence is marked announced either way, so it is never offered twice (A.4).
    const offer = next.offer?.status === "pending" ? next.offer : routineFamilyOffer(next, now);
    next = { ...next, offer, routineOfferAt: now };
  }
  if (next.status === "arrived" && next.arrivedAt != null && now >= next.arrivedAt + 180 * minute) {
    const closed = applyPickupAction(next, { kind: "system" }, { type: "close_unconfirmed" }, context);
    return { ...closed, events: [...events, ...closed.events] };
  }
  return { ok: true, pickup: next, events };
}

export type VehicleDecline = { expectedVersion: number; offerId: string };

/**
 * F-12 "못 가요", as `vehicle_decline`. On an open request the driver's refusal is recorded once (`request_declined`)
 * and the last eligible driver to refuse closes the request offer as declined (4.4 #7, 8.7). On the driver's own trip
 * it offers the trip to everyone in the driver's name (4.4 #3). Otherwise it declines the pending offer to the driver.
 */
export function declineFromVehicle(pickup: Pickup, actor: Actor, action: VehicleDecline, context: PickupContext): PickupResult {
  const fail = (code: PickupError, next = pickup, events: readonly PickupEvent[] = []): PickupResult =>
    ({ ok: false, code, pickup: next, events });
  if (actor.kind !== "vehicle") return fail("FORBIDDEN");
  const driver = context.members.find((member) =>
    member.id === actor.driverId && member.familyId === pickup.familyId && member.leftAt == null
  );
  if (!driver?.canDrive) return fail("FORBIDDEN");
  if (pickup.requester.kind === "member" && pickup.requester.id === driver.id) return fail("NOT_FOUND");
  if (action.expectedVersion !== pickup.version) return fail("STALE_VERSION");
  const offer = pickup.offer;
  if (pickup.status === "open" && pickup.source === "request") {
    if (context.now >= pickup.wantedAt + 60 * minute) {
      const expired = applyPickupAction(pickup, { kind: "system" }, { type: "expire" }, context);
      return fail("PICKUP_EXPIRED", expired.pickup, expired.events);
    }
    if (!offer) return { ok: true, pickup, events: ["request_declined"] };
    if (offer.declinedBy.includes(driver.id)) return { ok: true, pickup, events: [] };
    const declinedBy = [...offer.declinedBy, driver.id];
    const everyone = requestRecipients(pickup, context.members).memberIds
      .filter((id) => id !== offer.fromMemberId)
      .every((id) => declinedBy.includes(id));
    const status = offer.status === "pending" && everyone ? "declined" : offer.status;
    return { ok: true, pickup: { ...pickup, offer: { ...offer, declinedBy, status } }, events: ["request_declined"] };
  }
  if (pickup.status === "assigned" && pickup.vehicleId === actor.id && pickup.assigneeId === driver.id) {
    return applyPickupAction(pickup, actor, { type: "offer", expectedVersion: action.expectedVersion, offerId: action.offerId },
      context);
  }
  if (offer?.status !== "pending") return fail("OFFER_NOT_PENDING");
  return applyPickupAction(pickup, actor, {
    type: "respond_offer", expectedVersion: action.expectedVersion, offerId: offer.id, response: "decline",
  }, context);
}

/** Where an occurrence of an edited routine now goes; `null` when the routine no longer has it. */
export type OccurrencePlan = Holder & {
  wantedAt: number;
  destination: Destination;
  notifyBeforeMin: number;
  /** The routine's rider, when the edit changed who is picked up. */
  requester?: Requester;
};

function sameDestination(a: Destination, b: Destination): boolean {
  return a.lat === b.lat && a.lng === b.lng && a.label === b.label && a.source === b.source && a.note === b.note &&
    a.placeId === b.placeId && a.pickupPointId === b.pickupPointId;
}

/**
 * `revise_routine` for one occurrence of an edited routine. An occurrence someone changed (accepted, handed off,
 * located, cancelled), or one that is no longer upcoming and open or assigned, is left as it is (S-16, S-28). The others
 * follow the routine: without a plan (the routine was archived or no longer runs that day) or with a time already past,
 * the system cancels it; otherwise it takes the routine's time, place and default holder, and a new holder withdraws a
 * pending family-wide offer and records `routine_reassigned` (4.1, 4.4 #12). The family-wide offer is not made again.
 */
export function reviseOccurrence(pickup: Pickup, plan: OccurrencePlan | null, context: PickupContext): PickupResult {
  const { now } = context;
  // The server reads notify_before_min from the routine every time, so every occurrence follows it.
  const current = plan ? { ...pickup, notifyBeforeMin: plan.notifyBeforeMin } : pickup;
  const untouched: PickupResult = { ok: true, pickup: current, events: [] };
  if (pickup.source !== "routine" || pickup.customized || pickup.wantedAt < now) return untouched;
  if (pickup.status !== "open" && pickup.status !== "assigned") return untouched;
  const withdrawn = pickup.offer?.status === "pending" ? { ...pickup.offer, status: "cancelled" as const } : pickup.offer;
  if (!plan || plan.wantedAt < now) {
    return {
      ok: true,
      pickup: { ...current, status: "cancelled", version: pickup.version + 1, offer: withdrawn, cancelReason: "routine_archived" },
      events: ["cancelled"],
    };
  }
  const requester = plan.requester ?? pickup.requester;
  const holder = routineHolder({ ...pickup, requester, assigneeId: plan.assigneeId, vehicleId: plan.vehicleId }, context);
  const reassigned = holder.assigneeId !== pickup.assigneeId;
  const destination = { ...plan.destination, confirmed: true };
  const moved = !sameDestination(pickup.destination, destination);
  const status = holder.assigneeId ? "assigned" : "open";
  const changed = status !== pickup.status || reassigned || holder.vehicleId !== pickup.vehicleId || moved ||
    plan.wantedAt !== pickup.wantedAt || !pickup.destination.confirmed;
  const next: Pickup = {
    ...current,
    requester,
    status,
    assigneeId: holder.assigneeId,
    vehicleId: holder.vehicleId,
    assignmentRound: pickup.assignmentRound + Number(reassigned),
    destination,
    destinationRevision: pickup.destinationRevision + Number(moved),
    wantedAt: plan.wantedAt,
    offer: reassigned ? withdrawn : pickup.offer,
    version: pickup.version + Number(changed),
  };
  return { ok: true, pickup: next, events: reassigned ? ["routine_reassigned"] : [] };
}

export type Guidance = Pick<Vehicle, "activePickupId" | "activeSessionId" | "activeDestinationRevision">;

/**
 * A car has one active guidance (8.3.1): a start sets it to the session it issued; it ends when its pickup ends or the
 * departure is undone. Returns the car's new guidance, or `null` when this result leaves it as it is.
 */
export function guidanceAfter(vehicle: Vehicle, actor: Actor, action: { type: string }, result: PickupResult): Guidance | null {
  const pickup = result.pickup;
  if (result.ok && action.type === "vehicle_start" && actor.kind === "vehicle" && actor.id === vehicle.id && pickup.navigation) {
    return {
      activePickupId: pickup.id, activeSessionId: pickup.navigation.sessionId,
      activeDestinationRevision: pickup.destinationRevision,
    };
  }
  if (vehicle.activePickupId === pickup.id && (!isActivePickup(pickup) || (result.ok && action.type === "undo_en_route"))) {
    return { activePickupId: null, activeSessionId: null, activeDestinationRevision: null };
  }
  return null;
}

export type UnavailableDayChange = { memberId: string; day: string; unavailable: boolean };
export type UnavailableDayResult =
  | { ok: true; days: UnavailableDay[] }
  | { ok: false; code: Extract<PickupError, "FORBIDDEN" | "VALIDATION" | "NOT_FOUND">; days: readonly UnavailableDay[] };

/**
 * `set_unavailable_day` (24.3 못 가는 날, 24.6): a guardian who can drive marks or clears one of their own days, from
 * `today` (the family's date now) to 60 days ahead. Returns the stored days; repeating a change is a success. Pass every
 * pickup on that day through `reviseForUnavailableDay` afterwards.
 */
export function setUnavailableDay(
  days: readonly UnavailableDay[],
  member: Member | undefined,
  change: UnavailableDayChange,
  today: string,
): UnavailableDayResult {
  if (!member || member.leftAt != null || member.id !== change.memberId) return { ok: false, code: "NOT_FOUND", days };
  if (!member.canDrive) return { ok: false, code: "FORBIDDEN", days };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(change.day) || addDays(change.day, 0) !== change.day || change.day < today ||
      change.day > addDays(today, 60)) {
    return { ok: false, code: "VALIDATION", days };
  }
  const others = days.filter((entry) => !(entry.memberId === change.memberId && entry.day === change.day));
  return { ok: true, days: change.unavailable ? [...others, { memberId: change.memberId, day: change.day }] : others };
}

/**
 * What `set_unavailable_day` does to one routine occurrence on the changed day (24.3 이미 만든 회차). Only an untouched
 * (`customized` false), upcoming occurrence moves:
 * - marking: the member's default `assigned` occurrence becomes `open` (a pending offer is withdrawn);
 * - clearing: an `open` occurrence whose routine default (`routine`) is the member becomes theirs again, unless the
 *   family-wide offer was already made (`routineOfferAt`).
 * Either move records `routine_reassigned` and notifies nobody (4.4 #12). `context.unavailable` is the day's list after
 * the change. A request, an accepted or handed-off occurrence and an occurrence of another day stay as they are.
 */
export function reviseForUnavailableDay(
  pickup: Pickup,
  change: Pick<UnavailableDayChange, "memberId" | "unavailable"> & { routine: Holder },
  context: PickupContext,
): PickupResult {
  const untouched: PickupResult = { ok: true, pickup, events: [] };
  if (pickup.source !== "routine" || pickup.customized || pickup.wantedAt < context.now) return untouched;
  let holder: Holder;
  if (change.unavailable) {
    if (pickup.status !== "assigned" || pickup.assigneeId !== change.memberId) return untouched;
    holder = { assigneeId: null, vehicleId: null };
  } else {
    if (pickup.status !== "open" || pickup.routineOfferAt != null || change.routine.assigneeId !== change.memberId) return untouched;
    holder = routineHolder({ ...pickup, ...change.routine }, context);
    if (holder.assigneeId !== change.memberId) return untouched;
  }
  const offer = pickup.offer?.status === "pending" ? { ...pickup.offer, status: "cancelled" as const } : pickup.offer;
  return {
    ok: true,
    pickup: {
      ...pickup, status: holder.assigneeId ? "assigned" : "open", assigneeId: holder.assigneeId, vehicleId: holder.vehicleId,
      assignmentRound: pickup.assignmentRound + 1, version: pickup.version + 1, offer,
    },
    events: ["routine_reassigned"],
  };
}
