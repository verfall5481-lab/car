// Pure aggregation of one Web Push job across the recipient's subscriptions. No runtime imports, so the
// Node contract tests can exercise it directly alongside the Deno edge tests.

export type PushAttempt =
  | { ok: true; simulated?: true }
  | { ok: false; retryable: boolean };

export type PushOutcome = {
  status: "sent" | "skipped" | "failed" | "pending";
  error?: string;
  // Subscriptions that accepted the message in this attempt. The worker records them so a retry skips them.
  delivered?: string[];
};

/**
 * @param attempts one entry per subscription that was still pending for this job, in the same order
 * @param deliveredBefore how many subscriptions accepted this job in earlier attempts
 */
export function summarizePush(attempts: { id: string; result: PushAttempt }[], deliveredBefore = 0): PushOutcome {
  const delivered = attempts.filter(({ result }) => result.ok && !result.simulated).map(({ id }) => id);
  const reached = delivered.length + Math.max(0, deliveredBefore);
  const retryable = attempts.some(({ result }) => !result.ok && result.retryable);
  if (retryable) return { status: "pending", error: reached > 0 ? "partial_push" : "push_retry", delivered };
  if (reached > 0) return { status: "sent", delivered };
  if (attempts.some(({ result }) => result.ok && result.simulated)) return { status: "skipped", error: "dry_run" };
  return { status: "skipped", error: attempts.length ? "push_unavailable" : "no_push_target" };
}
