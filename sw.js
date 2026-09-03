importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDKWorker.js');

// Fiction Clash service worker
//
// IMPORTANT:
// - Keep this file at the root of the website as /sw.js
// - Do NOT rename it to sw-fixed.js or sw (1).js
// - API requests are never cached.
// - OneSignal's worker is loaded above for push notifications.

const CACHE_NAME = 'fiction-clash-v3';

const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Requests where the newest version of the site should always be preferred.
function isAlwaysFreshRequest(request, url) {
  return (
    request.mode === 'navigate' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.json'
  );
}

// Install the new service worker.
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .catch(error => {
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
      .
