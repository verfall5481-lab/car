import { dataObject, RpcError } from './api.ts';
import type { RoleClient, Surface } from './api.ts';

export const scopeOf = (role: Surface) => role === 'guardian' ? '/p/' : role === 'rider' ? '/c/' : '/v/';

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function roleWorker(surface: Surface) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) throw new RpcError('PUSH_UNAVAILABLE');
  return navigator.serviceWorker.register('/sw.js', { scope: scopeOf(surface) });
}

export function vapidBytes(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new RpcError('PUSH_NOT_CONFIGURED');
  return bytes;
}

export async function currentSubscription(surface: Surface) {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration(scopeOf(surface));
  return registration?.pushManager ? registration.pushManager.getSubscription() : null;
}

export async function subscribePush(client: RoleClient, key?: string) {
  if (!window.isSecureContext || !('Notification' in window) || !('PushManager' in window)) throw new RpcError('PUSH_UNAVAILABLE');
  if (isIOS() && !isStandalone()) throw new RpcError('PUSH_INSTALL');
  if (!key) throw new RpcError('PUSH_NOT_CONFIGURED');
  let applicationServerKey: Uint8Array<ArrayBuffer>;
  try { applicationServerKey = vapidBytes(key); } catch { throw new RpcError('PUSH_NOT_CONFIGURED'); }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new RpcError('PUSH_DENIED');
  const registration = await roleWorker(client.surface);
  if (!registration.active) await new Promise<void>((resolve, reject) => {
    const worker = registration.installing ?? registration.waiting;
    if (!worker) { reject(new RpcError('PUSH_UNAVAILABLE')); return; }
    const timeout = window.setTimeout(() => { worker.removeEventListener('statechange', check); reject(new RpcError('PUSH_UNAVAILABLE')); }, 8_000);
    function check() {
      if (worker?.state !== 'activated') return;
      worker.removeEventListener('statechange', check);
      window.clearTimeout(timeout);
      resolve();
    }
    worker.addEventListener('statechange', check);
    check();
  });
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  const { keys } = subscription.toJSON();
  if (!keys?.p256dh || !keys.auth) throw new RpcError('PUSH_UNAVAILABLE');
  try {
    await client.rpc('register_push_subscription', { p_endpoint: subscription.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth }, dataObject);
  } catch (error) { if (!existing) await subscription.unsubscribe().catch(() => false); throw error; }
}

export async function unsubscribePush(client: RoleClient, cleanup = false) {
  const subscription = await currentSubscription(client.surface);
  if (subscription) {
    try { await client.rpc('unregister_push_subscription', { p_endpoint: subscription.endpoint }, dataObject); }
    catch (error) { if (!cleanup) throw error; }
    await subscription.unsubscribe();
  }
  if (cleanup && 'caches' in window) {
    const scope = scopeOf(client.surface).replaceAll('/', '');
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(`deriro-${scope}-`) || key.startsWith(`deriro-demo-${scope}-`)).map((key) => caches.delete(key)));
  }
}
