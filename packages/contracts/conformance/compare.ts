// Checks each implementation's normalized outcome against the scenario's expectation, and the two outcomes against
// each other. A difference fails unless the step names an entry of `knownDivergences`; an entry that no longer
// reproduces fails too, so the list stays honest.
import { isDeepStrictEqual } from "node:util";
import { comparedFields, isAct } from "./model.ts";
import type {
  ActStep,
  Expect,
  KnownDivergence,
  NotComparable,
  Outcome,
  Run,
  Scenario,
  Shape,
} from "./model.ts";

type Side = "ts" | "sql";

/** Gaps that hold for every scenario. Per-step gaps are written next to the step (`notComparable`). */
export const inherentGaps: readonly { field: string; reason: string }[] = [
  {
    field: "resolved.by (unless accepted)",
    reason: "PickupOffer records only acceptedBy; SQL resolved_by_member_id also names who declined or withdrew.",
  },
  { field: "sql.navStatus", reason: "TS has no nav_status and no report_nav_result; the demo keeps navigation failure on the car." },
  { field: "sql.customized", reason: "TS has no is_customized; routine revision lives only in SQL." },
  {
    field: "sql.cancelReason",
    reason: "TS neither stores nor checks the reason at run time (only its type does); SQL maps and validates it.",
  },
  {
    field: "sql.stamps",
    reason: "TS has no completed_at, cancelled_at, expired_at or closed_unconfirmed_at; the status says the same.",
  },
  { field: "creation events", reason: "SQL writes `created`; the demo writes a `requested` history row, not a PickupEvent." },
  {
    field: "offers without a sender (demo shape)",
    reason: "demo-domain.ts makePickup creates requests without the family-wide request offer of create_request.",
  },
  {
    field: "report_nav_result",
    reason: "SQL only. The TS driver treats it as a no-op; those steps compare state, and their events are marked per step.",
  },
  {
    field: "routine recompute and member removal",
    reason: "SQL only (revise_routine with routine_reassigned, 4.4 #12; leave_family/remove_member with member_reassigned). " +
      "TS has no such actions and the demo's routine editor does not recompute occurrences.",
  },
  {
    field: "parked state",
    reason: "TS reads Actor.parked; SQL reads a gear 'P' row no older than 30 s. The harness refreshes that row before each " +
      "step, so stale telemetry is not compared.",
  },
  {
    field: "request preconditions",
    reason: "Request creation is setup: SQL's 3-per-10-minutes limit and ACTIVE_REQUEST_EXISTS, and the demo's NO_DRIVER and " +
      "ACTIVE_REQUEST checks, are not compared.",
  },
  {
    field: "vehicle_decline and the scheduler",
    reason: "Neither is in packages/contracts. The TS driver mirrors apps/web (vehicle.tsx cannotGo/answerOffer, " +
      "demo-domain.ts setDemoTime); SQL runs vehicle_decline and run_escalations.",
  },
];

/** In the demo shape the TS side has no family-wide offers, so neither side's are compared. */
function shaped(outcome: Outcome, shape: Shape): Outcome {
  if (shape === "spec") return outcome;
  return {
    ...outcome,
    offer: outcome.offer?.from === null ? null : outcome.offer,
    resolved: outcome.resolved?.from === null ? null : outcome.resolved,
  };
}

function shapedExpect(expect: Expect, shape: Shape): Expect {
  if (shape === "spec") return expect;
  return {
    ...expect,
    offer: expect.offer?.from === null ? null : expect.offer,
    resolved: expect.resolved?.from === null ? null : expect.resolved,
  };
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

function sorted<T>(values: readonly T[]): T[] {
  return [...values].sort();
}

export function expectationErrors(raw: Outcome, rawExpect: Expect, side: Side, shape: Shape): string[] {
  const outcome = shaped(raw, shape);
  const expect = shapedExpect(rawExpect, shape);
  const errors: string[] = [];
  const mismatch = (field: string, expected: unknown, actual: unknown) => {
    if (!isDeepStrictEqual(expected, actual)) errors.push(`${side} ${field}: expected ${show(expected)}, got ${show(actual)}`);
  };
  if (expect.code === undefined) {
    if (!outcome.ok) errors.push(`${side}: expected success, got ${outcome.code}`);
  } else {
    mismatch("code", expect.code, outcome.ok ? "ok" : outcome.code);
  }
  const scalars = [
    "ignored", "status", "assignee", "vehicle", "version", "round", "confirmed", "destinationRevision",
    "navSession", "newNavSession", "pickupCount",
  ] as const;
  for (const field of scalars) {
    if (expect[field] !== undefined) mismatch(field, expect[field], outcome[field]);
  }
  if (expect.set !== undefined) mismatch("set", sorted(expect.set), sorted(outcome.set));
  if (expect.events !== undefined) mismatch("events", expect.events, outcome.events);
  if (expect.offer === null) mismatch("offer", null, outcome.offer);
  else if (expect.offer !== undefined) {
    if (!outcome.offer) errors.push(`${side} offer: expected ${show(expect.offer)}, got null`);
    else {
      for (const [field, value] of Object.entries(expect.offer)) {
        const actual = outcome.offer[field as keyof typeof outcome.offer];
        mismatch(`offer.${field}`, Array.isArray(value) ? sorted(value) : value, actual);
      }
    }
  }
  if (expect.resolved === null) mismatch("resolved", null, outcome.resolved);
  else if (expect.resolved !== undefined) {
    if (!outcome.resolved) errors.push(`${side} resolved: expected ${show(expect.resolved)}, got null`);
    else {
      mismatch("resolved.from", expect.resolved.from, outcome.resolved.from);
      mismatch("resolved.status", expect.resolved.status, outcome.resolved.status);
      const knowsResolver = side === "sql" || expect.resolved.status === "accepted";
      if (expect.resolved.by !== undefined && knowsResolver) mismatch("resolved.by", expect.resolved.by, outcome.resolved.by);
    }
  }
  for (const [vehicle, pickup] of Object.entries(expect.active ?? {})) mismatch(`active.${vehicle}`, pickup, outcome.active[vehicle]);
  if (side === "sql" && expect.sql) {
    if (!outcome.sql) errors.push("sql facts missing");
    else {
      for (const [field, value] of Object.entries(expect.sql)) {
        if (field === "events") {
          mismatch("sql.events", value, outcome.events);
          continue;
        }
        const actual = outcome.sql[field as keyof typeof outcome.sql];
        mismatch(`sql.${field}`, Array.isArray(value) ? sorted(value) : value, Array.isArray(actual) ? sorted(actual) : actual);
      }
    }
  }
  return errors;
}

export function differences(rawTs: Outcome, rawSql: Outcome, skip: NotComparable, shape: Shape): string[] {
  const ts = shaped(rawTs, shape);
  const sql = shaped(rawSql, shape);
  const found: string[] = [];
  for (const field of comparedFields) {
    if (skip[field] !== undefined) continue;
    if (field === "resolved" && ts.resolved && sql.resolved) {
      const accepted = ts.resolved.status === "accepted" || sql.resolved.status === "accepted";
      const left = accepted ? ts.resolved : { ...ts.resolved, by: null };
      const right = accepted ? sql.resolved : { ...sql.resolved, by: null };
      if (!isDeepStrictEqual(left, right)) found.push(`resolved: ts=${show(left)} sql=${show(right)}`);
      continue;
    }
    if (!isDeepStrictEqual(ts[field], sql[field])) found.push(`${field}: ts=${show(ts[field])} sql=${show(sql[field])}`);
  }
  return found;
}

function describe(step: ActStep, index: number): string {
  const target = step.pickup ? ` on ${step.pickup}` : "";
  return `step ${index + 1} (${step.actor} ${step.do.type}${target})`;
}

export type Verdict = { failures: string[]; tolerated: string[] };

export function judge(scenario: Scenario, shape: Shape, ts: Run, sql: Run, known: readonly KnownDivergence[]): Verdict {
  const failures: string[] = [];
  const tolerated: string[] = [];
  for (const { key } of scenario.pickups) {
    const label = `created ${key}`;
    const expect = scenario.created?.[key];
    if (expect) {
      failures.push(...expectationErrors(ts.created[key], expect, "ts", shape).map((error) => `${label}: ${error}`));
      failures.push(...expectationErrors(sql.created[key], expect, "sql", shape).map((error) => `${label}: ${error}`));
    }
    const skip: NotComparable = { ...scenario.notComparable, events: "creation events", resolved: "no prior offer" };
    failures.push(...differences(ts.created[key], sql.created[key], skip, shape).map((diff) => `${label}: ${diff}`));
  }
  scenario.steps.forEach((step, index) => {
    if (!isAct(step)) return;
    const tsOutcome = ts.steps[index];
    const sqlOutcome = sql.steps[index];
    if (!tsOutcome || !sqlOutcome) throw new Error(`step ${index + 1} has no outcome`);
    const label = describe(step, index);
    const skip: NotComparable = { ...scenario.notComparable, ...step.notComparable };
    const tsErrors = expectationErrors(tsOutcome, step.expect, "ts", shape);
    const sqlErrors = expectationErrors(sqlOutcome, step.expect, "sql", shape);
    const diffs = differences(tsOutcome, sqlOutcome, skip, shape);
    const prefixed = (lines: string[]) => lines.map((line) => `${label}: ${line}`);
    const divergence = typeof step.divergence === "string" ? step.divergence : step.divergence?.[shape];
    if (!divergence) {
      failures.push(...prefixed([...tsErrors, ...sqlErrors, ...diffs]));
      return;
    }
    const entry = known.find(({ id }) => id === divergence);
    if (!entry) {
      failures.push(`${label}: divergence "${divergence}" is not listed in knownDivergences`);
      failures.push(...prefixed([...tsErrors, ...sqlErrors, ...diffs]));
      return;
    }
    const wrongErrors = entry.wrong === "sql" ? sqlErrors : tsErrors;
    const rightErrors = entry.wrong === "sql" ? tsErrors : sqlErrors;
    failures.push(...prefixed(rightErrors));
    if (!diffs.length && !wrongErrors.length) {
      failures.push(`${label}: known divergence "${entry.id}" no longer reproduces; remove it from knownDivergences`);
      return;
    }
    tolerated.push(`${entry.id} at ${label} [${shape}]: ${[...wrongErrors, ...diffs].join("; ")}`);
  });
  return { failures, tolerated };
}

