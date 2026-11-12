// Runs a scenario against the real migrations on PGlite. Rows are seeded as the superuser, the way
// supabase/tests/pickup_lifecycle.test.sql seeds them; every action calls a PUBLIC RPC inside its own
// transaction as the acting principal (`set local role authenticated` + `request.jwt.claim.sub`).
// Members are non-anonymous auth users; rider devices and vehicles are anonymous ones.
// Time: the database clock cannot be moved, so a clock step shifts every stored timestamp of the family back
// by the same amount (triggers off), which is the same as moving `now()` forward. Routine times shift with them.
// Each family lives in a fixed-offset zone where it is about midday, so a routine time never wraps past midnight.
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import { familyOf, isAct, versionOf } from "./model.ts";
import type {
  ActStep,
  FamilySpec,
  Outcome,
  PickupSpec,
  RequestSpec,
  RoutineSpec,
  Run,
  Scenario,
  SqlStamp,
  Stamp,
} from "./model.ts";

const supabase = new URL("../../../supabase/", import.meta.url);

/** A fixed-offset time zone where it is now between 12:00 and 13:00. */
function middayZone(): string {
  const offset = ((12 - new Date().getUTCHours() + 36) % 24) - 12;
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

/** auth-shim.sql, then every migration in order, as packages/contracts/test-db/embedded.mjs applies them. */
export async function bootDatabase(): Promise<PGlite> {
  try {
    return await loadMigrations();
  } catch (error) {
    // Another agent may be saving a migration at this moment; one retry tells a partial write from a real failure.
    console.error(`migrations failed once, retrying: ${(error as Error).message}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return loadMigrations();
  }
}

async function loadMigrations(): Promise<PGlite> {
  const db = await PGlite.create();
  try {
    await db.exec(await readFile(new URL("../test-db/auth-shim.sql", import.meta.url), "utf8"));
    const files = (await readdir(new URL("migrations/", supabase))).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      await db.exec(await readFile(new URL(`migrations/${file}`, supabase), "utf8"));
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export async function runSql(db: PGlite, scenario: Scenario): Promise<Run> {
  const world = new SqlWorld(db, familyOf(scenario));
  await world.seed(scenario.pickups);
  for (const mark of scenario.unavailable ?? []) await world.markBefore(scenario, mark.member, mark.dayOf);
  const created: Run["created"] = {};
  for (const spec of scenario.pickups) created[spec.key] = await world.create(spec);
  const steps: Run["steps"] = [];
  for (const step of scenario.steps) {
    if (isAct(step)) {
      steps.push(await world.act(step, scenario.pickups[0].key));
      continue;
    }
    if ("clock" in step) await world.shift(step.clock);
    else if ("park" in step) await world.park(step.park, step.parked);
    else if ("driver" in step) await world.driver(step.driver, step.member);
    else await world.role(step.member, step.canDrive);
    steps.push(null);
  }
  return { created, steps };
}

type Rpc = {
  ok?: boolean;
  error?: { code?: string; detail?: { by?: string } };
  data?: { ignored?: boolean; pickup?: { id?: string } };
};

type PickupRow = {
  status: Outcome["status"];
  assignee_member_id: string | null;
  vehicle_id: string | null;
  version: number;
  assignment_round: number;
  location_confirmed: boolean;
  destination_revision: number;
  nav_session_id: string | null;
  nav_destination_revision: number | null;
  nav_status: NonNullable<Outcome["sql"]>["navStatus"];
  is_customized: boolean;
  announced: boolean;
  wanted_in: number;
  cancel_reason: string | null;
  fallback_note: string | null;
  fallback_by_member_id: string | null;
  fallback_acked: boolean;
  available: string[];
  dest_lat: number;
  dest_lng: number;
  dest_label: string;
  stamps: Record<Stamp | SqlStamp, boolean>;
};

type OfferRow = {
  id: string;
  from_member_id: string | null;
  to_member_id: string | null;
  status: NonNullable<Outcome["resolved"]>["status"];
  resolved_by_member_id: string | null;
  expires_in: number;
  declined: string[];
};

type Snapshot = {
  pickup: PickupRow;
  offers: OfferRow[];
  events: string[];
  lastEvent: number;
  vehicles: { id: string; active_pickup_id: string | null }[];
  count: number;
};

class SqlWorld {
  private readonly db: PGlite;
  private readonly family: FamilySpec;
  private readonly familyId = randomUUID();
  private readonly zone = middayZone();
  private readonly ids = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  private readonly auth = new Map<string, string>();
  private readonly riders = new Set<string>();
  private readonly pickupIds = new Map<string, string>();
  private readonly watermark = new Map<string, number>();
  private readonly actionIds = new Map<string, string>();
  private readonly sessions = new Map<string, { id: string; revision: number }[]>();

  constructor(db: PGlite, family: FamilySpec) {
    this.db = db;
    this.family = family;
  }

  private id(key: string): string {
    let id = this.ids.get(key);
    if (!id) {
      id = randomUUID();
      this.ids.set(key, id);
      this.keys.set(id, key);
    }
    return id;
  }

  private key(id: string | null): string | null {
    if (id === null) return null;
    return this.keys.get(id) ?? `unknown:${id}`;
  }

  async seed(pickups: readonly PickupSpec[]): Promise<void> {
    const family = this.family;
    const familyId = this.familyId;
    await this.db.transaction(async (tx) => {
      await tx.query("insert into public.families(id, name, timezone) values ($1, '시험 가족', $2)", [familyId, this.zone]);
      for (const member of family.members) {
        const user = this.user(member.key);
        await tx.query("insert into auth.users(id, is_anonymous) values ($1, false)", [user]);
        await tx.query(
          `insert into public.family_members(id, family_id, auth_user_id, display_name, can_drive, can_request,
             location_consented_at) values ($1, $2, $3, $4, $5, $6, now())`,
          [this.id(member.key), familyId, user, member.name, member.canDrive ?? true, member.canRequest ?? true],
        );
      }
      for (const rider of family.riders) {
        const user = this.user(rider.key);
        this.riders.add(rider.key);
        await tx.query("insert into auth.users(id, is_anonymous) values ($1, true)", [user]);
        await tx.query(
          `insert into public.riders(id, family_id, display_name, kind, consent_basis, location_consented_at)
             values ($1, $2, $3, 'child', 'guardian', now())`,
          [this.id(rider.key), familyId, rider.name],
        );
        await tx.query("insert into public.rider_devices(id, family_id, rider_id, auth_user_id) values ($1, $2, $3, $4)",
          [randomUUID(), familyId, this.id(rider.key), user]);
      }
      for (const place of family.places) {
        await tx.query("insert into public.places(id, family_id, label, lat, lng, radius_m) values ($1, $2, $3, $4, $5, $6)",
          [this.id(place.key), familyId, place.label, place.lat, place.lng, place.radiusM ?? 150]);
      }
      for (const point of family.points) {
        await tx.query(
          "insert into public.pickup_points(id, family_id, place_id, label, lat, lng, note) values ($1, $2, $3, $4, $5, $6, $7)",
          [this.id(point.key), familyId, this.id(point.place), point.label, point.lat, point.lng, point.note ?? null],
        );
      }
      for (const vehicle of family.vehicles) {
        const user = this.user(vehicle.key);
        await tx.query("insert into auth.users(id, is_anonymous) values ($1, true)", [user]);
        await tx.query(
          "insert into public.vehicles(id, family_id, auth_user_id, nickname, current_driver_member_id) values ($1, $2, $3, $4, $5)",
          [this.id(vehicle.key), familyId, user, vehicle.name, this.id(vehicle.driver)],
        );
        // A fresh parked reading authorizes parked-only operations (30 seconds, refreshed before every step).
        await tx.query("insert into public.vehicle_states(vehicle_id, gear, collected_at) values ($1, $2, now())",
          [this.id(vehicle.key), (vehicle.parked ?? true) ? "P" : "D"]);
      }
      for (const spec of pickups) {
        if (spec.kind !== "routine") continue;
        // The routine runs at the occurrence's local time on its day only, so revise_routine reproduces wanted_at
        // and ensure_occurrences finds nothing to add.
        await tx.query(
          `insert into public.routines(id, family_id, rider_id, place_id, weekdays, time_local, notify_before_min,
             default_assignee_member_id, default_vehicle_id, start_date, end_date)
           select $1, $2, $3, $4, 127, moment.local::time, $5, $6, $7, moment.local::date, moment.local::date
           from (select (now() + make_interval(mins => $8)) at time zone $9 as local) moment`,
          [this.id(`routine:${spec.key}`), familyId, this.id(spec.rider), this.id(spec.place), spec.notifyBeforeMin ?? 20,
            spec.assignee ? this.id(spec.assignee) : null, spec.vehicle ? this.id(spec.vehicle) : null, spec.wantedInMin, this.zone],
        );
      }
    });
  }

  private user(key: string): string {
    const user = randomUUID();
    this.auth.set(key, user);
    return user;
  }

  /** `set_unavailable_day` before any pickup exists, for the date the spec's pickup will have. */
  async markBefore(scenario: Scenario, member: string, pickupKey: string): Promise<void> {
    const spec = scenario.pickups.find(({ key }) => key === pickupKey);
    if (!spec) throw new Error(`unknown pickup ${pickupKey}`);
    const response = await this.call(member,
      "select public.set_unavailable_day(((now() + make_interval(mins => $1::int)) at time zone $2)::date, true) as r",
      [spec.wantedInMin ?? 0, this.zone]);
    if (!response.ok) throw new Error(`marking ${member} failed: ${JSON.stringify(response)}`);
  }

  async create(spec: PickupSpec): Promise<Outcome> {
    const id = spec.kind === "request" ? await this.request(spec) : await this.routine(spec);
    this.pickupIds.set(spec.key, id);
    this.keys.set(id, spec.key);
    const snapshot = await this.snapshot(spec.key);
    this.watermark.set(spec.key, snapshot.lastEvent);
    // Creation events are not compared: SQL writes `created`, the demo writes a `requested` history row.
    return this.outcome({ ...snapshot, offers: [] }, { ...snapshot, events: [] }, { ok: true });
  }

  private async request(spec: RequestSpec): Promise<string> {
    const at = spec.at;
    const fn = this.riders.has(spec.by) ? "rider_create_request" : "member_create_request";
    const pin = "pin" in at ? JSON.stringify(at.pin) : null;
    const gps = "gps" in at ? JSON.stringify({ lat: at.gps.lat, lng: at.gps.lng, accuracy_m: at.gps.accuracyM ?? null }) : null;
    const response = await this.call(spec.by,
      `select public.${fn}(p_wanted_in_min => $1, p_place_id => $2::uuid, p_pickup_point_id => $3::uuid,
         p_pin => $4::jsonb, p_gps => $5::jsonb) as r`,
      [spec.wantedInMin ?? 0, "place" in at ? this.id(at.place) : null, "point" in at ? this.id(at.point) : null, pin, gps]);
    const id = response.data?.pickup?.id;
    if (!response.ok || !id) throw new Error(`request ${spec.key} failed: ${JSON.stringify(response)}`);
    return id;
  }

  /** The row `ensure_occurrences` inserts for a routine occurrence; with `generate`, the row it does insert. */
  private async routine(spec: RoutineSpec): Promise<string> {
    const place = this.family.places.find(({ key }) => key === spec.place);
    if (!place) throw new Error(`unknown place ${spec.place}`);
    if (spec.generate) {
      await this.db.query("select deriro_private.ensure_occurrences($1::uuid, 1)", [this.familyId]);
      const generated = await this.db.query<{ id: string }>("select id from public.pickups where routine_id = $1",
        [this.id(`routine:${spec.key}`)]);
      if (!generated.rows[0]) throw new Error(`ensure_occurrences made no occurrence for ${spec.key}`);
      return generated.rows[0].id;
    }
    const result = await this.db.query<{ id: string }>(
      `insert into public.pickups(family_id, rider_id, source, routine_id, occurrence_date, status, assignment_round,
         assignee_member_id, vehicle_id, place_id, location_source, location_confirmed, dest_lat, dest_lng, dest_label, wanted_at)
       select $1, $2, 'routine', routine.id, routine.start_date, $4::public.pickup_status, $5, $6, $7, $8, 'saved_place', true,
         $9, $10, $11, (routine.start_date + routine.time_local) at time zone $12
       from public.routines routine where routine.id = $3 returning id`,
      [this.familyId, this.id(spec.rider), this.id(`routine:${spec.key}`), spec.assignee ? "assigned" : "open",
        spec.assignee ? 1 : 0, spec.assignee ? this.id(spec.assignee) : null, spec.vehicle ? this.id(spec.vehicle) : null,
        this.id(spec.place), place.lat, place.lng, place.label, this.zone],
    );
    return result.rows[0].id;
  }

  private async call(actor: string, sql: string, params: unknown[]): Promise<Rpc> {
    const uid = this.auth.get(actor);
    if (!uid) throw new Error(`unknown principal ${actor}`);
    try {
      return await this.db.transaction(async (tx: Transaction) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
        const result = await tx.query<{ r: Rpc }>(sql, params);
        return result.rows[0].r;
      });
    } catch (error) {
      // An exception is a defect (8.1): business rejections are returned, never raised.
      const failure = error as { code?: string; message?: string };
      return { ok: false, error: { code: `EXCEPTION ${failure.code ?? ""} ${failure.message ?? ""}` } };
    }
  }

  async act(step: ActStep, firstPickup: string): Promise<Outcome> {
    const key = step.pickup ?? firstPickup;
    await this.db.query(
      "update public.vehicle_states set collected_at = now() where vehicle_id in (select id from public.vehicles where family_id = $1)",
      [this.familyId],
    );
    const before = await this.snapshot(key);
    const response = await this.dispatch(step, key, before);
    const after = await this.snapshot(key);
    this.watermark.set(key, after.lastEvent);
    const session = after.pickup.nav_session_id;
    if (session && this.sessions.get(key)?.at(-1)?.id !== session) {
      this.sessions.set(key, [...this.sessions.get(key) ?? [], {
        id: session, revision: after.pickup.nav_destination_revision ?? 0,
      }]);
    }
    return this.outcome(before, after, response);
  }

  private async dispatch(step: ActStep, key: string, before: Snapshot): Promise<Rpc> {
    const spec = step.do;
    const pickup = this.pickupIds.get(key)!;
    const version = versionOf(before.pickup.version, "version" in spec ? spec.version : undefined);
    const latestOffer = before.offers.at(-1)?.id ?? null;
    const optional = (memberOrVehicle?: string) => memberOrVehicle ? this.id(memberOrVehicle) : null;
    const rider = this.riders.has(step.actor);
    const call = (sql: string, params: unknown[]) => this.call(step.actor, `select public.${sql} as r`, params);
    switch (spec.type) {
      case "accept":
        return call("accept_pickup($1::uuid, $2::uuid)", [pickup, optional(spec.vehicle)]);
      case "offer":
        return call("offer_pickup($1::uuid, $2::int, $3::uuid, $4::text)", [pickup, version, optional(spec.to), spec.note ?? null]);
      case "respond":
        return call("respond_offer($1::uuid, $2::text, $3::int, $4::uuid)", [latestOffer, spec.response, version, optional(spec.vehicle)]);
      case "cancel_offer":
        return call("cancel_offer($1::uuid, $2::int)", [latestOffer, version]);
      case "take_over":
        return call("take_over($1::uuid, $2::int, $3::uuid)", [pickup, version, optional(spec.vehicle)]);
      case "depart":
        return call("mark_en_route($1::uuid, $2::int)", [pickup, version]);
      case "undo":
        return call("undo_en_route($1::uuid, $2::int)", [pickup, version]);
      case "vehicle_start": {
        const slot = `${step.actor}|${key}`;
        const actionId = spec.retry ? this.actionIds.get(slot) ?? randomUUID() : randomUUID();
        this.actionIds.set(slot, actionId);
        const family = before.offers.filter((offer) => offer.from_member_id === null).at(-1)?.id ?? null;
        const offerId = spec.withOffer === "family" ? family : spec.withOffer ? latestOffer : null;
        return call("vehicle_start_now($1::uuid, $2::int, $3::uuid, $4::uuid)", [pickup, version, actionId, offerId]);
      }
      case "nav_result":
        return call("report_nav_result($1::uuid, $2::uuid, $3::text)", [pickup, before.pickup.nav_session_id, spec.result]);
      case "arrive":
        return call("mark_arrived($1::uuid, 'manual', p_expected_version => $2::int)", [pickup, version]);
      case "nav_arrival": {
        const sessions = this.sessions.get(key) ?? [];
        const session = spec.session === "previous" ? sessions.at(-2) : sessions.at(-1);
        const revision = spec.revision === "current" ? before.pickup.destination_revision : session?.revision ?? 0;
        return call("mark_arrived($1::uuid, 'nav_callback', $2::uuid, $3::int)", [pickup, session?.id ?? randomUUID(), revision]);
      }
      case "board":
        return call(rider ? "rider_mark_boarded($1::uuid, $2::int)" : "mark_completed($1::uuid, $2::int)", [pickup, version]);
      case "cancel":
        if (rider) return call("rider_cancel_request($1::uuid, $2::int)", [pickup, version]);
        return call("cancel_pickup($1::uuid, $2::int, $3::text)", [pickup, version, spec.reason ?? "cancelled"]);
      case "skip":
        return call("skip_occurrence($1::uuid, $2::int)", [pickup, version]);
      case "confirm_location": {
        const place = spec.place ? this.family.places.find(({ key: placeKey }) => placeKey === spec.place) : undefined;
        const point = place ?? { lat: before.pickup.dest_lat, lng: before.pickup.dest_lng, label: before.pickup.dest_label };
        return call("confirm_location($1::uuid, $2::int, $3::float8, $4::float8, $5::text, $6::uuid)",
          [pickup, version, point.lat, point.lng, point.label, place ? this.id(place.key) : null]);
      }
      case "ready":
        return call("rider_ready_early($1::uuid, $2::int)", [pickup, version]);
      case "not_met":
        return call("rider_report_not_met($1::uuid, $2::int)", [pickup, version]);
      case "vehicle_decline":
        return call("vehicle_decline($1::uuid, $2::int)", [pickup, version]);
      case "sweep":
        // The hourly scheduler (9장), run as the superuser for this family only.
        await this.db.query("select deriro_private.run_escalations($1::uuid)", [this.familyId]);
        return { ok: true };
      case "edit_routine": {
        // The guardian saves the routine as it is, with the step's changes (P-09); revise_routine follows.
        const keep = (value: string | null | undefined) => value === undefined;
        return this.call(step.actor,
          `select public.upsert_routine(
             p_rider_id => routine.rider_id, p_rider_member_id => routine.rider_member_id,
             p_place_id => coalesce($2::uuid, routine.place_id),
             p_weekdays => case when $3::boolean
               then routine.weekdays & ~(1 << (extract(isodow from routine.start_date)::int - 1)) else routine.weekdays end,
             p_time_local => routine.time_local + make_interval(mins => $4::int),
             p_notify_before_min => coalesce($5::int, routine.notify_before_min),
             p_default_assignee_member_id => case when $6::boolean then routine.default_assignee_member_id else $7::uuid end,
             p_default_vehicle_id => case when $8::boolean then routine.default_vehicle_id else $9::uuid end,
             p_start_date => routine.start_date, p_end_date => routine.end_date, p_pickup_point_id => routine.pickup_point_id,
             p_routine_id => routine.id, p_active => routine.active) as r
           from public.routines routine where routine.id = $1`,
          [this.id(`routine:${key}`), spec.place ? this.id(spec.place) : null, spec.dropDay === true, spec.shiftMinutes ?? 0,
            spec.notifyBeforeMin ?? null, keep(spec.assignee), optional(spec.assignee ?? undefined),
            keep(spec.vehicle), optional(spec.vehicle ?? undefined)]);
      }
      case "archive_routine":
        return call("archive_routine($1::uuid)", [this.id(`routine:${key}`)]);
      case "no_driver":
        return call("declare_no_driver($1::uuid, $2::int, $3::text)", [pickup, version, spec.note ?? "학원 안에서 기다리기"]);
      case "ack_fallback":
        return call("ack_fallback($1::uuid)", [pickup]);
      case "unavailable_day":
        // The step pickup's date in the family's zone, or today there plus fromToday.
        return this.call(step.actor,
          `select public.set_unavailable_day(case when $2::int is null
             then (select (p.wanted_at at time zone $3)::date from public.pickups p where p.id = $1::uuid)
             else (now() at time zone $3)::date + $2::int end, $4::boolean) as r`,
          [pickup, spec.fromToday ?? null, this.zone, spec.unavailable ?? true]);
    }
  }

  private async snapshot(key: string): Promise<Snapshot> {
    const pickupId = this.pickupIds.get(key)!;
    const pickup = await this.db.query<PickupRow>(
      `select status, assignee_member_id, vehicle_id, version, assignment_round, location_confirmed, destination_revision,
         nav_session_id, nav_destination_revision, nav_status, is_customized, cancel_reason, dest_lat, dest_lng, dest_label,
         fallback_note, fallback_by_member_id, fallback_ack_at is not null as fallback_acked,
         deriro_private.available_drivers(p) as available,
         routine_offer_created_at is not null as announced, round(extract(epoch from wanted_at - now()) / 60)::int as wanted_in,
         jsonb_build_object('acceptedAt', accepted_at is not null, 'enRouteAt', en_route_at is not null,
           'arrivedAt', arrived_at is not null, 'readyAt', rider_ready_at is not null,
           'notMetAt', not_met_reported_at is not null, 'completedAt', completed_at is not null,
           'cancelledAt', cancelled_at is not null, 'expiredAt', expired_at is not null,
           'closedUnconfirmedAt', closed_unconfirmed_at is not null) as stamps
       from public.pickups p where id = $1`,
      [pickupId],
    );
    const offers = await this.db.query<OfferRow>(
      `select o.id, o.from_member_id, o.to_member_id, o.status, o.resolved_by_member_id,
         round(extract(epoch from o.expires_at - now()) / 60)::int as expires_in,
         coalesce((select jsonb_agg(r.member_id) from public.offer_responses r where r.offer_id = o.id), '[]') as declined
       from public.pickup_offers o where o.pickup_id = $1 order by o.created_at, o.id`,
      [pickupId],
    );
    const events = await this.db.query<{ id: number; event_type: string }>(
      "select id::int as id, event_type from public.pickup_events where pickup_id = $1 and id > $2 order by id",
      [pickupId, this.watermark.get(key) ?? 0],
    );
    const vehicles = await this.db.query<{ id: string; active_pickup_id: string | null }>(
      "select id, active_pickup_id from public.vehicles where family_id = $1 order by id", [this.familyId]);
    const count = await this.db.query<{ n: number }>(
      "select count(*)::int as n from public.pickups where family_id = $1", [this.familyId]);
    return {
      pickup: pickup.rows[0],
      offers: offers.rows,
      events: events.rows.map((row) => row.event_type),
      lastEvent: events.rows.at(-1)?.id ?? this.watermark.get(key) ?? 0,
      vehicles: vehicles.rows,
      count: count.rows[0].n,
    };
  }

  private outcome(before: Snapshot, after: Snapshot, response: Rpc): Outcome {
    const row = after.pickup;
    const stampNames: Stamp[] = ["acceptedAt", "enRouteAt", "arrivedAt", "readyAt", "notMetAt"];
    const sqlStampNames: SqlStamp[] = ["completedAt", "cancelledAt", "expiredAt", "closedUnconfirmedAt"];
    const pending = after.offers.find((offer) => offer.status === "pending");
    const resolved = before.offers
      .filter((offer) => offer.status === "pending")
      .map((offer) => after.offers.find(({ id }) => id === offer.id))
      .find((offer) => offer !== undefined && offer.status !== "pending");
    const memberKeys = (ids: string[]) => ids.map((id) => this.key(id)!).sort();
    return {
      ok: response.ok === true,
      code: response.ok === true ? null : response.error?.code ?? "NO_RESPONSE",
      // The server names the holder by display name; names are unique in a family.
      by: this.family.members.find(({ name }) => name === response.error?.detail?.by)?.key ?? null,
      ignored: response.data?.ignored === true,
      status: row.status,
      assignee: this.key(row.assignee_member_id),
      vehicle: this.key(row.vehicle_id),
      version: row.version,
      round: row.assignment_round,
      wantedInMin: row.wanted_in,
      confirmed: row.location_confirmed,
      destinationRevision: row.destination_revision,
      customized: row.is_customized,
      announced: row.announced,
      navSession: row.nav_session_id !== null,
      newNavSession: row.nav_session_id !== null && row.nav_session_id !== before.pickup.nav_session_id,
      set: stampNames.filter((name) => row.stamps[name]),
      offer: pending
        ? {
          from: this.key(pending.from_member_id), to: this.key(pending.to_member_id),
          declinedBy: memberKeys(pending.declined), expiresInMin: pending.expires_in,
        }
        : null,
      resolved: resolved
        ? { from: this.key(resolved.from_member_id), status: resolved.status, by: this.key(resolved.resolved_by_member_id) }
        : null,
      events: after.events,
      active: Object.fromEntries(after.vehicles.map((vehicle) => [this.key(vehicle.id)!, this.key(vehicle.active_pickup_id)])),
      pickupCount: after.count,
      cancelReason: row.cancel_reason,
      fallbackNote: row.fallback_note,
      fallbackBy: this.key(row.fallback_by_member_id),
      fallbackAcked: row.fallback_acked,
      available: row.status === "open" ? memberKeys(row.available) : null,
      sql: {
        navStatus: row.nav_status,
        cancelReason: row.cancel_reason,
        stamps: sqlStampNames.filter((name) => row.stamps[name]),
      },
    };
  }

  async shift(minutes: number): Promise<void> {
    const by = `${minutes} minutes`;
    await this.db.transaction(async (tx) => {
      // Moving timestamps is bookkeeping, not a transition: no version bump, no outbox rows.
      await tx.exec("set local session_replication_role = replica");
      await tx.query(
        `update public.pickups set wanted_at = wanted_at - $2::interval, created_at = created_at - $2::interval,
           accepted_at = accepted_at - $2::interval, en_route_at = en_route_at - $2::interval,
           arrived_at = arrived_at - $2::interval, completed_at = completed_at - $2::interval,
           cancelled_at = cancelled_at - $2::interval, expired_at = expired_at - $2::interval,
           rider_ready_at = rider_ready_at - $2::interval, not_met_reported_at = not_met_reported_at - $2::interval,
           routine_offer_created_at = routine_offer_created_at - $2::interval,
           closed_unconfirmed_at = closed_unconfirmed_at - $2::interval, fallback_ack_at = fallback_ack_at - $2::interval
         where family_id = $1`,
        [this.familyId, by],
      );
      await tx.query(
        `update public.pickup_offers set expires_at = expires_at - $2::interval, created_at = created_at - $2::interval,
           resolved_at = resolved_at - $2::interval where family_id = $1`,
        [this.familyId, by],
      );
      await tx.query("update public.routines set time_local = time_local - $2::interval where family_id = $1", [this.familyId, by]);
      await tx.query(
        `update deriro_private.rate_limits set resets_at = resets_at - $2::interval where principal in (
           select id from public.riders where family_id = $1 union select id from public.family_members where family_id = $1)`,
        [this.familyId, by],
      );
    });
  }

  async park(vehicle: string, parked: boolean): Promise<void> {
    await this.db.query("update public.vehicle_states set gear = $2, collected_at = now() where vehicle_id = $1",
      [this.id(vehicle), parked ? "P" : "D"]);
  }

  async driver(vehicle: string, member: string): Promise<void> {
    await this.db.query("update public.vehicle_states set gear = 'P', collected_at = now() where vehicle_id = $1", [this.id(vehicle)]);
    const response = await this.call(vehicle, "select public.vehicle_set_driver($1::uuid) as r", [this.id(member)]);
    if (!response.ok) throw new Error(`vehicle_set_driver failed: ${JSON.stringify(response)}`);
  }

  async role(member: string, canDrive: boolean): Promise<void> {
    await this.db.query("update public.family_members set can_drive = $2 where id = $1", [this.id(member), canDrive]);
  }
}
