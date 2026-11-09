import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const port = process.env.DERIRO_TEST_PGPORT;
const user = process.env.DERIRO_TEST_PGUSER;
const psql = process.env.DERIRO_TEST_PSQL ?? "psql";
if (!port || !/^\d{4,5}$/.test(port) || !user) {
  throw new Error("Set DERIRO_TEST_PGPORT and DERIRO_TEST_PGUSER for an isolated PostgreSQL server on loopback.");
}
const database = "deriro_contracts_" + randomUUID().replaceAll("-", "");

function execute(sql, db = database) {
  return new Promise((resolve, reject) => {
    const child = spawn(psql, ["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1",
      "-p", port, "-U", user, "-d", db, "-f", "-"], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    child.stdin.on("error", reject);
    child.stdin.end(sql);
  });
}

const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uuid = (n) => `'${id(n)}'::uuid`;
const auth = (n) => `set local role authenticated; set local request.jwt.claim.sub='${id(n)}';`;
const rpc = async (role, query, hold = false) => JSON.parse(await execute(
  `begin; set local lock_timeout='4s'; ${role} select ${query}; ${hold ? "do $$ begin perform pg_sleep(0.8); end $$;" : ""} commit;`,
));
const race = async (left, right) => {
  const first = left();
  await delay(120);
  return Promise.all([first, right()]);
};

await execute(`create database ${database};`, "postgres");
try {
  await execute(await readFile(new URL("auth-shim.sql", import.meta.url), "utf8"));
  const migrations = new URL("../../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    await execute(await readFile(new URL(file, migrations), "utf8"));
  }
  await execute(`
    insert into auth.users(id) values (${uuid(1)}),(${uuid(2)}),(${uuid(3)}),(${uuid(4)}),(${uuid(5)});
    insert into public.families(id,name) values(${uuid(10)},'Synthetic family');
    insert into public.family_members(id,family_id,auth_user_id,display_name) values
      (${uuid(11)},${uuid(10)},${uuid(1)},'Driver 1'),(${uuid(12)},${uuid(10)},${uuid(2)},'Driver 2'),
      (${uuid(13)},${uuid(10)},${uuid(3)},'Driver 3');
    insert into public.riders(id,family_id,display_name,kind,consent_basis) values
      (${uuid(21)},${uuid(10)},'Rider 1','adult','self'),(${uuid(22)},${uuid(10)},'Rider 2','adult','self');
    insert into public.pickups(id,family_id,rider_id,source,location_source,location_confirmed,dest_lat,dest_lng,dest_label,wanted_at) values
      (${uuid(31)},${uuid(10)},${uuid(21)},'request','map_pin',true,37.5,127,'Gate',now()),
      (${uuid(32)},${uuid(10)},${uuid(22)},'request','map_pin',true,37.5,127,'Gate',now());
    insert into public.pickup_offers(id,family_id,pickup_id,origin,expires_at) values
      (${uuid(40)},${uuid(10)},${uuid(32)},'request',now()+interval '10 min');
  `);

  const acceptance = await race(
    () => rpc(auth(1), `public.accept_pickup(${uuid(31)})`, true),
    () => rpc(auth(2), `public.accept_pickup(${uuid(31)})`),
  );
  assert.equal(acceptance.filter((result) => result.ok).length, 1);
  assert.equal(acceptance.find((result) => !result.ok).error.code, "ALREADY_TAKEN");
  assert.equal(await execute(`select count(*) from public.pickup_events where pickup_id=${uuid(31)} and event_type='accepted';`), "1");
  console.log("Concurrent acceptance selects one assignee and writes one event");

  const mixed = await race(
    () => rpc(auth(1), `public.accept_pickup(${uuid(32)})`, true),
    () => rpc(auth(2), `public.respond_offer(${uuid(40)},'accept',1)`),
  );
  assert.equal(mixed.filter((result) => result.ok).length, 1);
  assert.ok(["ALREADY_TAKEN", "STALE_VERSION", "OFFER_NOT_PENDING"].includes(mixed.find((result) => !result.ok).error.code));
  assert.equal(await execute(`select count(*) from public.pickup_events where pickup_id=${uuid(32)}
    and event_type in ('accepted','offer_accepted');`), "1");
  console.log("Direct acceptance and offer response serialize without a deadlock");

  const invitation = await rpc(auth(1), "public.create_family_invite()");
  assert.ok(invitation.ok && /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(invitation.data.code));
  const joining = await race(
    () => rpc(auth(4), `public.join_family('${invitation.data.code}','First','test-v1')`, true),
    () => rpc(auth(5), `public.join_family('${invitation.data.code}','Second','test-v1')`),
  );
  assert.equal(joining.filter((result) => result.ok).length, 1);
  assert.equal(joining.find((result) => !result.ok).error.code, "INVITE_USED");
  console.log("Concurrent claims consume a family invitation exactly once");

  await execute(`delete from public.notifications_outbox;
    insert into public.notifications_outbox(family_id,recipient_member_id,channel,template,dedupe_key)
    select ${uuid(10)},${uuid(11)},'push','test_push','concurrent:'||n from generate_series(1,10) g(n);`);
  const service = "set local role service_role;";
  const claims = await race(() => rpc(service, "public.svc_claim_outbox(5,60)", true),
    () => rpc(service, "public.svc_claim_outbox(5,60)"));
  assert.equal(claims[0].data.jobs.length, 5);
  assert.equal(claims[1].data.jobs.length, 5);
  assert.equal(new Set(claims.flatMap((claim) => claim.data.jobs.map((job) => job.id))).size, 10);
  console.log("Two concurrent outbox workers claim distinct sets of rows");

  const old = claims[0].data.jobs[0];
  await execute(`update public.notifications_outbox set lease_until=now()-interval '1 sec' where id=${old.id};`);
  const reclaimed = (await rpc(service, "public.svc_claim_outbox(5,60)")).data.jobs[0];
  assert.equal(reclaimed.id, old.id);
  assert.equal(reclaimed.attempts, 2);
  assert.notEqual(reclaimed.claim_token, old.claim_token);
  const late = await rpc(service, `public.svc_finish_outbox(${old.id},'${old.claim_token}','sent')`);
  assert.equal(late.data.updated, false);
  const live = await rpc(service, `public.svc_finish_outbox(${old.id},'${reclaimed.claim_token}','sent')`);
  assert.equal(live.data.updated, true);
  console.log("Expired lease is reclaimed and previous worker cannot finish it");
} finally {
  await execute(`drop database ${database};`, "postgres");
}
