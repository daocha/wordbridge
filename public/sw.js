// Service worker: keeps the app shell available offline.
// Dictionary data is stored by the page in IndexedDB (see js/data.js), so data/
// requests are not cached here.

const VERSION = 'wordbridge-v1';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/data.js',
  './js/i18n.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];
const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const scope = new URL(self.registration.scope);

/** Network first (fresh when online), falling back to the cache when offline or slow. */
async function networkFirst(request, cacheKey) {
  const cache = await caches.open(VERSION);
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(cacheKey, res.clone());
    return res;
  });
  network.catch(() => {}); // a late failure after the timeout is not an error
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch { /* offline */ }
  const cached = await cache.match(cacheKey, { ignoreSearch: true });
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname.startsWith(scope.pathname + 'data/')) return; // handled via IndexedDB

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, new URL('./index.html', scope).href));
  } else {
    event.respondWith(networkFirst(request, request));
  }
});
