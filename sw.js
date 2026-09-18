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

const CACHE_NAME = 'fiction-clash-v9';

// Everything the app needs to boot and render with zero network. Beyond
// index.html + icons (already here), this now also precaches the actual
// app code — without these, a person's very first visit wouldn't be
// offline-ready: the fetch handler below only starts caching things once
// this worker is installed AND controlling the page, so on that first
// visit styles.css/app.js/etc. load via the page's own normal (non-SW)
// network request and never pass through here at all. Precaching them
// during install means one visit is enough, not two.
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/styles.css',
  '/js/firebase-init.js',
  '/js/app.js',
  '/js/pull-to-refresh.js',
  '/js/viewport-height.js',
  '/js/qa-ring.js',
  '/js/docked-composer.js',
  '/js/back-button.js',
  '/js/sw-register.js',
  '/js/onesignal-init.js',
  '/js/debug-console.js'
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
    caches.open(CACHE_NAME).then(cache =>
      // Deliberately NOT cache.addAll(SHELL_FILES) — addAll is all-or-
      // nothing, so a single 404 (typo, a file that isn't actually
      // deployed) would silently skip caching every other file too, not
      // just the bad one. allSettled + individual cache.add lets each
      // file succeed or fail on its own.
      Promise.allSettled(SHELL_FILES.map(file => cache.add(file))).then(results => {
        results.forEach((result, i) => {
          if (result.status === 'rejected') {
            console.warn('Fiction Clash: shell file failed to precache:', SHELL_FILES[i], result.reason);
          }
        });
      })
    )
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
