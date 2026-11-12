// Runs a scenario through the TypeScript machine and the composition functions the browser demo calls
// (apps/web/src/demo-domain.ts uses the same ones): `newRequestPickup` and `newOccurrencePickup` to create,
// `applyPickupAction` for transitions, `declineFromVehicle` for "못 가요", `sweepPickup` for the scheduler,
// `reviseOccurrence` for routine edits, `setUnavailableDay` and `reviseForUnavailableDay` for 못 가는 날, and
// `guidanceAfter` for the car's active guidance. A rejected result is stored as well, because it can carry an expiry
// (4.5), exactly as the demo stores it.
import {
  addDays,
  applyPickupAction,
  availableDrivers,
  canRequestPickup,
  declineFromVehicle,
  familyDate,
  familyOfferId,
  guidanceAfter,
  newOccurrencePickup,
  newRequestPickup,
  resolveDestination,
  reviseForUnavailableDay,
  reviseOccurrence,
  setUnavailableDay,
  sweepPickup,
  unavailableOn,
} from "../src/index.ts";
import type {
  Actor,
  LocationInput,
  Member,
  OccurrencePlan,
  Pickup,
  PickupAction,
  PickupContext,
  PickupPoint,
  PickupResult,
  Place,
  Requester,
  UnavailableDay,
  Vehicle,
} from "../src/index.ts";
import { expiresInMin, familyOf, isAct, minute, versionOf } from "./model.ts";
import type { ActStep, ActionSpec, LocationSpec, Outcome, PickupSpec, RequestSpec, RoutineSpec, Run, Scenario, Stamp } from "./model.ts";

/** 17:00 in Seoul. Only differences from this clock matter. */
export const tsEpoch = Date.UTC(2026, 10, 9, 8);
const familyId = "family";
const timeZone = "Asia/Seoul";
export const defaultFallbackNote = "학원 안에서 기다리기";

type TsVehicle = Vehicle & { parked: boolean };
type Session = { id: string; revision: number };
/** The routine behind a routine pickup, as the guardian last saved it. */
type RoutineDefinition = {
  requester: Requester;
  place: string;
  assigneeId: string | null;
  vehicleId: string | null;
  notifyBeforeMin: number;
  /** The routine's time on this occurrence's day. */
  wantedAt: number;
  dayDropped: boolean;
};

export function runTs(scenario: Scenario): Run {
  const world = new TsWorld(scenario);
  for (const mark of scenario.unavailable ?? []) world.markBefore(scenario, mark.member, mark.dayOf);
  const created: Run["created"] = {};
  for (const spec of scenario.pickups) created[spec.key] = world.create(spec);
  const steps = scenario.steps.map((step) => {
    if (isAct(step)) return world.act(step, scenario.pickups[0].key);
    if ("clock" in step) world.now += step.clock * minute;
    else if ("park" in step) world.vehicle(step.park).parked = step.parked;
    else if ("driver" in step) world.vehicle(step.driver).currentDriverId = step.member;
    else world.members = world.members.map((member) => member.id === step.member ? { ...member, canDrive: step.canDrive } : member);
    return null;
  });
  return { created, steps };
}

class TsWorld {
  now = tsEpoch;
  members: Member[];
  readonly riders: { id: string; familyId: string }[];
  readonly places: Place[];
  readonly points: PickupPoint[];
  readonly vehicles: TsVehicle[];
  readonly pickups = new Map<string, Pickup>();
  /** 못 가는 날 as the demo stores them (24.7). */
  days: UnavailableDay[] = [];
  private readonly routines = new Map<string, RoutineDefinition>();
  private readonly actionIds = new Map<string, string>();
  private readonly sessions = new Map<string, Session[]>();
  private sequence = 0;

  constructor(scenario: Scenario) {
    const family = familyOf(scenario);
    this.members = family.members.map((member) => ({
      id: member.key, familyId, canDrive: member.canDrive ?? true, canRequest: member.canRequest ?? true,
    }));
    this.riders = family.riders.map((rider) => ({ id: rider.key, familyId }));
    this.places = family.places.map((place) => ({
      id: place.key, familyId, label: place.label, lat: place.lat, lng: place.lng, radiusM: place.radiusM,
    }));
    this.points = family.points.map((point) => ({
      id: point.key, familyId, placeId: point.place, label: point.label, lat: point.lat, lng: point.lng, note: point.note,
    }));
    this.vehicles = family.vehicles.map((vehicle) => ({
      id: vehicle.key, familyId, currentDriverId: vehicle.driver, parked: vehicle.parked ?? true,
      activePickupId: null, activeSessionId: null, activeDestinationRevision: null,
    }));
  }

  vehicle(key: string): TsVehicle {
    const vehicle = this.vehicles.find(({ id }) => id === key);
    if (!vehicle) throw new Error(`unknown vehicle ${key}`);
    return vehicle;
  }

  /** With a pickup, the context carries the members who cannot drive on its date. */
  private context(pickup?: Pick<Pickup, "wantedAt">): PickupContext {
    const unavailable = pickup ? unavailableOn(this.days, familyDate(pickup.wantedAt, timeZone)) : [];
    return { now: this.now, members: this.members, vehicles: this.vehicles, unavailable };
  }

  /** A day marked before pickups exist: the date the spec's pickup will have. */
  markBefore(scenario: Scenario, member: string, pickupKey: string): void {
    const spec = scenario.pickups.find(({ key }) => key === pickupKey);
    if (!spec) throw new Error(`unknown pickup ${pickupKey}`);
    const day = familyDate(this.now + (spec.wantedInMin ?? 0) * minute, timeZone);
    const result = setUnavailableDay(this.days, this.members.find(({ id }) => id === member),
      { memberId: member, day, unavailable: true }, familyDate(this.now, timeZone));
    if (!result.ok) throw new Error(`marking ${member} failed: ${result.code}`);
    this.days = result.days;
  }

  create(spec: PickupSpec): Outcome {
    const pickup = spec.kind === "request" ? this.request(spec) : this.routine(spec);
    this.pickups.set(spec.key, pickup);
    return this.outcome(pickup, pickup, { ok: true, pickup, events: [] });
  }

  /** As `createRequest` in the demo. */
  private request(spec: RequestSpec): Pickup {
    const requester: Requester = this.riders.some(({ id }) => id === spec.by)
      ? { kind: "rider", id: spec.by }
      : { kind: "member", id: spec.by };
    if (!canRequestPickup(requester, familyId, this.members, this.riders)) throw new Error(`${spec.by} cannot request`);
    const destination = resolveDestination(familyId, this.location(spec.at), this.places, this.points);
    if (!destination) throw new Error(`invalid location for ${spec.key}`);
    return newRequestPickup({ id: spec.key, familyId, requester, destination, wantedAt: this.now + (spec.wantedInMin ?? 0) * minute });
  }

  /** As `routineOccurrence` in the demo. */
  private routine(spec: RoutineSpec): Pickup {
    const definition: RoutineDefinition = {
      requester: { kind: "rider", id: spec.rider }, place: spec.place, assigneeId: spec.assignee ?? null,
      vehicleId: spec.vehicle ?? null, notifyBeforeMin: spec.notifyBeforeMin ?? 20,
      wantedAt: this.now + spec.wantedInMin * minute, dayDropped: false,
    };
    this.routines.set(spec.key, definition);
    return newOccurrencePickup({
      id: spec.key, familyId, requester: definition.requester, destination: this.placeDestination(spec.place),
      wantedAt: definition.wantedAt, assigneeId: definition.assigneeId, vehicleId: definition.vehicleId,
      notifyBeforeMin: definition.notifyBeforeMin,
    }, this.context({ wantedAt: definition.wantedAt }));
  }

  private placeDestination(place: string) {
    const destination = resolveDestination(familyId, { source: "saved_place", placeId: place }, this.places);
    if (!destination) throw new Error(`unknown place ${place}`);
    return destination;
  }

  private location(spec: LocationSpec): LocationInput {
    if ("place" in spec) return { source: "saved_place", placeId: spec.place };
    if ("point" in spec) return { source: "saved_point", pickupPointId: spec.point };
    if ("pin" in spec) return { source: "map_pin", ...spec.pin };
    return { source: "gps", lat: spec.gps.lat, lng: spec.gps.lng, accuracyM: spec.gps.accuracyM };
  }

  private actor(key: string): Actor {
    if (key === "system") return { kind: "system" };
    if (this.members.some(({ id }) => id === key)) return { kind: "member", id: key };
    if (this.riders.some(({ id }) => id === key)) return { kind: "rider", id: key };
    const vehicle = this.vehicle(key);
    return { kind: "vehicle", id: vehicle.id, driverId: vehicle.currentDriverId ?? "", parked: vehicle.parked };
  }

  act(step: ActStep, firstPickup: string): Outcome {
    const key = step.pickup ?? firstPickup;
    const before = this.pickups.get(key);
    if (!before) throw new Error(`unknown pickup ${key}`);
    const actor = this.actor(step.actor);
    const [type, result] = this.dispatch(key, before, actor, step.do);
    this.record(key, actor, type, result);
    return this.outcome(before, this.pickups.get(key)!, result);
  }

  /** Runs the step and names what ran: a `PickupAction` type or the composition function's own name. */
  private dispatch(key: string, pickup: Pickup, actor: Actor, spec: ActionSpec): [string, PickupResult] {
    const expectedVersion = versionOf(pickup.version, "version" in spec ? spec.version : undefined);
    switch (spec.type) {
      case "sweep":
        return [spec.type, sweepPickup(pickup, this.context(pickup))];
      case "vehicle_decline":
        return [spec.type, declineFromVehicle(pickup, actor, { expectedVersion, offerId: this.id("offer") }, this.context(pickup))];
      case "unavailable_day":
        return [spec.type, this.unavailableDay(key, pickup, actor, spec)];
      case "nav_result":
        // TS has no navigation result. The demo decides a navigation failure on the car (`navFails`) at the start.
        return [spec.type, { ok: true, pickup, events: [] }];
      case "edit_routine":
      case "archive_routine":
        return [spec.type, reviseOccurrence(pickup, this.plan(key, spec), this.context(pickup))];
      default: {
        const action = this.action(key, pickup, actor, spec, expectedVersion);
        return [action.type, applyPickupAction(pickup, actor, action, this.context(pickup))];
      }
    }
  }

  /**
   * As the demo would: store the change, then let every routine occurrence on that day follow it. Returns the step
   * pickup's result; the other pickups on that day are stored here.
   */
  private unavailableDay(key: string, pickup: Pickup, actor: Actor,
    spec: Extract<ActionSpec, { type: "unavailable_day" }>): PickupResult {
    const today = familyDate(this.now, timeZone);
    const day = spec.fromToday === undefined ? familyDate(pickup.wantedAt, timeZone) : addDays(today, spec.fromToday);
    const memberId = actor.kind === "member" ? actor.id : "";
    const change = { memberId, day, unavailable: spec.unavailable ?? true };
    const stored = setUnavailableDay(this.days, this.members.find(({ id }) => id === memberId), change, today);
    if (!stored.ok) return { ok: false, code: stored.code, pickup, events: [] };
    this.days = stored.days;
    let own: PickupResult = { ok: true, pickup, events: [] };
    for (const [other, current] of this.pickups) {
      if (familyDate(current.wantedAt, timeZone) !== day) continue;
      const definition = this.routines.get(other);
      const routine = { assigneeId: definition?.assigneeId ?? null, vehicleId: definition?.vehicleId ?? null };
      const result = reviseForUnavailableDay(current, { memberId, unavailable: change.unavailable, routine }, this.context(current));
      if (other === key) own = result;
      else this.pickups.set(other, result.pickup);
    }
    return own;
  }

  /** Applies the edit to the routine and says where its occurrence goes now. */
  private plan(key: string, spec: Extract<ActionSpec, { type: "edit_routine" | "archive_routine" }>): OccurrencePlan | null {
    const definition = this.routines.get(key);
    if (!definition) throw new Error(`${key} is not a routine occurrence`);
    if (spec.type === "archive_routine") return null;
    if (spec.assignee !== undefined) definition.assigneeId = spec.assignee;
    if (spec.vehicle !== undefined) definition.vehicleId = spec.vehicle;
    if (spec.place !== undefined) definition.place = spec.place;
    if (spec.notifyBeforeMin !== undefined) definition.notifyBeforeMin = spec.notifyBeforeMin;
    definition.wantedAt += (spec.shiftMinutes ?? 0) * minute;
    definition.dayDropped ||= spec.dropDay === true;
    if (definition.dayDropped) return null;
    return {
      wantedAt: definition.wantedAt, destination: this.placeDestination(definition.place), requester: definition.requester,
      assigneeId: definition.assigneeId, vehicleId: definition.vehicleId, notifyBeforeMin: definition.notifyBeforeMin,
    };
  }

  private action(key: string, pickup: Pickup, actor: Actor, spec: ActionSpec, expectedVersion: number): PickupAction {
    const latestOffer = pickup.offer?.id ?? "no-offer";
    switch (spec.type) {
      case "accept":
        return { type: "accept", vehicleId: spec.vehicle };
      case "offer":
        return { type: "offer", expectedVersion, offerId: this.id("offer"), toMemberId: spec.to, note: spec.note };
      case "respond":
        return { type: "respond_offer", expectedVersion, offerId: latestOffer, response: spec.response, vehicleId: spec.vehicle };
      case "cancel_offer":
        return { type: "cancel_offer", expectedVersion, offerId: latestOffer };
      case "take_over":
        return { type: "take_over", expectedVersion, vehicleId: spec.vehicle };
      case "depart":
        return { type: "depart", expectedVersion };
      case "undo":
        return { type: "undo_en_route", expectedVersion };
      case "vehicle_start": {
        const slot = `${actor.kind === "vehicle" ? actor.id : "?"}|${key}`;
        const actionId = spec.retry ? this.actionIds.get(slot) ?? this.id("action") : this.id("action");
        this.actionIds.set(slot, actionId);
        const family = familyOfferId(key, pickup.source === "request" ? "request" : "routine");
        return {
          type: "vehicle_start", expectedVersion, actionId, sessionId: this.id("session"),
          offerId: spec.withOffer === "family" ? family : spec.withOffer ? pickup.offer?.id : undefined,
        };
      }
      case "arrive":
        return { type: "arrive", source: "manual", expectedVersion };
      case "nav_arrival": {
        const sessions = this.sessions.get(key) ?? [];
        const session = spec.session === "previous" ? sessions.at(-2) : sessions.at(-1);
        return {
          type: "arrive", source: "nav_callback", sessionId: session?.id ?? "no-session",
          destinationRevision: spec.revision === "current" ? pickup.destinationRevision : session?.revision ?? 0,
        };
      }
      case "board":
        return { type: "board", expectedVersion };
      case "cancel":
        return { type: "cancel", expectedVersion, reason: spec.reason };
      case "skip":
        return { type: "cancel", expectedVersion, reason: "skipped" };
      case "confirm_location": {
        // P-07 / V-04: a saved place, or the current point as it is.
        const destination = spec.place ? this.placeDestination(spec.place) : { ...pickup.destination, confirmed: true };
        return { type: "confirm_location", expectedVersion, destination };
      }
      case "ready":
        return { type: "ready", expectedVersion };
      case "not_met":
        return { type: "not_met", expectedVersion };
      case "no_driver":
        return { type: "no_driver", expectedVersion, note: spec.note ?? defaultFallbackNote };
      case "ack_fallback":
        return { type: "ack_fallback" };
      default:
        throw new Error(`${spec.type} is not a pickup action`);
    }
  }

  /** Stores a result as the demo does: the pickup (also when rejected) and every car's guidance. */
  private record(key: string, actor: Actor, type: string, result: PickupResult): void {
    const next = result.pickup;
    this.pickups.set(key, next);
    for (const vehicle of this.vehicles) {
      const guidance = guidanceAfter(vehicle, actor, { type }, result);
      if (guidance) Object.assign(vehicle, guidance);
    }
    if (next.navigation && this.sessions.get(key)?.at(-1)?.id !== next.navigation.sessionId) {
      this.sessions.set(key, [...this.sessions.get(key) ?? [], {
        id: next.navigation.sessionId, revision: next.navigation.destinationRevision,
      }]);
    }
  }

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private outcome(before: Pickup, after: Pickup, result: PickupResult): Outcome {
    const stamps: Record<Stamp, number | null | undefined> = {
      acceptedAt: after.acceptedAt, enRouteAt: after.enRouteAt, arrivedAt: after.arrivedAt,
      readyAt: after.readyAt, notMetAt: after.notMetAt,
    };
    const set = (Object.keys(stamps) as Stamp[]).filter((name) => stamps[name] != null);
    const previous = before.offer;
    let resolved: Outcome["resolved"] = null;
    if (previous?.status === "pending") {
      if (after.offer?.id !== previous.id) {
        // TS keeps one offer per pickup; a replaced pending offer is the SQL `superseded`.
        resolved = { from: previous.fromMemberId, status: "superseded", by: null };
      } else if (after.offer.status !== "pending") {
        resolved = { from: previous.fromMemberId, status: after.offer.status, by: after.offer.acceptedBy ?? null };
      }
    }
    const offer = after.offer?.status === "pending"
      ? {
        from: after.offer.fromMemberId, to: after.offer.toMemberId, declinedBy: [...after.offer.declinedBy].sort(),
        expiresInMin: expiresInMin(after.offer.expiresAt, this.now),
      }
      : null;
    return {
      ok: result.ok,
      code: result.ok ? null : result.code,
      by: result.ok ? null : result.by ?? null,
      ignored: result.ok && result.ignored === true,
      status: after.status,
      assignee: after.assigneeId,
      vehicle: after.vehicleId,
      version: after.version,
      round: after.assignmentRound,
      wantedInMin: Math.round((after.wantedAt - this.now) / minute),
      confirmed: after.destination.confirmed,
      destinationRevision: after.destinationRevision,
      customized: after.customized === true,
      announced: after.routineOfferAt != null,
      navSession: after.navigation !== null,
      newNavSession: after.navigation !== null && after.navigation.sessionId !== before.navigation?.sessionId,
      set,
      offer,
      resolved,
      events: [...result.events],
      active: Object.fromEntries(this.vehicles.map((vehicle) => [vehicle.id, vehicle.activePickupId ?? null])),
      pickupCount: this.pickups.size,
      cancelReason: after.cancelReason ?? null,
      fallbackNote: after.fallbackNote ?? null,
      fallbackBy: after.fallbackBy ?? null,
      fallbackAcked: after.fallbackAckAt != null,
      available: after.status === "open"
        ? availableDrivers(after, this.members, this.context(after).unavailable).sort()
        : null,
    };
  }
}
