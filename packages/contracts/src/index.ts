export type PickupStatus =
  | "open"
  | "assigned"
  | "en_route"
  | "arrived"
  | "completed"
  | "cancelled"
  | "expired"
  | "closed_unconfirmed";

export type OfferStatus = "pending" | "accepted" | "declined" | "expired" | "cancelled" | "superseded";
export type LocationSource = "saved_point" | "saved_place" | "map_pin" | "gps";
export type Coordinates = { lat: number; lng: number };
export type Destination = Coordinates & {
  source: LocationSource;
  label: string;
  confirmed: boolean;
  note?: string;
  placeId?: string;
  pickupPointId?: string;
};
export type Place = Coordinates & {
  id: string;
  familyId: string;
  label: string;
  radiusM?: number;
  archivedAt?: number | null;
};
export type PickupPoint = Coordinates & {
  id: string;
  familyId: string;
  placeId: string;
  label: string;
  note?: string;
  archivedAt?: number | null;
};
export type LocationInput =
  | { source: "saved_place"; placeId: string }
  | { source: "saved_point"; pickupPointId: string }
  | { source: "map_pin"; lat: number; lng: number; note?: string; label?: string; currentLocation?: Coordinates }
  | { source: "gps"; lat: number; lng: number; accuracyM?: number | null; label?: string };

export type Member = {
  id: string;
  familyId: string;
  canDrive: boolean;
  canRequest: boolean;
  leftAt?: number | null;
};
export type Vehicle = {
  id: string;
  familyId: string;
  currentDriverId: string | null;
  activePickupId?: string | null;
  activeSessionId?: string | null;
  activeDestinationRevision?: number | null;
};
export type Requester = { kind: "rider" | "member"; id: string };
export type PickupOffer = {
  id: string;
  status: OfferStatus;
  fromMemberId: string | null;
  toMemberId: string | null;
  expiresAt: number;
  note?: string;
  declinedBy: readonly string[];
  acceptedBy?: string;
};
export type Pickup = {
  id: string;
  familyId: string;
  requester: Requester;
  source: "request" | "routine";
  status: PickupStatus;
  version: number;
  assignmentRound: number;
  assigneeId: string | null;
  vehicleId: string | null;
  destination: Destination;
  destinationRevision: number;
  wantedAt: number;
  acceptedAt: number | null;
  navigation: { sessionId: string; destinationRevision: number; actionId: string } | null;
  offer: PickupOffer | null;
  readyAt: number | null;
  notMetAt: number | null;
  arrivedAt?: number | null;
  enRouteAt?: number | null;
  /** A routine occurrence's `notify_before_min`, which bounds a handoff's expiry (F-11). Absent means 20. */
  notifyBeforeMin?: number | null;
  /** SQL `is_customized`: someone changed this occurrence, so a routine edit leaves it alone (F-07, S-16, S-28). */
  customized?: boolean;
  /** SQL `routine_offer_created_at`: an open occurrence is offered to every driver once (4.4 #4, F-21, A.4). */
  routineOfferAt?: number | null;
};

export type Actor =
  | Requester
  | { kind: "vehicle"; id: string; driverId: string; parked: boolean }
  | { kind: "system" };

type Versioned = { expectedVersion: number };
export type PickupAction =
  | { type: "accept"; vehicleId?: string }
  | (Versioned & { type: "offer"; offerId: string; toMemberId?: string; note?: string })
  | (Versioned & { type: "respond_offer"; offerId: string; response: "accept" | "decline"; vehicleId?: string })
  | (Versioned & { type: "cancel_offer"; offerId: string })
  | (Versioned & { type: "take_over"; vehicleId?: string })
  | (Versioned & { type: "depart" | "undo_en_route" })
  | (Versioned & { type: "vehicle_start"; actionId: string; sessionId: string; offerId?: string })
  | (Versioned & { type: "arrive"; source: "manual" })
  | { type: "arrive"; source: "nav_callback"; sessionId: string; destinationRevision: number }
  | (Versioned & { type: "board" | "ready" | "not_met" })
  | (Versioned & { type: "cancel"; reason?: "not_met" | "cancelled" | "skipped" | "phone_resolved" | "misclick" |
    "other_transport" | "resolved_by_phone" | "mistake" | "other_way_home" | "other" })
  | (Versioned & { type: "confirm_location"; destination: Destination })
  | { type: "expire" | "close_unconfirmed" };

export type PickupError =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_STATE"
  | "STALE_VERSION"
  | "ALREADY_TAKEN"
  | "LOCATION_UNCONFIRMED"
  | "OFFER_NOT_PENDING"
  | "CANNOT_ACCEPT_OWN_OFFER"
  | "NOT_ASSIGNEE"
  | "ALREADY_EN_ROUTE"
  | "VALIDATION"
  | "PICKUP_EXPIRED"
  | "NO_VALID_OFFER"
  | "RATE_LIMITED";

export type PickupEvent =
  | "accepted"
  | "offered"
  | "offer_accepted"
  | "offer_declined"
  | "offer_cancelled"
  | "offer_expired"
  | "took_over"
  | "en_route"
  | "en_route_undone"
  | "navigation_requested"
  | "arrived"
  | "arrival_ignored"
  | "completed"
  | "cancelled"
  | "expired"
  | "location_confirmed"
  | "rider_ready"
  | "not_met_reported"
  | "closed_unconfirmed"
  /** F-12: a car's "못 가요" on an open request (`vehicle_decline`). */
  | "request_declined"
  /** 4.4 #12: a routine edit gave a non-customized occurrence another holder. */
  | "routine_reassigned"
  /** A member left or was removed and their trip moved to another guardian (server only). */
  | "member_reassigned";

export type PickupResult =
  | { ok: true; pickup: Pickup; events: readonly PickupEvent[]; ignored?: true }
  | { ok: false; code: PickupError; pickup: Pickup; events: readonly PickupEvent[] };

export type PickupContext = {
  now: number;
  members: readonly Member[];
  vehicles?: readonly Vehicle[];
};

const minute = 60_000;

export function isActivePickup(pickup: Pickup | PickupStatus): boolean {
  const status = typeof pickup === "string" ? pickup : pickup.status;
  return status === "open" || status === "assigned" || status === "en_route" || status === "arrived";
}

export function canRequestPickup(
  requester: Requester,
  familyId: string,
  members: readonly Member[],
  riders: readonly { id: string; familyId: string; archivedAt?: number | null }[],
): boolean {
  if (requester.kind === "rider") {
    return riders.some((rider) => rider.id === requester.id && rider.familyId === familyId && rider.archivedAt == null);
  }
  return members.some((member) =>
    member.id === requester.id && member.familyId === familyId && member.leftAt == null && member.canRequest
  );
}

export function requestRecipients(
  pickup: Pick<Pickup, "familyId" | "requester">,
  members: readonly Member[],
  vehicles: readonly Vehicle[] = [],
): { memberIds: string[]; vehicleIds: string[] } {
  const memberIds = members.filter((member) =>
    member.familyId === pickup.familyId &&
    member.leftAt == null &&
    member.canDrive &&
    (pickup.requester.kind !== "member" || member.id !== pickup.requester.id)
  ).map(({ id }) => id);
  const recipientIds = new Set(memberIds);
  const vehicleIds = vehicles.filter((vehicle) =>
    vehicle.familyId === pickup.familyId &&
    vehicle.currentDriverId !== null &&
    recipientIds.has(vehicle.currentDriverId)
  ).map(({ id }) => id);
  return { memberIds, vehicleIds };
}

export function isCoordinates(point: Coordinates): boolean {
  return Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 &&
    Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

function isKoreanPin(point: Coordinates): boolean {
  return point.lat >= 33 && point.lat <= 39 && point.lng >= 124 && point.lng <= 132;
}

export function distanceMetres(from: Coordinates, to: Coordinates): number {
  const radians = Math.PI / 180;
  const a = Math.sin((to.lat - from.lat) * radians / 2) ** 2 +
    Math.cos(from.lat * radians) * Math.cos(to.lat * radians) *
      Math.sin((to.lng - from.lng) * radians / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(a, 1)));
}

export function resolveDestination(
  familyId: string,
  input: LocationInput,
  places: readonly Place[],
  points: readonly PickupPoint[] = [],
): Destination | null {
  const available = places.filter((place) => place.familyId === familyId && place.archivedAt == null);
  switch (input.source) {
    case "saved_point": {
      const point = points.find((candidate) =>
        candidate.id === input.pickupPointId && candidate.familyId === familyId && candidate.archivedAt == null
      );
      const place = available.find((candidate) => candidate.id === point?.placeId);
      if (!point || !place || !isCoordinates(point)) return null;
      return { source: input.source, lat: point.lat, lng: point.lng, label: point.label, note: point.note,
        confirmed: true, placeId: place.id, pickupPointId: point.id };
    }
    case "saved_place": {
      const place = available.find((candidate) => candidate.id === input.placeId);
      return place && isCoordinates(place)
        ? { source: input.source, lat: place.lat, lng: place.lng, label: place.label, confirmed: true, placeId: place.id }
        : null;
    }
    case "map_pin":
      if (!isCoordinates(input) || !isKoreanPin(input) || (input.note?.length ?? 0) > 40 ||
          (input.currentLocation && (!isCoordinates(input.currentLocation) || distanceMetres(input, input.currentLocation) > 50_000))) {
        return null;
      }
      return { source: input.source, lat: input.lat, lng: input.lng, label: input.label?.trim() || "지도에서 고른 곳",
        confirmed: true, note: input.note };
    case "gps": {
      const accuracy = input.accuracyM ?? 50;
      if (!isCoordinates(input) || !Number.isFinite(accuracy) || accuracy < 0) return null;
      const nearest = accuracy > 300 ? undefined : available.filter(isCoordinates)
        .map((place) => ({ place, distance: distanceMetres(input, place) }))
        .filter(({ place, distance }) => distance <= Math.max(place.radiusM ?? 150, accuracy))
        .sort((a, b) => a.distance - b.distance)[0];
      return nearest
        ? { source: input.source, lat: nearest.place.lat, lng: nearest.place.lng, label: nearest.place.label,
          confirmed: true, placeId: nearest.place.id }
        : { source: input.source, lat: input.lat, lng: input.lng, label: input.label?.trim() || "현재 위치", confirmed: false };
    }
  }
}

/** The family-wide offer of an open routine occurrence (4.4 #4): it lasts until wanted_at, and at least 10 minutes. */
export function routineFamilyOffer(pickup: Pick<Pickup, "id" | "wantedAt">, now: number): PickupOffer {
  return {
    id: `${pickup.id}:routine`, status: "pending", fromMemberId: null, toMemberId: null,
    expiresAt: Math.max(pickup.wantedAt, now + 10 * minute), declinedBy: [],
  };
}

function closeOffer(offer: PickupOffer | null, status: OfferStatus): PickupOffer | null {
  return offer?.status === "pending" ? { ...offer, status } : offer;
}

export function applyPickupAction(pickup: Pickup, actor: Actor, action: PickupAction, context: PickupContext): PickupResult {
  const { now } = context;
  const ok = (next = pickup, ...events: PickupEvent[]): PickupResult => ({ ok: true, pickup: next, events });
  const fail = (code: PickupError, next = pickup, ...events: PickupEvent[]): PickupResult =>
    ({ ok: false, code, pickup: next, events });
  const update = (changes: Partial<Pickup>): Pickup => ({ ...pickup, version: pickup.version + 1, ...changes });
  const memberId = actor.kind === "vehicle" ? actor.driverId : actor.kind === "member" ? actor.id : null;
  const member = context.members.find((entry) =>
    entry.id === memberId && entry.familyId === pickup.familyId && entry.leftAt == null
  );
  const vehicle = actor.kind === "vehicle" ? context.vehicles?.find((entry) =>
    entry.id === actor.id && entry.familyId === pickup.familyId && entry.currentDriverId === actor.driverId
  ) : undefined;
  const isRequester = actor.kind === pickup.requester.kind && actor.id === pickup.requester.id;
  const isAssignee = !!member && (actor.kind === "vehicle" ? pickup.vehicleId === actor.id : member.id === pickup.assigneeId);
  const recipients = requestRecipients(pickup, context.members).memberIds;
  const isDriver = !!member && recipients.includes(member.id);
  const offer = pickup.offer;
  const actionOffer = "offerId" in action && action.offerId === offer?.id ? offer : null;
  // SQL marks a routine occurrence customized when it is taken; some transitions mark any pickup.
  const takenRoutine = Boolean(pickup.customized) || pickup.source === "routine";

  if ((actor.kind === "member" && !member) || (actor.kind === "rider" && !isRequester) ||
      (actor.kind === "vehicle" && (!member || (context.vehicles !== undefined && !vehicle)))) {
    return fail("NOT_FOUND");
  }
  if (actor.kind === "system" && action.type !== "expire" && action.type !== "close_unconfirmed") {
    return fail("FORBIDDEN");
  }
  // As in SQL, a car acts only on its own trip, an open pickup, its driver's assignment or an offer to its driver.
  // Anything else is NOT_FOUND, except that a car that lost the race still learns why (F-10, 8.3.1).
  if (actor.kind === "vehicle" && !isAssignee) {
    if (!isDriver) return fail("NOT_FOUND");
    const visible = pickup.status === "open" ||
      (pickup.status === "assigned" && pickup.assigneeId === member.id) ||
      (offer?.status === "pending" && isOfferTarget(offer));
    if (!visible && action.type !== "accept" && action.type !== "vehicle_start") return fail("NOT_FOUND");
  }

  if (action.type === "accept" && isDriver && member.id === pickup.assigneeId && pickup.acceptedAt !== null &&
      isActivePickup(pickup) && (actor.kind !== "vehicle" || isAssignee)) return ok();
  if (action.type === "respond_offer" && isDriver && actionOffer?.status === "accepted" &&
      action.response === "accept" && actionOffer.acceptedBy === member.id) return ok();
  if (action.type === "vehicle_start" && actor.kind === "vehicle" && isAssignee && isDriver &&
      pickup.status === "en_route" && pickup.navigation?.actionId === action.actionId) {
    return pickup.navigation.destinationRevision === pickup.destinationRevision &&
      (context.vehicles === undefined || vehicle?.activeSessionId === pickup.navigation.sessionId)
      ? ok() : fail("STALE_VERSION");
  }

  if ("expectedVersion" in action && action.expectedVersion !== pickup.version) return fail("STALE_VERSION");

  function expire(): Pickup {
    return update({ status: "expired", offer: closeOffer(offer, "expired") });
  }

  function assign(id: string, vehicleId: string | null): Partial<Pickup> {
    return {
      status: "assigned",
      assigneeId: id,
      vehicleId,
      acceptedAt: now,
      assignmentRound: pickup.assignmentRound + Number(pickup.assigneeId !== id),
    };
  }

  function getVehicleId(explicit?: string): string | null | undefined {
    if (actor.kind === "vehicle") return actor.id;
    if (explicit === undefined) return null;
    return context.vehicles?.some((entry) =>
      entry.id === explicit && entry.familyId === pickup.familyId && entry.currentDriverId === memberId
    ) ? explicit : undefined;
  }

  function isOfferTarget(candidate: PickupOffer): boolean {
    return isDriver && member.id !== candidate.fromMemberId &&
      (candidate.toMemberId === null || candidate.toMemberId === member.id);
  }

  switch (action.type) {
    case "accept": {
      if (!isDriver) return fail("FORBIDDEN");
      if (pickup.status === "open" && now >= pickup.wantedAt + 60 * minute) return fail("PICKUP_EXPIRED", expire(), "expired");
      if ((pickup.status === "assigned" || pickup.status === "en_route" || pickup.status === "arrived") &&
          pickup.assigneeId !== member.id) return fail("ALREADY_TAKEN");
      if (pickup.status !== "open" && pickup.status !== "assigned") return fail("INVALID_STATE");
      const vehicleId = getVehicleId(action.vehicleId);
      if (vehicleId === undefined) return fail("VALIDATION");
      // 4.4 #5: only a target accepts an offer. The default assignee confirming a trip they had offered away
      // (a handoff or the car's "못 가요") withdraws that offer instead (4.4 #9, F-11), as accept_pickup does.
      let nextOffer = offer;
      if (offer?.status === "pending") {
        nextOffer = isOfferTarget(offer)
          ? { ...offer, status: "accepted", acceptedBy: member.id }
          : { ...offer, status: "cancelled" };
      }
      return ok(update({
        ...assign(member.id, vehicleId ?? (pickup.assigneeId === member.id ? pickup.vehicleId : null)),
        offer: nextOffer,
        customized: takenRoutine,
      }), "accepted");
    }
    case "offer": {
      // Same as SQL: an assignee who lost can_drive may still hand off; a vehicle offers only for an eligible driver.
      if (!isAssignee || member.id !== pickup.assigneeId || (actor.kind === "vehicle" && !isDriver)) return fail("NOT_ASSIGNEE");
      // 2.2: a car hands off only by declining to everyone; picking a recipient or writing a note is a phone action.
      if (actor.kind === "vehicle" && (action.toMemberId != null || action.note != null)) return fail("FORBIDDEN");
      if (pickup.status !== "assigned") return fail("INVALID_STATE");
      if (action.toMemberId === memberId) return fail("CANNOT_ACCEPT_OWN_OFFER");
      // As offer_pickup: a target who is not an eligible driver is not found; an over-long note is malformed input.
      if (action.toMemberId && !recipients.includes(action.toMemberId)) return fail("NOT_FOUND");
      if ((action.note?.length ?? 0) > 40) return fail("VALIDATION");
      if (offer?.id === action.offerId && offer.status === "pending") return ok();
      const limit = Math.min(now + 10 * minute, pickup.wantedAt - (pickup.notifyBeforeMin ?? 20) * minute);
      return ok({ ...pickup, customized: takenRoutine,
        offer: { id: action.offerId, status: "pending", fromMemberId: memberId,
        toMemberId: action.toMemberId ?? null, expiresAt: limit > now ? limit : now + 5 * minute,
        note: action.note, declinedBy: [] } }, "offered");
    }
    case "respond_offer": {
      if (!actionOffer) return fail("OFFER_NOT_PENDING");
      if (memberId === actionOffer.fromMemberId) return fail("CANNOT_ACCEPT_OWN_OFFER");
      if (!isOfferTarget(actionOffer)) return fail("FORBIDDEN");
      if (actionOffer.status !== "pending") return fail("OFFER_NOT_PENDING");
      if (pickup.status === "open" && now >= pickup.wantedAt + 60 * minute) return fail("PICKUP_EXPIRED", expire(), "expired");
      if (now >= actionOffer.expiresAt) return fail("OFFER_NOT_PENDING", { ...pickup, offer: { ...actionOffer, status: "expired" } }, "offer_expired");
      if (pickup.status !== "open" && pickup.status !== "assigned") return fail("INVALID_STATE");
      if (action.response === "decline") {
        if (actionOffer.declinedBy.includes(memberId!)) return ok();
        const declinedBy = [...actionOffer.declinedBy, memberId!];
        const everyoneDeclined = recipients.filter((id) => id !== actionOffer.fromMemberId)
          .every((id) => declinedBy.includes(id));
        return ok({ ...pickup, offer: { ...actionOffer, declinedBy,
          status: actionOffer.toMemberId !== null || everyoneDeclined ? "declined" : "pending" } }, "offer_declined");
      }
      const vehicleId = getVehicleId(action.vehicleId);
      if (vehicleId === undefined) return fail("VALIDATION");
      return ok(update({ ...assign(memberId!, vehicleId), customized: true,
        offer: { ...actionOffer, status: "accepted", acceptedBy: memberId! } }), "offer_accepted");
    }
    case "cancel_offer":
      if (actor.kind !== "member" || actionOffer?.fromMemberId !== actor.id) return fail("FORBIDDEN");
      if (actionOffer.status !== "pending") return fail("OFFER_NOT_PENDING");
      return ok({ ...pickup, offer: { ...actionOffer, status: "cancelled" } }, "offer_cancelled");
    case "take_over": {
      if (actor.kind !== "member" || !isDriver) return fail("FORBIDDEN");
      if (pickup.status === "en_route") return fail("ALREADY_EN_ROUTE");
      if (pickup.status !== "assigned") return fail("INVALID_STATE");
      if (pickup.assigneeId === member.id) return ok();
      const vehicleId = getVehicleId(action.vehicleId);
      if (vehicleId === undefined) return fail("VALIDATION");
      return ok(update({ ...assign(member.id, vehicleId), customized: takenRoutine, offer: closeOffer(offer, "cancelled") }),
        "took_over");
    }
    case "depart":
      if (actor.kind !== "member" || !isAssignee) return fail("NOT_ASSIGNEE");
      // 23.1: holding a trip after can_drive was turned off does not allow driving it.
      if (!isDriver) return fail("FORBIDDEN");
      if (pickup.status !== "assigned") return fail("INVALID_STATE");
      if (!pickup.destination.confirmed) return fail("LOCATION_UNCONFIRMED");
      return ok(update({ status: "en_route", enRouteAt: now, offer: closeOffer(offer, "cancelled") }), "en_route");
    case "undo_en_route":
      if (!isAssignee) return fail("NOT_ASSIGNEE");
      if (pickup.status !== "en_route" || pickup.enRouteAt == null || now - pickup.enRouteAt > 5 * minute) return fail("INVALID_STATE");
      return ok(update({ status: "assigned", enRouteAt: null, navigation: null }), "en_route_undone");
    case "vehicle_start": {
      if (actor.kind !== "vehicle" || !isDriver) return fail("FORBIDDEN");
      if (pickup.status === "open" && now >= pickup.wantedAt + 60 * minute) return fail("PICKUP_EXPIRED", expire(), "expired");
      if (!pickup.destination.confirmed) return fail("LOCATION_UNCONFIRMED");
      // A moving car cannot switch guidance (8.3.1); that refusal comes before the 15-minute rule, as in SQL.
      if (vehicle?.activePickupId && vehicle.activePickupId !== pickup.id && !actor.parked) return fail("FORBIDDEN");
      if (pickup.wantedAt > now + 15 * minute && pickup.status === "open") return fail("INVALID_STATE");
      const navigation = { sessionId: action.sessionId, destinationRevision: pickup.destinationRevision, actionId: action.actionId };
      if (pickup.status === "en_route" && isAssignee) {
        return ok({ ...pickup, navigation }, "navigation_requested");
      }
      if (pickup.status === "open") {
        const nextOffer = offer?.status === "pending" ? { ...offer, status: "accepted" as const, acceptedBy: member.id } : offer;
        return ok(update({
          ...assign(member.id, actor.id), status: "en_route", enRouteAt: now, navigation, offer: nextOffer, customized: takenRoutine,
        }), "accepted", "en_route");
      }
      // A car that pressed "출발하고 안내" on a request or routine card and lost the race hears who took it (V-03).
      // From a handoff card (with an offer ID) an offer that is not valid for this driver is NO_VALID_OFFER (8.3.1).
      const heldByOther = (pickup.status === "assigned" || pickup.status === "en_route" || pickup.status === "arrived") &&
        pickup.assigneeId !== member.id;
      if (heldByOther && action.offerId === undefined) return fail("ALREADY_TAKEN");
      if (pickup.status !== "assigned") return fail("INVALID_STATE");
      if (pickup.assigneeId === member.id) {
        return ok(update({ status: "en_route", enRouteAt: now, vehicleId: actor.id, navigation, offer: closeOffer(offer, "cancelled") }), "en_route");
      }
      if (!actionOffer || actionOffer.status !== "pending" || !isOfferTarget(actionOffer)) return fail("NO_VALID_OFFER");
      if (now >= actionOffer.expiresAt) {
        return fail("NO_VALID_OFFER", { ...pickup, offer: { ...actionOffer, status: "expired" } }, "offer_expired");
      }
      return ok(update({ ...assign(member.id, actor.id), status: "en_route", enRouteAt: now, navigation, customized: takenRoutine,
        offer: { ...actionOffer, status: "accepted", acceptedBy: member.id } }), "offer_accepted", "en_route");
    }
    case "arrive":
      if (!isAssignee) return fail("NOT_ASSIGNEE");
      if (action.source === "nav_callback") {
        if (actor.kind !== "vehicle") return fail("FORBIDDEN");
        if (pickup.status !== "en_route" || pickup.navigation?.sessionId !== action.sessionId ||
            pickup.navigation.destinationRevision !== action.destinationRevision ||
            pickup.destinationRevision !== action.destinationRevision || vehicle?.activePickupId !== pickup.id ||
            vehicle.activeSessionId !== action.sessionId || vehicle.activeDestinationRevision !== action.destinationRevision) {
          return { ok: true, pickup, events: ["arrival_ignored"], ignored: true };
        }
      }
      if (pickup.status !== "en_route") return fail("INVALID_STATE");
      return ok(update({ status: "arrived", arrivedAt: now }), "arrived");
    case "board":
      if (!isAssignee && !isRequester) return fail("FORBIDDEN");
      if (actor.kind === "vehicle" && !actor.parked) return fail("FORBIDDEN");
      if (pickup.status !== "arrived") return fail("INVALID_STATE");
      return ok(update({ status: "completed" }), "completed");
    case "cancel":
      if (actor.kind !== "member" && !isRequester) return fail("FORBIDDEN");
      if (action.reason === "skipped" && (actor.kind !== "member" || pickup.source !== "routine" ||
          (pickup.status !== "open" && pickup.status !== "assigned"))) return fail("INVALID_STATE");
      if (!isActivePickup(pickup) || (pickup.status === "arrived" && (actor.kind !== "member" || action.reason !== "not_met")) ||
          (actor.kind === "rider" && pickup.source !== "request")) return fail("INVALID_STATE");
      return ok(update({ status: "cancelled", offer: closeOffer(offer, "cancelled"), customized: true }), "cancelled");
    case "confirm_location": {
      if (actor.kind !== "member" && (actor.kind !== "vehicle" || !actor.parked || !isDriver)) return fail("FORBIDDEN");
      if (!isActivePickup(pickup)) return fail("INVALID_STATE");
      if (!isCoordinates(action.destination) || !action.destination.label.trim() || action.destination.label.length > 40) return fail("VALIDATION");
      const previous = pickup.destination;
      const next = action.destination;
      const changed = previous.lat !== next.lat || previous.lng !== next.lng || previous.label !== next.label ||
        previous.source !== next.source || previous.note !== next.note || previous.placeId !== next.placeId ||
        previous.pickupPointId !== next.pickupPointId;
      if (!changed && pickup.destination.confirmed) return ok();
      return ok(update({ destination: { ...action.destination, confirmed: true }, customized: true,
        destinationRevision: pickup.destinationRevision + Number(changed) }), "location_confirmed");
    }
    case "ready": {
      if (!isRequester) return fail("FORBIDDEN");
      if (pickup.source !== "routine" || (pickup.status !== "open" && pickup.status !== "assigned")) return fail("INVALID_STATE");
      if (pickup.readyAt !== null) return ok();
      // 4.3 #16, F-15: an occurrence nobody has taken is offered to every driver, once (as rider_ready_early).
      if (pickup.status === "open" && offer?.status !== "pending" && pickup.routineOfferAt == null) {
        return ok(update({ readyAt: now, offer: routineFamilyOffer(pickup, now), routineOfferAt: now }), "rider_ready");
      }
      return ok(update({ readyAt: now }), "rider_ready");
    }
    case "not_met":
      if (!isRequester) return fail("FORBIDDEN");
      if (pickup.status !== "arrived") return fail("INVALID_STATE");
      if (pickup.notMetAt !== null && now - pickup.notMetAt < 5 * minute) return fail("RATE_LIMITED");
      return ok({ ...pickup, notMetAt: now }, "not_met_reported");
    case "expire":
      if (actor.kind !== "system") return fail("FORBIDDEN");
      if (pickup.status !== "open" || now < pickup.wantedAt + 60 * minute) return fail("INVALID_STATE");
      return ok(expire(), "expired");
    case "close_unconfirmed":
      if (actor.kind !== "system") return fail("FORBIDDEN");
      if (pickup.status !== "arrived" || pickup.arrivedAt == null || now - pickup.arrivedAt < 180 * minute) return fail("INVALID_STATE");
      return ok(update({ status: "closed_unconfirmed" }), "closed_unconfirmed");
  }
}

export * from "./composition.ts";
