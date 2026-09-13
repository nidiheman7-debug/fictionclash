importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDKWorker.js');

// Fiction Clash service worker
//
// IMPORTANT:
// - Keep this file at the root of the website as /sw.js
// - Do NOT rename it to sw-fixed.js or sw (1).js
// - API requests are never cached.
// - OneSignal's worker is loaded above for push notifications.
//
// Strategy: cache the app shell (HTML/manifest/icons) so the app opens
// instantly on repeat visits and has basic offline fallback. Deliberately
// does NOT cache anything under /api/ - votes, AI stats, and news must
// always hit the network live, never a stale cached response.
//
// Bump CACHE_NAME whenever you want to force everyone onto a fresh cache
// after a deploy (e.g. 'fiction-clash-v5').

const CACHE_NAME = 'fiction-clash-v8';

const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Requests where the newest version of the site should always be preferred.
// The HTML document and manifest define what the app even is - serving a
// stale cached copy of these after a deploy is what caused "I fixed it but
// it's still broken" symptoms before. Season assets (hero art, banners,
// loading screen) get the same treatment - they get swapped out in place
// with the same filename fairly often, and a stale cached copy there
// causes the exact same "I fixed it but it's still broken" confusion.
function isAlwaysFreshRequest(request, url) {
  return (
    request.mode === 'navigate' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/public/seasons/')
  );
}

// Install the new service worker.
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .catch(error => {
        // Non-fatal - if a shell file 404s during install, don't block activation.
        console.warn('Fiction Clash cache install failed:', error);
      })
  );

  // Activate the new worker immediately.
  self.skipWaiting();
});

// Remove old Fiction Clash caches.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache API calls - always live.
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
        .catch(() => {
          // caches.match(event.request) matches the exact URL by default,
          // query string included. This app's precached shell is only
          // stored under the bare '/' and '/index.html' — so a real-world
          // URL like '/?ref=share' or '/?matchup=123' would miss that
          // exact-match lookup, resolve to nothing, and hand the browser
          // its own generic offline interstitial instead of this app's
          // shell (that generic "You're offline" screen using the
          // manifest icon IS what a failed navigate with no fallback
          // response looks like). Since this is a single-page app, any
          // navigation offline should resolve to the same cached shell
          // regardless of path or query string.
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html').then(r => r || caches.match('/'));
          }
          return caches.match(event.request, { ignoreSearch: true });
        })
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
