import { body, deleteAuthUser, error, json, method, rpc, verifyUser } from "../_shared/http.ts";

Deno.serve(async (request) => {
  const methodError = method(request, true);
  if (methodError) return methodError;
  const user = await verifyUser(request);
  if (!user) return json(request, error("NOT_AUTHENTICATED"), 401);
  const input = await body(request);
  if (!input) return json(request, error("VALIDATION"), 400);
  const prepared = await rpc("prepare_delete_account", { p_confirm_family_delete: input.confirm_family_delete === true }, user.token);
  if (!prepared.ok) return json(request, prepared);
  if (!await deleteAuthUser(user.id)) return json(request, error("AUTH_DELETE_RETRY"), 503);
  return json(request, { ok: true, data: {} });
});
