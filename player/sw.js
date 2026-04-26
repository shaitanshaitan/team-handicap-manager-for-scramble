// ─── Parmate Team HCP · Service Worker ───
const APP_VERSION = 'parmate-team-hcp-v2';

// App shell files to cache on install
const APP_SHELL = [
  '/player/',
  '/player/index.html',
  '/player/manifest.json',
  '/player/icons/icon-192.png',
  '/player/icons/icon-512.png'
];

// External origins that should always go network-first (never cached)
const NETWORK_ONLY_ORIGINS = [
  'firebaseapp.com',
  'googleapis.com',
  'gstatic.com',
  'firebaseio.com',
  'google-analytics.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// ─── INSTALL — cache app shell ───
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE — delete old caches ───
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== APP_VERSION)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH — strategy per request type ───
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always skip non-GET
  if (event.request.method !== 'GET') return;

  // Network-only for Firebase and Google APIs
  if (NETWORK_ONLY_ORIGINS.some(origin => url.hostname.includes(origin))) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for app shell (HTML, icons, manifest)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Not in cache — fetch and store
      return fetch(event.request)
        .then(response => {
          // Only cache valid same-origin responses
          if (
            response.ok &&
            response.type === 'basic' &&
            url.origin === self.location.origin
          ) {
            const clone = response.clone();
            caches.open(APP_VERSION).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline fallback — return cached app shell
          if (event.request.destination === 'document') {
            return caches.match('/player/index.html');
          }
        });
    })
  );
});

// ─── MESSAGE — force update from app ───
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
