// Service worker: guarda só o "casco" do app para abrir offline. A API (/v1) nunca é cacheada —
// valores e estados sempre vêm do servidor.

const CACHE = 'rachapay-shell-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/business.js', '/admin.js', '/ui.js', '/api.js', '/format.js', '/vendor/qrcode.mjs', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/') || url.pathname === '/health' || url.pathname === '/ready') return;
  // Rede primeiro (para pegar versão nova); cache como reserva offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/index.html'))),
  );
});
