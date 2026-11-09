import { appUrl, body, error, json, method, rpc, uuidPattern, verifyUser } from "../_shared/http.ts";
import { DryRunSmsProvider, smsProvider } from "../_shared/providers.ts";

Deno.serve(async (request) => {
  const methodError = method(request, true);
  if (methodError) return methodError;
  const user = await verifyUser(request);
  if (!user) return json(request, error("NOT_AUTHENTICATED"), 401);
  const input = await body(request);
  if (!input || typeof input.rider_id !== "string" || !uuidPattern.test(input.rider_id)) return json(request, error("VALIDATION"), 400);
  const provider = smsProvider();
  if (!provider || !appUrl("/")) return json(request, error("SMS_DISABLED"), 503);
  const invite = await rpc<{ code: string; url: string; expires_at: string; rider_name: string; phone_e164: string; is_demo: boolean }>(
    "create_rider_invite", { p_rider_id: input.rider_id, p_channel: "sms" }, user.token,
  );
  if (!invite.ok) return json(request, invite);
  const { code, expires_at, rider_name, phone_e164, url: path, is_demo } = invite.data;
  const url = appUrl(path);
  if (!url) return json(request, error("SMS_DISABLED"), 503);
  const sent = await (is_demo ? new DryRunSmsProvider() : provider).send({
    to: phone_e164, text: `[데리러] ${rider_name} 폰 연결 숫자 ${code} (10분). 설치 안내: ${url}`, refKey: crypto.randomUUID(),
  });
  if (!sent.ok) return json(request, { ok: false, error: { code: "SMS_FAILED", detail: { retryable: sent.retryable } } }, 502);
  return json(request, { ok: true, data: { code, url, expires_at, simulated: sent.simulated === true } });
});
