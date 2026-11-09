import { geoLabel } from "../_shared/dispatch.ts";
import { body, error, json, method, rpc, uuidPattern, validDispatchSecret } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const methodError = method(request);
  if (methodError) return methodError;
  if (!await validDispatchSecret(request)) return json(request, error("NOT_AUTHENTICATED"), 401);
  const input = await body(request);
  if (!input || typeof input.id !== "number" || !Number.isSafeInteger(input.id) || input.id < 1 ||
    typeof input.token !== "string" || !uuidPattern.test(input.token)) return json(request, error("VALIDATION"), 400);
  const validation = await rpc<{ valid: boolean; demo?: boolean; lat?: number; lng?: number }>("svc_outbox_still_valid", { p_id: input.id, p_token: input.token });
  if (!validation.ok) return json(request, validation, 503);
  if (!validation.data.valid) return json(request, error("NOT_FOUND"), 404);
  return json(request, { ok: true, data: await geoLabel({ id: input.id, claim_token: input.token }, validation.data) });
});
