/**
 * Writely Service Worker
 * Strategy:
 *  - Static assets (CSS/JS/images): cache-first with background revalidation.
 *  - HTML pages: network-first → cache fallback → /offline.html.
 *  - API requests (POST or */api/*): never cached, always network. If offline, return JSON 503.
 *  - Firebase, Cashfree, third-party CDNs: bypass entirely.
 */
const VERSION = 'writely-v1';
const STATIC_CACHE = `${VERSION}-static`;
const PAGE_CACHE = `${VERSION}-pages`;

const PRECACHE = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/shared/utils/style.css',
  '/shared/utils/logic.js'
];

const BYPASS_HOSTS = [
  'firebaseio.com',
  'googleapis.com',
  'gstatic.com',
  'firebaseapp.com',
  'cashfree.com',
  'sentry.io',
  'nominatim.openstreetmap.org'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Cache one-by-one so a single 404 doesn't kill the install.
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => null)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function shouldBypass(url) {
  return BYPASS_HOSTS.some((h) => url.hostname.endsWith(h));
}

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

function isStaticAsset(url) {
  return /\.(?:css|js|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|webp|gif|ico)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache mutations
  const url = new URL(req.url);
  if (shouldBypass(url)) return;
  if (isApi(url)) return; // API responses are never cached

  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    // Network-first for pages
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(PAGE_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/offline.html')))
    );
    return;
  }

  if (isStaticAsset(url)) {
    // Cache-first for static
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchAndUpdate = fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => cached);
        return cached || fetchAndUpdate;
      })
    );
  }
});

// Allow page to trigger immediate update
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
