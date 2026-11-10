import assert from "node:assert/strict";
import test from "node:test";
import { summarizePush } from "../../../supabase/functions/_shared/push_outcome.ts";

const accepted = { ok: true } as const;
const retry = { ok: false, retryable: true } as const;
const rejected = { ok: false, retryable: false } as const;
const simulated = { ok: true, simulated: true } as const;

test("a partial push retries and reports only the subscriptions that accepted it", () => {
  assert.deepEqual(summarizePush([{ id: "a", result: accepted }, { id: "b", result: retry }]),
    { status: "pending", error: "partial_push", delivered: ["a"] });
  assert.deepEqual(summarizePush([{ id: "b", result: accepted }], 1), { status: "sent", delivered: ["b"] });
});

test("an earlier delivery keeps the job sent when the remaining devices cannot be reached", () => {
  assert.deepEqual(summarizePush([], 2), { status: "sent", delivered: [] });
  assert.deepEqual(summarizePush([{ id: "b", result: rejected }], 1), { status: "sent", delivered: [] });
  assert.deepEqual(summarizePush([{ id: "b", result: retry }], 1), { status: "pending", error: "partial_push", delivered: [] });
});

test("no delivery is never counted as sent", () => {
  assert.deepEqual(summarizePush([{ id: "a", result: retry }]), { status: "pending", error: "push_retry", delivered: [] });
  assert.deepEqual(summarizePush([{ id: "a", result: simulated }]), { status: "skipped", error: "dry_run" });
  assert.deepEqual(summarizePush([{ id: "a", result: rejected }]), { status: "skipped", error: "push_unavailable" });
  assert.deepEqual(summarizePush([]), { status: "skipped", error: "no_push_target" });
});
