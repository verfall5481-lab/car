const scope = new URL(self.registration.scope).pathname;
const cacheName = `deriro-${scope.replaceAll('/', '')}-v2`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  if (request.mode !== 'navigate' && !url.pathname.startsWith('/assets/')) return;
  if (request.mode === 'navigate' && !url.pathname.startsWith(scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const saved = await cache.match(request) || (request.mode === 'navigate' && await cache.match(scope));
      if (saved) return saved;
      throw error;
    }
  })());
});

function safeDestination(raw) {
  if (typeof raw !== 'string') return new URL(scope, self.location.origin);
  try {
    const url = new URL(raw, self.location.origin);
    if (url.origin === self.location.origin && url.pathname.startsWith(scope)) return url;
  } catch { /* Open the role home for invalid URLs. */ }
  return new URL(scope, self.location.origin);
}

self.addEventListener('push', (event) => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || typeof payload.title !== 'string' || typeof payload.body !== 'string') return;
  const url = safeDestination(payload.url);
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body, icon: `/icons/${scope === '/c/' ? 'rider' : 'family'}-192.png`,
    tag: typeof payload.tag === 'string' ? payload.tag : undefined, requireInteraction: payload.requireInteraction === true,
    data: { url: url.href },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeDestination(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const current = windows.find((client) => {
      const url = new URL(client.url);
      return url.origin === target.origin && url.pathname.startsWith(scope);
    });
    if (current) {
      try { const next = await current.navigate(target.href); if (next) return next.focus(); } catch { /* Open the destination in a new role window. */ }
    }
    return self.clients.openWindow(target.href);
  })());
});
