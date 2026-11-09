export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; detail: Record<string, unknown> } };

const requestTimeout = 2_500;
export const env = (name: string) => Deno.env.get(name)?.trim() || undefined;

export function error(code: string): Result<never> {
  return { ok: false, error: { code, detail: {} } };
}

function appOrigin(): string | undefined {
  const value = env("APP_BASE_URL");
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) return undefined;
    if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) return undefined;
    return url.origin;
  } catch { return undefined; }
}

export function appUrl(path: string) {
  const origin = appOrigin();
  return origin && path.startsWith("/") && !path.startsWith("//") ? new URL(path, origin).toString() : undefined;
}

export function json(request: Request, body: unknown, status = 200) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin" });
  const origin = request.headers.get("origin");
  if (origin && origin === appOrigin()) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

export function method(request: Request, cors = false): Response | undefined {
  if (cors && request.method === "OPTIONS") {
    return request.headers.get("origin") === appOrigin()
      ? json(request, null, 204) : json(request, error("FORBIDDEN"), 403);
  }
  if (request.method !== "POST") return json(request, error("METHOD_NOT_ALLOWED"), 405);
  if (cors && request.headers.has("origin") && request.headers.get("origin") !== appOrigin()) {
    return json(request, error("FORBIDDEN"), 403);
  }
}

export async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await request.text();
    if (text.length > 4_096) return undefined;
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
  } catch { return undefined; }
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function validDispatchSecret(request: Request) {
  const supplied = request.headers.get("x-dispatch-secret");
  const secret = env("DISPATCH_SECRET");
  if (!supplied || !secret || secret.length < 24 || supplied.length > 512) return false;
  const encode = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [expected, actual] = await Promise.all([encode(secret), encode(supplied)]);
  const left = new Uint8Array(expected);
  const right = new Uint8Array(actual);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

function baseUrl() { return env("SUPABASE_URL")?.replace(/\/$/, ""); }
function publicKey() { return env("SUPABASE_PUBLISHABLE_KEY") ?? env("SUPABASE_ANON_KEY"); }

function serviceHeaders(): Headers | undefined {
  const secret = env("SUPABASE_SECRET_KEY");
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret && !legacy) return undefined;
  const headers = new Headers({ apikey: (secret ?? legacy)! });
  if (!secret && legacy) headers.set("Authorization", `Bearer ${legacy}`);
  return headers;
}

export async function verifyUser(request: Request): Promise<{ id: string; token: string } | undefined> {
  const authorization = request.headers.get("authorization");
  const key = publicKey();
  const base = baseUrl();
  if (!authorization?.startsWith("Bearer ") || !key || !base) return undefined;
  try {
    const response = await fetch(`${base}/auth/v1/user`, {
      headers: { Authorization: authorization, apikey: key }, redirect: "error", signal: AbortSignal.timeout(requestTimeout),
    });
    if (!response.ok) return undefined;
    const user = await response.json();
    if (typeof user.id !== "string" || !uuidPattern.test(user.id) || user.is_anonymous === true) return undefined;
    return { id: user.id, token: authorization };
  } catch { return undefined; }
}

export async function rpc<T>(name: string, params: Record<string, unknown>, userToken?: string): Promise<Result<T>> {
  const base = baseUrl();
  const publicApiKey = publicKey();
  const headers = userToken && publicApiKey
    ? new Headers({ apikey: publicApiKey, Authorization: userToken }) : userToken ? undefined : serviceHeaders();
  if (!base || !headers) return error("BACKEND_CONFIG");
  headers.set("content-type", "application/json");
  try {
    const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
      method: "POST", headers, body: JSON.stringify(params), redirect: "error", signal: AbortSignal.timeout(requestTimeout),
    });
    if (!response.ok) return error("BACKEND_FAILURE");
    return await response.json() as Result<T>;
  } catch { return error("BACKEND_FAILURE"); }
}

export async function deleteAuthUser(userId: string): Promise<boolean> {
  const base = baseUrl();
  const headers = serviceHeaders();
  if (!base || !headers || !uuidPattern.test(userId)) return false;
  try {
    const response = await fetch(`${base}/auth/v1/admin/users/${userId}`, {
      method: "DELETE", headers, redirect: "error", signal: AbortSignal.timeout(requestTimeout),
    });
    return response.ok || response.status === 404;
  } catch { return false; }
}
