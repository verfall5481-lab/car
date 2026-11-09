import webpush from "npm:web-push@3.6.7";
import { env } from "./http.ts";

export type Delivery =
  | { ok: true; providerId: string; simulated?: true }
  | { ok: false; error: string; retryable: boolean; gone?: true };

export interface SmsProvider {
  send(input: { to: string; text: string; refKey: string }): Promise<Delivery>;
}

export class DryRunSmsProvider implements SmsProvider {
  send({ refKey }: { to: string; text: string; refKey: string }): Promise<Delivery> {
    return Promise.resolve({ ok: true, simulated: true, providerId: `dry_run:${refKey}` });
  }
}

export class TwilioSmsProvider implements SmsProvider {
  constructor(private accountSid: string, private authToken: string, private serviceSid: string) {}

  async send({ to, text }: { to: string; text: string; refKey: string }): Promise<Delivery> {
    if (!/^\+[1-9]\d{7,14}$/.test(to) || text.length > 500) return { ok: false, error: "invalid_sms", retryable: false };
    try {
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, Body: text, MessagingServiceSid: this.serviceSid }),
        redirect: "error", signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) return { ok: false, error: `sms_http_${response.status}`, retryable: response.status === 429 || response.status >= 500 };
      const payload = await response.json();
      return typeof payload.sid === "string" ? { ok: true, providerId: payload.sid }
        : { ok: false, error: "invalid_sms_response", retryable: true };
    } catch { return { ok: false, error: "sms_transport", retryable: true }; }
  }
}

export function smsProvider(): SmsProvider | undefined {
  const mode = env("SMS_PROVIDER");
  if (mode === "dry_run") return new DryRunSmsProvider();
  const account = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  const service = env("TWILIO_MESSAGING_SERVICE_SID");
  if (mode === "twilio" && account && /^AC[0-9a-f]{32}$/i.test(account) && token && service && /^MG[0-9a-f]{32}$/i.test(service)) {
    return new TwilioSmsProvider(account, token, service);
  }
}

export type PushSubscription = { id: string; endpoint: string; keys: { p256dh: string; auth: string } };
export type PushPayload = { title: string; body: string; url: string; tag: string; requireInteraction: boolean };

export function validPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return endpoint.length <= 2048 && url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      url.pathname.length > 1 && (/^(fcm\.googleapis\.com|(updates\.)?push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/).test(url.hostname);
  } catch { return false; }
}

export async function sendPush(subscription: PushSubscription, payload: PushPayload, urgent: boolean): Promise<Delivery> {
  if (!validPushEndpoint(subscription.endpoint)) return { ok: false, error: "invalid_push_endpoint", retryable: false };
  if (env("PUSH_PROVIDER") === "dry_run") return { ok: true, simulated: true, providerId: "dry_run" };
  if (env("PUSH_PROVIDER") !== "web_push") return { ok: false, error: "push_disabled", retryable: false };
  const subject = env("VAPID_SUBJECT");
  const publicKey = env("VAPID_PUBLIC_KEY");
  const privateKey = env("VAPID_PRIVATE_KEY");
  if (!subject || !publicKey || !privateKey) return { ok: false, error: "push_disabled", retryable: false };
  try {
    const request = webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
      TTL: 600, urgency: urgent ? "high" : "normal",
      vapidDetails: { subject, publicKey, privateKey },
    });
    const headers = new Headers(Object.entries(request.headers).map(([key, value]) => [key, String(value)]));
    const response = await fetch(subscription.endpoint, {
      method: "POST", headers, body: request.body ? new Uint8Array(request.body) : null,
      redirect: "error", signal: AbortSignal.timeout(4_000),
    });
    if (response.status === 410 || response.status === 404) return { ok: false, error: "push_gone", retryable: false, gone: true };
    return response.ok ? { ok: true, providerId: "web_push" }
      : { ok: false, error: `push_http_${response.status}`, retryable: response.status === 429 || response.status >= 500 };
  } catch { return { ok: false, error: "push_transport", retryable: true }; }
}

export async function approximateRegion(lat: number, lng: number): Promise<{ label?: string; retryable?: boolean }> {
  const key = env("KAKAO_REST_API_KEY");
  if (env("GEOCODER_PROVIDER") !== "kakao" || !key) return {};
  try {
    const url = new URL("https://dapi.kakao.com/v2/local/geo/coord2regioncode.json");
    url.search = new URLSearchParams({ x: String(lng), y: String(lat) }).toString();
    const response = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` }, redirect: "error", signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return { retryable: response.status === 429 || response.status >= 500 };
    const data = await response.json() as { documents?: { region_type?: string; region_3depth_name?: string }[] };
    const documents = Array.isArray(data.documents) ? data.documents : [];
    const region = documents.find((item) => item.region_type === "H" && typeof item.region_3depth_name === "string");
    const name = region?.region_3depth_name?.trim();
    if (name && /^[가-힣0-9· -]{1,20}(동|읍|면|리|가)$/.test(name)) return { label: `${name} 근처` };
    return {};
  } catch { return { retryable: true }; }
}
