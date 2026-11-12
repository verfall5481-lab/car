// Shared vocabulary of the conformance suite: one scenario table runs against the TypeScript machine and its
// composition functions (`applyPickupAction` and src/composition.ts, which the browser demo calls) and against the SQL
// RPCs on the real migrations.
// Both drivers report every step as a normalized `Outcome`; `compare.ts` checks it against `Expect` and
// against the other implementation.
import type { OfferStatus, PickupStatus } from "../src/index.ts";

export type MemberSpec = { key: string; name: string; canDrive?: boolean; canRequest?: boolean };
export type RiderSpec = { key: string; name: string };
export type VehicleSpec = { key: string; name: string; driver: string; parked?: boolean };
export type PlaceSpec = { key: string; label: string; lat: number; lng: number; radiusM?: number };
export type PointSpec = { key: string; place: string; label: string; lat: number; lng: number; note?: string };

export type FamilySpec = {
  members: readonly MemberSpec[];
  riders: readonly RiderSpec[];
  vehicles: readonly VehicleSpec[];
  places: readonly PlaceSpec[];
  points: readonly PointSpec[];
};

export type LocationSpec =
  | { place: string }
  | { point: string }
  | { pin: { lat: number; lng: number; note?: string } }
  | { gps: { lat: number; lng: number; accuracyM?: number } };

/** A request goes through the request RPC (SQL) and the demo's request composition (TS). */
export type RequestSpec = {
  key: string;
  kind: "request";
  /** A rider key or a member key. */
  by: string;
  wantedInMin?: 0 | 10 | 20 | 30;
  at: LocationSpec;
};

/** A routine occurrence is inserted the way `ensure_occurrences` (SQL) and `routineOccurrence` (demo) build it. */
export type RoutineSpec = {
  key: string;
  kind: "routine";
  rider: string;
  place: string;
  wantedInMin: number;
  assignee?: string;
  vehicle?: string;
  notifyBeforeMin?: number;
  /**
   * Create the occurrence the way the scheduler does: SQL runs `ensure_occurrences` for the family's routines (so every
   * routine of such a scenario should set it), TS calls `newOccurrencePickup` with the day's unavailable members. Without
   * it the SQL row is inserted as the spec says.
   */
  generate?: boolean;
};

export type PickupSpec = RequestSpec | RoutineSpec;

/** "current" sends the version the caller last read; `{ stale: n }` sends a version n behind it. */
export type Version = "current" | { stale: number };

export type CancelReason = "cancelled" | "resolved_by_phone" | "mistake" | "other_way_home" | "other" | "not_met";

export type ActionSpec =
  | { type: "accept"; vehicle?: string }
  | { type: "offer"; to?: string; note?: string; version?: Version }
  /** Answers the pickup's latest offer. */
  | { type: "respond"; response: "accept" | "decline"; vehicle?: string; version?: Version }
  | { type: "cancel_offer"; version?: Version }
  | { type: "take_over"; vehicle?: string; version?: Version }
  | { type: "depart"; version?: Version }
  | { type: "undo"; version?: Version }
  /**
   * "출발하고 안내". `withOffer` passes the latest offer ID (as a card does), or with "family" the ID of the pickup's
   * family-wide offer, as a request or routine card drawn before a handoff still does. `retry` resends this car's
   * previous action ID.
   */
  | { type: "vehicle_start"; withOffer?: boolean | "family"; retry?: boolean; version?: Version }
  | { type: "nav_result"; result: "ok" | "failed" }
  | { type: "arrive"; version?: Version }
  /**
   * Navigation arrival callback. `session`: the newest session or the one before it. `revision`: the revision that
   * session was issued for, or the pickup's current one.
   */
  | { type: "nav_arrival"; session?: "current" | "previous"; revision?: "session" | "current" }
  | { type: "board"; version?: Version }
  | { type: "cancel"; reason?: CancelReason; version?: Version }
  | { type: "skip"; version?: Version }
  /** Without `place`, confirms the current destination as it is. */
  | { type: "confirm_location"; place?: string; version?: Version }
  | { type: "ready"; version?: Version }
  | { type: "not_met"; version?: Version }
  /** F-12 "못 가요". */
  | { type: "vehicle_decline"; version?: Version }
  /** One scheduler pass: `run_escalations` (SQL) and `sweepPickup` (TS, the demo's clock). Actor "system". */
  | { type: "sweep" }
  /**
   * A guardian saves the pickup's routine (`upsert_routine` -> `revise_routine`; TS `reviseOccurrence`). Fields left
   * out keep their value. `shiftMinutes` moves the routine's time; `dropDay` removes the occurrence's weekday.
   */
  | {
    type: "edit_routine"; assignee?: string | null; vehicle?: string | null; place?: string; shiftMinutes?: number;
    dropDay?: boolean; notifyBeforeMin?: number;
  }
  /** A guardian deletes the pickup's routine (`archive_routine`). */
  | { type: "archive_routine" }
  /** 24.3 #20, #21 "못 간다고 알리기" (`declare_no_driver`). `note` defaults to "학원 안에서 기다리기". */
  | { type: "no_driver"; note?: string; version?: Version }
  /** 24.3 #22 "알겠어" (`ack_fallback`). */
  | { type: "ack_fallback" }
  /**
   * The acting guardian marks (`unavailable`, the default) or clears a 못 가는 날 (`set_unavailable_day`; TS
   * `setUnavailableDay`, then `reviseForUnavailableDay` for every pickup on that day). The day is the step pickup's date,
   * or today plus `fromToday`.
   */
  | { type: "unavailable_day"; unavailable?: boolean; fromToday?: number };

export type ActionType = ActionSpec["type"];

export type OfferView = { from: string | null; to: string | null; declinedBy: string[]; expiresInMin: number };
/** The offer this step moved out of `pending`. `by` is the resolving member (TS knows it only for `accepted`). */
export type ResolvedView = { from: string | null; status: OfferStatus; by: string | null };

/** Lifecycle timestamps both implementations store. */
export type Stamp = "acceptedAt" | "enRouteAt" | "arrivedAt" | "readyAt" | "notMetAt";
/** Timestamps only the SQL row has. */
export type SqlStamp = "completedAt" | "cancelledAt" | "expiredAt" | "closedUnconfirmedAt";

/** Facts only the SQL side records; checked against `Expect.sql`, never compared. */
export type SqlFacts = {
  navStatus: "none" | "requested" | "ok" | "failed";
  cancelReason: string | null;
  stamps: SqlStamp[];
};

export type Outcome = {
  ok: boolean;
  code: string | null;
  /** With ALREADY_TAKEN: who holds the trip (SQL `detail.by`). */
  by: string | null;
  ignored: boolean;
  status: PickupStatus;
  assignee: string | null;
  vehicle: string | null;
  version: number;
  round: number;
  /** Minutes from now to wanted_at, rounded. */
  wantedInMin: number;
  confirmed: boolean;
  destinationRevision: number;
  /** SQL `is_customized`; a routine edit leaves a customized occurrence alone. */
  customized: boolean;
  /** SQL `routine_offer_created_at` is set: the occurrence was offered to every driver once. */
  announced: boolean;
  navSession: boolean;
  newNavSession: boolean;
  set: Stamp[];
  offer: OfferView | null;
  resolved: ResolvedView | null;
  events: string[];
  /** Vehicle key -> pickup key it is guiding to. */
  active: Record<string, string | null>;
  /** Pickups in the family, to show that an action did not create one. */
  pickupCount: number;
  /** SQL `cancel_reason`; TS `Pickup.cancelReason`. */
  cancelReason: string | null;
  /** "대신 할 일" and who declared that nobody can go (24.3 #20, #21). */
  fallbackNote: string | null;
  fallbackBy: string | null;
  /** The requester pressed "알겠어" (24.3 #22). */
  fallbackAcked: boolean;
  /** 24.2 갈 수 있는 운전자 of an open pickup, sorted; `null` for any other status. `[]` is "갈 사람 없음". */
  available: string[] | null;
  sql?: SqlFacts;
};

export const comparedFields = [
  "ok", "code", "by", "ignored", "status", "assignee", "vehicle", "version", "round", "wantedInMin", "confirmed",
  "destinationRevision", "customized", "announced", "navSession", "newNavSession", "set", "offer", "resolved", "events",
  "active", "pickupCount", "cancelReason", "fallbackNote", "fallbackBy", "fallbackAcked", "available",
] as const;
export type ComparedField = typeof comparedFields[number];

export type Expect = {
  /** Omitted: the step must succeed. */
  code?: string;
  by?: string | null;
  ignored?: boolean;
  status?: PickupStatus;
  assignee?: string | null;
  vehicle?: string | null;
  version?: number;
  round?: number;
  wantedInMin?: number;
  confirmed?: boolean;
  destinationRevision?: number;
  customized?: boolean;
  announced?: boolean;
  navSession?: boolean;
  newNavSession?: boolean;
  /** The exact set of `Stamp`s that are set after the step. */
  set?: Stamp[];
  /** The pending offer after the step. Fields left out are not checked. */
  offer?: (Pick<OfferView, "from" | "to"> & Partial<OfferView>) | null;
  resolved?: { from: string | null; status: OfferStatus; by?: string | null } | null;
  events?: string[];
  active?: Record<string, string | null>;
  pickupCount?: number;
  cancelReason?: string | null;
  fallbackNote?: string | null;
  fallbackBy?: string | null;
  fallbackAcked?: boolean;
  /** Compared as a set. */
  available?: string[] | null;
  /** Checked on the SQL side only. `events` there is for steps whose events are not comparable. */
  sql?: Partial<SqlFacts> & { events?: string[] };
};

/** Why a field cannot be compared for one step; the field is still checked against `Expect` on each side. */
export type NotComparable = Partial<Record<ComparedField, string>>;

export type ActStep = {
  actor: string;
  /** Defaults to the scenario's first pickup. */
  pickup?: string;
  do: ActionSpec;
  expect: Expect;
  /** The step reproduces an entry of `knownDivergences`. */
  divergence?: string;
  notComparable?: NotComparable;
};
export type ClockStep = { clock: number };
export type ParkStep = { park: string; parked: boolean };
export type RoleStep = { member: string; canDrive: boolean };
/** The car's current driver changes while it is parked (`vehicle_set_driver`; the demo refuses it mid-trip, P-15). */
export type DriverStep = { driver: string; member: string };
export type Step = ActStep | ClockStep | ParkStep | RoleStep | DriverStep;

/** A 못 가는 날 marked through `set_unavailable_day` before any pickup exists: the date the pickup spec will have. */
export type UnavailableSpec = { member: string; dayOf: string };

export type Scenario = {
  name: string;
  family?: Partial<FamilySpec>;
  /** Days marked before the pickups are created. */
  unavailable?: readonly UnavailableSpec[];
  pickups: readonly PickupSpec[];
  /** Expectations on each pickup right after it is created. */
  created?: Partial<Record<string, Expect>>;
  steps: readonly Step[];
  /** Applies to every step of the scenario. */
  notComparable?: NotComparable;
};

export type KnownDivergence = {
  id: string;
  /** The side that does not meet the scenario's expectation. */
  wrong: "sql" | "ts";
  spec: string;
  summary: string;
};

export type Run = {
  created: Record<string, Outcome>;
  /** Aligned with `scenario.steps`; `null` for clock, park, role and driver steps. */
  steps: (Outcome | null)[];
};

export const minute = 60_000;

export const defaultFamily: FamilySpec = {
  members: [
    { key: "mom", name: "엄마" },
    { key: "dad", name: "아빠" },
    { key: "aunt", name: "이모", canDrive: false },
  ],
  riders: [{ key: "minjun", name: "민준" }],
  vehicles: [{ key: "car", name: "우리 차", driver: "dad", parked: true }],
  places: [
    { key: "academy", label: "수학학원", lat: 37.5001, lng: 127.0371 },
    { key: "home", label: "집", lat: 37.5222, lng: 127.0465 },
  ],
  points: [{ key: "back", place: "academy", label: "후문 주차장", lat: 37.5006, lng: 127.0374, note: "후문 벤치 앞" }],
};

export function familyOf(scenario: Scenario): FamilySpec {
  return { ...defaultFamily, ...scenario.family };
}

export function isAct(step: Step): step is ActStep {
  return "do" in step;
}

export function versionOf(current: number, version: Version | undefined): number {
  return version === undefined || version === "current" ? current : current - version.stale;
}

export function expiresInMin(expiresAt: number, now: number): number {
  return Math.round((expiresAt - now) / minute);
}
