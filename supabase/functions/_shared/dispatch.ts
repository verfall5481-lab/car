import { error, json, method, rpc, validDispatchSecret } from "./http.ts";
import { approximateRegion, sendPush, smsProvider } from "./providers.ts";
import type { PushSubscription } from "./providers.ts";
import { pushPayload, smsText } from "./templates.ts";
import type { TemplateData } from "./templates.ts";

export type Job = { id: number; claim_token: string; channel: "push" | "sms" | "geo"; template: string };
type Context = {
  valid: boolean; demo?: boolean; payload?: TemplateData; pickup_id?: string; phone_e164?: string; subscriptions?: PushSubscription[];
  lat?: number; lng?: number;
};
export type Outcome = { status: "sent" | "skipped" | "failed" | "pending"; error?: string };

export async function geoLabel(job: Pick<Job, "id" | "claim_token">, context: Context): Promise<Outcome> {
  if (context.demo) return { status: "skipped", error: "dry_run" };
  if (typeof context.lat !== "number" || typeof context.lng !== "number") return { status: "skipped", error: "no_geo_coordinates" };
  const region = await approximateRegion(context.lat, context.lng);
  if (!region.label) return region.retryable ? { status: "pending", error: "geo_transport" } : { status: "skipped", error: "no_geo_label" };
  const saved = await rpc<{ updated: boolean }>("svc_apply_geo_label", { p_id: job.id, p_token: job.claim_token, p_label: region.label });
  if (!saved.ok) return { status: "pending", error: "geo_write" };
  return { status: saved.data.updated ? "sent" : "skipped" };
}

export async function deliver(job: Job): Promise<Outcome> {
  const validation = await rpc<Context>("svc_outbox_still_valid", { p_id: job.id, p_token: job.claim_token });
  if (!validation.ok) return { status: "pending", error: "outbox_validation" };
  const context = validation.data;
  if (!context.valid) return { status: "skipped", error: "not_current" };
  if (context.demo) return { status: "skipped", error: "dry_run" };
  if (job.channel === "geo") return geoLabel(job, context);
  if (job.channel === "sms") {
    const provider = smsProvider();
    const text = smsText(job.template, context.payload ?? {}, context.pickup_id);
    if (!provider || !text || !context.phone_e164) return { status: "skipped", error: "sms_disabled" };
    const result = await provider.send({ to: context.phone_e164, text, refKey: String(job.id) });
    if (result.ok) return result.simulated ? { status: "skipped", error: "dry_run" } : { status: "sent" };
    return { status: result.retryable ? "pending" : "failed", error: result.error };
  }
  const payload = pushPayload(job.template, context.payload ?? {}, context.pickup_id);
  if (!payload || !context.subscriptions?.length) return { status: "skipped", error: "no_push_target" };
  const { urgent, ...message } = payload;
  const outcomes = await Promise.all(context.subscriptions.map(async (subscription) => {
    const result = await sendPush(subscription, message, urgent);
    if (!result.ok && result.gone) {
      await rpc("svc_prune_push_subscription", { p_subscription_id: subscription.id, p_endpoint: subscription.endpoint });
    }
    return result;
  }));
  if (outcomes.some((result) => result.ok && !result.simulated)) {
    return outcomes.some((result) => !result.ok && result.retryable)
      ? { status: "pending", error: "partial_push" } : { status: "sent" };
  }
  if (outcomes.some((result) => result.ok && result.simulated)) return { status: "skipped", error: "dry_run" };
  if (outcomes.some((result) => !result.ok && result.retryable)) return { status: "pending", error: "push_retry" };
  return { status: "skipped", error: "push_unavailable" };
}

export async function handleDispatch(request: Request) {
  const methodError = method(request);
  if (methodError) return methodError;
  if (!await validDispatchSecret(request)) return json(request, error("NOT_AUTHENTICATED"), 401);
  const deadline = Date.now() + 25_000;
  const claim = await rpc<{ jobs: Job[] }>("svc_claim_outbox", { p_limit: 25, p_lease_sec: 60 });
  if (!claim.ok) return json(request, claim, 503);
  const counts = { sent: 0, skipped: 0, failed: 0, pending: 0, released: 0 };
  let index = 0;
  while (index < claim.data.jobs.length && Date.now() < deadline - 15_000) {
    const group = claim.data.jobs.slice(index, index + 5);
    await Promise.all(group.map(async (job) => {
      const outcome = await deliver(job).catch(() => ({ status: "pending" as const, error: "worker_failure" }));
      const finished = await rpc<{ updated: boolean }>("svc_finish_outbox", {
        p_id: job.id, p_token: job.claim_token, p_status: outcome.status, p_error: outcome.error ?? null,
      });
      if (finished.ok && finished.data.updated) counts[outcome.status]++;
    }));
    index += group.length;
  }
  const releases = await Promise.all(claim.data.jobs.slice(index).map((job) =>
    rpc<{ updated: boolean }>("svc_release_outbox", { p_id: job.id, p_token: job.claim_token })));
  counts.released = releases.filter((result) => result.ok && result.data.updated).length;
  return json(request, { ok: true, data: counts });
}
