// Runs a scenario through `applyPickupAction` the way the browser demo composes it. The demo keeps some of that
// composition outside packages/contracts, so this driver mirrors it and names the source of each piece:
// - request and routine construction: `createRequest`, `routineOccurrence`, `makePickup` in apps/web/src/demo-domain.ts
// - persisting a result, including rejected results that carry an expiry, and the car's active guidance:
//   `applyDemoAction` in demo-domain.ts
// - the scheduler sweep: `setDemoTime` in demo-domain.ts
// - "못 가요": `cannotGo` and `answerOffer` in apps/web/src/vehicle.tsx
import {
  applyPickupAction,
  canRequestPickup,
  isActivePickup,
  resolveDestination,
} from "../src/index.ts";
import type {
  Actor,
  Destination,
  LocationInput,
  Member,
  Pickup,
  PickupAction,
  PickupPoint,
  PickupResult,
  Place,
  Requester,
  Vehicle,
} from "../src/index.ts";
import { expiresInMin, familyOf, isAct, minute, versionOf } from "./model.ts";
import type {
  ActStep,
  ActionSpec,
  LocationSpec,
  Outcome,
  PickupSpec,
  RequestSpec,
  RoutineSpec,
  Run,
  Scenario,
  Shape,
  Stamp,
} from "./model.ts";

/** 17:00 in Seoul. Only differences from this clock matter. */
export const tsEpoch = Date.UTC(2026, 10, 9, 8);
const familyId = "family";

type TsVehicle = Vehicle & { parked: boolean };
type Session = { id: string; revision: number };
type Applied = { ok: boolean; code: string | null; ignored: boolean; events: readonly string[] };

export function runTs(scenario: Scenario, shape: Shape): Run {
  const world = new TsWorld(scenario, shape);
  const created: Run["created"] = {};
  for (const spec of scenario.pickups) created[spec.key] = world.create(spec);
  const steps = scenario.steps.map((step) => {
    if (isAct(step)) return world.act(step, scenario.pickups[0].key);
    if ("clock" in step) world.now += step.clock * minute;
    else if ("park" in step) world.vehicle(step.park).parked = step.parked;
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
  private readonly shape: Shape;
  private readonly notifyBefore = new Map<string, number>();
  private readonly actionIds = new Map<string, string>();
  private readonly sessions = new Map<string, Session[]>();
  private sequence = 0;

  constructor(scenario: Scenario, shape: Shape) {
    const family = familyOf(scenario);
    this.shape = shape;
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

  create(spec: PickupSpec): Outcome {
    const pickup = spec.kind === "request" ? this.request(spec) : this.routine(spec);
    this.pickups.set(spec.key, pickup);
    return this.outcome(pickup, pickup, { ok: true, code: null, ignored: false, events: [] });
  }

  /** `createRequest` + `makePickup`; the spec shape adds the request offer `create_request` inserts. */
  private request(spec: RequestSpec): Pickup {
    const requester: Requester = this.riders.some(({ id }) => id === spec.by)
      ? { kind: "rider", id: spec.by }
      : { kind: "member", id: spec.by };
    if (!canRequestPickup(requester, familyId, this.members, this.riders)) throw new Error(`${spec.by} cannot request`);
    const destination = resolveDestination(familyId, this.location(spec.at), this.places, this.points);
    if (!destination) throw new Error(`invalid location for ${spec.key}`);
    const wantedAt = this.now + (spec.wantedInMin ?? 0) * minute;
    const pickup = makePickup(spec.key, requester, destination, wantedAt, "request");
    if (this.shape === "demo") return pickup;
    return {
      ...pickup,
      offer: {
        id: `${spec.key}-request-offer`, status: "pending", fromMemberId: null, toMemberId: null,
        expiresAt: wantedAt + 60 * minute, declinedBy: [],
      },
    };
  }

  /** `routineOccurrence` + `makePickup`. */
  private routine(spec: RoutineSpec): Pickup {
    const destination = resolveDestination(familyId, { source: "saved_place", placeId: spec.place }, this.places);
    if (!destination) throw new Error(`invalid place for ${spec.key}`);
    const wantedAt = this.now + spec.wantedInMin * minute;
    if (spec.notifyBeforeMin !== undefined) this.notifyBefore.set(spec.key, spec.notifyBeforeMin);
    return makePickup(spec.key, { kind: "rider", id: spec.rider }, destination, wantedAt, "routine",
      spec.assignee ?? null, spec.vehicle ?? null);
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
    const applied = this.dispatch(key, before, actor, step.do);
    return this.outcome(before, this.pickups.get(key)!, applied);
  }

  private dispatch(key: string, pickup: Pickup, actor: Actor, spec: ActionSpec): Applied {
    switch (spec.type) {
      case "sweep":
        return this.sweep(key, pickup);
      case "vehicle_decline":
        return this.cannotGo(key, pickup, actor);
      case "nav_result":
        // There is no navigation result action in TS. The demo decides navigation failure up front
        // (`DemoVehicle.navFails` -> `navError` in applyDemoAction); the pickup does not change.
        return { ok: true, code: null, ignored: false, events: [] };
      default:
        return this.apply(key, pickup, actor, this.action(key, pickup, actor, spec));
    }
  }

  private action(key: string, pickup: Pickup, actor: Actor, spec: ActionSpec): PickupAction {
    const expectedVersion = versionOf(pickup.version, "version" in spec ? spec.version : undefined);
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
        return {
          type: "vehicle_start", expectedVersion, actionId, sessionId: this.id("session"),
          offerId: spec.withOffer ? pickup.offer?.id : undefined,
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
        const destination: Destination | null = spec.place
          ? resolveDestination(familyId, { source: "saved_place", placeId: spec.place }, this.places)
          : { ...pickup.destination, confirmed: true };
        if (!destination) throw new Error(`unknown place ${spec.place}`);
        return { type: "confirm_location", expectedVersion, destination };
      }
      case "ready":
        return { type: "ready", expectedVersion };
      case "not_met":
        return { type: "not_met", expectedVersion };
      case "sweep":
      case "vehicle_decline":
      case "nav_result":
        throw new Error(`${spec.type} is composed outside applyPickupAction`);
    }
  }

  private context() {
    return { now: this.now, members: this.members, vehicles: this.vehicles };
  }

  /** `applyDemoAction`: store the returned pickup (also when rejected) and keep the car's active guidance. */
  private apply(key: string, pickup: Pickup, actor: Actor, action: PickupAction): Applied {
    const result: PickupResult = applyPickupAction(this.withNotifyBefore(key, pickup), actor, action, this.context());
    const next = result.pickup;
    this.pickups.set(key, next);
    if (result.ok && action.type === "vehicle_start" && next.navigation && actor.kind === "vehicle") {
      Object.assign(this.vehicle(actor.id), {
        activePickupId: key, activeSessionId: next.navigation.sessionId, activeDestinationRevision: next.destinationRevision,
      });
    }
    for (const vehicle of this.vehicles) {
      if (vehicle.activePickupId === key && (!isActivePickup(next) || (result.ok && action.type === "undo_en_route"))) {
        Object.assign(vehicle, { activePickupId: null, activeSessionId: null, activeDestinationRevision: null });
      }
    }
    if (next.navigation && this.sessions.get(key)?.at(-1)?.id !== next.navigation.sessionId) {
      this.sessions.set(key, [...this.sessions.get(key) ?? [], {
        id: next.navigation.sessionId, revision: next.navigation.destinationRevision,
      }]);
    }
    return result.ok
      ? { ok: true, code: null, ignored: result.ignored === true, events: result.events }
      : { ok: false, code: result.code, ignored: false, events: result.events };
  }

  /** The demo builds occurrences without the routine's notify-before minutes; the spec shape passes them on. */
  private withNotifyBefore(key: string, pickup: Pickup): Pickup {
    const notifyBefore = this.notifyBefore.get(key);
    return this.shape === "spec" && notifyBefore !== undefined ? { ...pickup, notifyBeforeMin: notifyBefore } : pickup;
  }

  /** `setDemoTime`, for one pickup. */
  private sweep(key: string, pickup: Pickup): Applied {
    const system: Actor = { kind: "system" };
    if (pickup.status === "open" && this.now >= pickup.wantedAt + 60 * minute) {
      return this.apply(key, pickup, system, { type: "expire" });
    }
    if (pickup.status === "arrived" && pickup.arrivedAt != null && this.now >= pickup.arrivedAt + 180 * minute) {
      return this.apply(key, pickup, system, { type: "close_unconfirmed" });
    }
    if (pickup.offer?.status === "pending" && pickup.offer.expiresAt <= this.now) {
      this.pickups.set(key, { ...pickup, offer: { ...pickup.offer, status: "expired" } });
      return { ok: true, code: null, ignored: false, events: ["offer_expired"] };
    }
    return { ok: true, code: null, ignored: false, events: [] };
  }

  /** `cannotGo` (open request, own assignment) and `answerOffer` (an offer to this driver) in vehicle.tsx. */
  private cannotGo(key: string, pickup: Pickup, actor: Actor): Applied {
    if (actor.kind !== "vehicle") throw new Error("vehicle_decline needs a vehicle actor");
    const offer = pickup.offer;
    const expectedVersion = pickup.version;
    if (pickup.status === "open") {
      if (offer?.status === "pending" && offer.fromMemberId == null && !offer.declinedBy.includes(actor.driverId)) {
        return this.apply(key, pickup, actor, { type: "respond_offer", expectedVersion, offerId: offer.id, response: "decline" });
      }
      // The demo records the refusal in its history only (`request_declined`); the pickup does not change.
      return { ok: true, code: null, ignored: false, events: ["request_declined"] };
    }
    const own = pickup.assigneeId === actor.driverId && pickup.vehicleId === actor.id;
    if (!own && offer?.status === "pending" && offer.fromMemberId !== actor.driverId) {
      return this.apply(key, pickup, actor, { type: "respond_offer", expectedVersion, offerId: offer.id, response: "decline" });
    }
    return this.apply(key, pickup, actor, { type: "offer", expectedVersion, offerId: this.id("offer") });
  }

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private outcome(before: Pickup, after: Pickup, applied: Applied): Outcome {
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
      ok: applied.ok,
      code: applied.code,
      ignored: applied.ignored,
      status: after.status,
      assignee: after.assigneeId,
      vehicle: after.vehicleId,
      version: after.version,
      round: after.assignmentRound,
      confirmed: after.destination.confirmed,
      destinationRevision: after.destinationRevision,
      navSession: after.navigation !== null,
      newNavSession: after.navigation !== null && after.navigation.sessionId !== before.navigation?.sessionId,
      set,
      offer,
      resolved,
      events: [...applied.events],
      active: Object.fromEntries(this.vehicles.map((vehicle) => [vehicle.id, vehicle.activePickupId ?? null])),
      pickupCount: this.pickups.size,
    };
  }
}

/** `makePickup` in apps/web/src/demo-domain.ts. */
function makePickup(id: string, requester: Requester, destination: Destination, wantedAt: number,
  source: Pickup["source"], assigneeId: string | null = null, vehicleId: string | null = null): Pickup {
  return {
    id, familyId, requester, destination, wantedAt, source, assigneeId, vehicleId,
    status: assigneeId ? "assigned" : "open", assignmentRound: assigneeId ? 1 : 0, version: 1, destinationRevision: 1,
    acceptedAt: null, navigation: null, offer: null, readyAt: null, notMetAt: null,
  };
}
