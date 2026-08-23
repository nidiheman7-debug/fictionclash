// Fiction Clash service worker
//
// Strategy: cache the app shell (HTML/manifest/icons) so the app opens
// instantly on repeat visits and has basic offline fallback. Deliberately
// does NOT cache anything under /api/ — votes, AI stats, and news must
// always hit the network live, never a stale cached response.
//
// Bump CACHE_NAME whenever you want to force everyone onto a fresh cache
// after a deploy (e.g. 'fiction-clash-v3').
const CACHE_NAME = 'fiction-clash-v2';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Requests that must always try the network FIRST, falling back to cache
// only when offline. The HTML document and manifest define what the app
// even is — serving a stale cached copy of these after a deploy is what
// caused "I fixed it but it's still broken" symptoms before.
function isAlwaysFreshRequest(request, url){
  return request.mode === 'navigate' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.json';
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).catch(() => {
      // Non-fatal — if a shell file 404s during install, don't block activation.
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache API calls — always live.
  if (url.pathname.startsWith('/api/')) return;

  // Only handle same-origin GET requests; let everything else pass through normally.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (isAlwaysFreshRequest(event.request, url)) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to cache if we have it
      return cached || network;
    })
  );
});
