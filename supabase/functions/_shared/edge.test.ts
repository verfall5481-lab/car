import assert from "node:assert/strict";
import { body, rpc, verifyUser } from "./http.ts";
import { deliver, handleDispatch } from "./dispatch.ts";
import { DryRunSmsProvider, TwilioSmsProvider, validPushEndpoint } from "./providers.ts";
import type { Delivery, PushSubscription } from "./providers.ts";
import { pushPayload, smsText } from "./templates.ts";

const secret = "fixture-dispatch-secret-32-characters";
const token = "fixture-token";
const id = "10000000-0000-4000-8000-000000000001";

async function withFixtures(
  settings: Record<string, string | undefined>,
  fakeFetch: typeof fetch,
  work: () => Promise<void>,
) {
  const initial = Object.keys(settings).map((key) => [key, Deno.env.get(key)] as const);
  const originalFetch = globalThis.fetch;
  try {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    globalThis.fetch = fakeFetch;
    await work();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of initial) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

const noFetch: typeof fetch = () => Promise.reject(new Error("No external calls expected"));
const ok = (data: unknown) => Response.json({ ok: true, data });

Deno.test("dispatch rejects missing or wrong secret before database access", async () => {
  await withFixtures({ DISPATCH_SECRET: undefined }, noFetch, async () => {
    const result = await handleDispatch(new Request("https://edge.test", { method: "POST" }));
    assert.equal(result.status, 401);
  });
  await withFixtures({ DISPATCH_SECRET: secret }, noFetch, async () => {
    const wrong = await handleDispatch(new Request("https://edge.test", {
      method: "POST", headers: { "x-dispatch-secret": "wrong" },
    }));
    assert.equal(wrong.status, 401);
    const get = await handleDispatch(new Request("https://edge.test"));
    assert.equal(get.status, 405);
  });
});

Deno.test("invalid JSON and anonymous identities are refused", async () => {
  assert.equal(await body(new Request("https://edge.test", { method: "POST", body: "{" })), undefined);
  assert.equal(await body(new Request("https://edge.test", { method: "POST", body: "[]" })), undefined);
  let calls = 0;
  await withFixtures({ SUPABASE_URL: "https://supabase.test", SUPABASE_PUBLISHABLE_KEY: "publishable-fixture" },
    (_url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      return Promise.resolve(Response.json({ id, is_anonymous: true }));
    }, async () => {
      assert.equal(await verifyUser(new Request("https://edge.test")), undefined);
      const request = new Request("https://edge.test", { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(await verifyUser(request), undefined);
      assert.equal(calls, 1);
    });
});

Deno.test("service operations fail closed without service credentials", async () => {
  await withFixtures({ SUPABASE_URL: "https://supabase.test", SUPABASE_SECRET_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined },
    noFetch, async () => {
      const response = await rpc("svc_claim_outbox", {});
      assert.equal(response.ok, false);
      if (!response.ok) assert.equal(response.error.code, "BACKEND_CONFIG");
    });
});

Deno.test("worker revalidates claim before any provider call and skips a stale claim", async () => {
  const calls: string[] = [];
  await withFixtures({ DISPATCH_SECRET: secret, SUPABASE_URL: "https://supabase.test", SUPABASE_SECRET_KEY: "service-fixture" },
    (url, init) => {
      const route = String(url).split("/").pop()!;
      calls.push(route);
      assert.equal(new Headers(init?.headers).get("apikey"), "service-fixture");
      if (route === "svc_claim_outbox") return Promise.resolve(ok({ jobs: [{ id: 1, claim_token: id, channel: "sms", template: "esc_sms_open" }] }));
      if (route === "svc_outbox_still_valid") return Promise.resolve(ok({ valid: false }));
      assert.equal(route, "svc_finish_outbox");
      assert.equal(JSON.parse(String(init?.body)).p_status, "skipped");
      return Promise.resolve(ok({ updated: true }));
    }, async () => {
      const response = await handleDispatch(new Request("https://edge.test", {
        method: "POST", headers: { "x-dispatch-secret": secret },
      }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.skipped, 1);
      assert.deepEqual(calls, ["svc_claim_outbox", "svc_outbox_still_valid", "svc_finish_outbox"]);
    });
});

Deno.test("DryRun SMS returns simulation and worker never counts it as sent", async () => {
  const simulated = await new DryRunSmsProvider().send({ to: "+821000000001", text: "Synthetic", refKey: "test" });
  assert.ok(simulated.ok && simulated.simulated);
  await withFixtures({
    APP_BASE_URL: "https://app.test", SMS_PROVIDER: "dry_run",
    SUPABASE_URL: "https://supabase.test", SUPABASE_SECRET_KEY: "service-fixture",
  }, (url) => {
    assert.ok(String(url).endsWith("svc_outbox_still_valid"));
    return Promise.resolve(ok({ valid: true, payload: {}, pickup_id: id, phone_e164: "+821000000001" }));
  }, async () => {
    const outcome = await deliver({ id: 1, claim_token: id, channel: "sms", template: "esc_sms_open" });
    assert.deepEqual(outcome, { status: "skipped", error: "dry_run" });
  });
});

Deno.test("push retry targets only subscriptions that have not accepted the job", async () => {
  const first = { id: "sub-accepted", endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: { p256dh: "k", auth: "a" } };
  const second = { id: "sub-retry", endpoint: "https://fcm.googleapis.com/fcm/send/b", keys: { p256dh: "k", auth: "a" } };
  const job = { id: 7, claim_token: id, channel: "push" as const, template: "child_request_new" };
  const service = { SUPABASE_URL: "https://supabase.test", SUPABASE_SECRET_KEY: "service-fixture" };
  let context: unknown;
  const fakeRpc: typeof fetch = (url) => {
    assert.ok(String(url).endsWith("svc_outbox_still_valid"));
    return Promise.resolve(ok(context));
  };
  const sent: string[] = [];
  await withFixtures(service, fakeRpc, async () => {
    context = { valid: true, pickup_id: id, payload: { rider_name: "민준" }, subscriptions: [first, second], delivered_count: 0 };
    const partial = await deliver(job, (subscription: PushSubscription): Promise<Delivery> => {
      sent.push(subscription.id);
      return Promise.resolve(subscription.id === first.id
        ? { ok: true, providerId: "web_push" }
        : { ok: false, error: "push_http_503", retryable: true });
    });
    assert.deepEqual(partial, { status: "pending", error: "partial_push", delivered: [first.id] });

    context = { valid: true, pickup_id: id, payload: { rider_name: "민준" }, subscriptions: [second], delivered_count: 1 };
    const retried = await deliver(job, (subscription: PushSubscription): Promise<Delivery> => {
      sent.push(subscription.id);
      return Promise.resolve({ ok: true, providerId: "web_push" });
    });
    assert.deepEqual(retried, { status: "sent", delivered: [second.id] });

    context = { valid: true, pickup_id: id, payload: {}, subscriptions: [], delivered_count: 2 };
    assert.deepEqual(await deliver(job, (): Promise<Delivery> => Promise.reject(new Error("no send expected"))), { status: "sent", delivered: [] });
  });
  assert.deepEqual(sent, [first.id, second.id, second.id]);
});

Deno.test("dispatch reports accepted subscriptions when it finishes a job", async () => {
  const subscription = { id: "sub-1", endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: { p256dh: "k", auth: "a" } };
  let finish: Record<string, unknown> | undefined;
  await withFixtures({ DISPATCH_SECRET: secret, SUPABASE_URL: "https://supabase.test", SUPABASE_SECRET_KEY: "service-fixture" },
    (url, init) => {
      const route = String(url).split("/").pop()!;
      if (route === "svc_claim_outbox") return Promise.resolve(ok({ jobs: [{ id: 3, claim_token: id, channel: "push", template: "test_push" }] }));
      if (route === "svc_outbox_still_valid") return Promise.resolve(ok({ valid: true, payload: {}, subscriptions: [subscription], delivered_count: 0 }));
      assert.equal(route, "svc_finish_outbox");
      finish = JSON.parse(String(init?.body));
      return Promise.resolve(ok({ updated: true }));
    }, async () => {
      const response = await handleDispatch(new Request("https://edge.test", {
        method: "POST", headers: { "x-dispatch-secret": secret },
      }), (): Promise<Delivery> => Promise.resolve({ ok: true, providerId: "web_push" }));
      assert.equal((await response.json()).data.sent, 1);
    });
  assert.equal(finish?.p_status, "sent");
  assert.deepEqual(finish?.p_delivered_subscription_ids, [subscription.id]);
});

Deno.test("Twilio adapter maps transient errors and sends to fixed provider origin", async () => {
  const account = "AC" + "a".repeat(32);
  const service = "MG" + "b".repeat(32);
  await withFixtures({}, (url, init) => {
    assert.equal(String(url), `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`);
    assert.equal(init?.redirect, "error");
    assert.equal((init?.body as URLSearchParams).get("MessagingServiceSid"), service);
    return Promise.resolve(Response.json({}, { status: 429 }));
  }, async () => {
    const result = await new TwilioSmsProvider(account, "fixture-auth", service).send({
      to: "+821000000001", text: "Synthetic", refKey: "test",
    });
    assert.deepEqual(result, { ok: false, error: "sms_http_429", retryable: true });
  });
});

Deno.test("push addresses are allowlisted and notification links remain in the app", async () => {
  assert.equal(validPushEndpoint("https://fcm.googleapis.com/fcm/send/test"), true);
  assert.equal(validPushEndpoint("https://fcm.googleapis.com.attacker.invalid/push"), false);
  assert.equal(validPushEndpoint("https://fcm.googleapis.com@127.0.0.1/push"), false);
  assert.equal(validPushEndpoint("http://web.push.apple.com/push"), false);
  assert.equal(pushPayload("child_arrived", { who: "아빠" }, id)?.url, "/c/");
  assert.equal(pushPayload("child_request_new", { rider_name: "민준" }, id)?.requireInteraction, true);
  await withFixtures({ APP_BASE_URL: "https://app.test" }, noFetch, async () => {
    const text = smsText("esc_sms_open", { rider_name: "민준", place: "private exact location" }, id);
    assert.match(text ?? "", /^\[데리러\]/);
    assert.ok(!text?.includes("private exact location"));
  });
});
