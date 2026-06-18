// ─── Parmate Team HCP · Service Worker ───
// v3 — root-served paths, network-first navigations, stale-while-revalidate assets.
const APP_VERSION = 'parmate-team-hcp-v3';
const APP_CACHE   = APP_VERSION;

// Minimal app shell (served at the site root). Kept tiny and cached individually
// so a single missing file can never abort install (the v2 bug that wedged the SW).
const APP_SHELL = ['/', '/index.html', '/manifest.json'];

// External origins that must always hit the network and never be cached.
const NETWORK_ONLY_ORIGINS = [
  'firebaseapp.com',
  'googleapis.com',
  'gstatic.com',
  'firebaseio.com',
  'google-analytics.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cloudfunctions.net',
  'identitytoolkit'
];

// ─── INSTALL — precache shell, tolerating individual failures ───
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE).then(cache =>
      Promise.all(APP_SHELL.map(url =>
        fetch(url, { cache: 'no-cache' })
          .then(res => { if (res && res.ok) return cache.put(url, res); })
          .catch(() => {})   // never let one bad URL abort install
      ))
    ).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE — delete old caches, take control ───
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== APP_CACHE).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── FETCH — strategy per request type ───
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (Firebase, Google APIs, fonts, CDNs) → let the browser fetch it.
  if (url.origin !== self.location.origin ||
      NETWORK_ONLY_ORIGINS.some(origin => url.hostname.includes(origin))) {
    return; // no respondWith → default network fetch, never cached
  }

  // Navigations (the HTML document) → network-first so the latest index.html always
  // wins; fall back to the cached shell only when offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(APP_CACHE).then(c => c.put('/index.html', clone)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(c => c || caches.match('/index.html')))
    );
    return;
  }

  // Same-origin assets (images, css, js) → stale-while-revalidate.
  // Serve from cache instantly when present, but always refresh in the background so
  // new deploys (e.g. avatar images) are picked up. NEVER substitute index.html here —
  // that was what turned missing images into broken icons.
  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req)
        .then(res => {
          if (res && res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(APP_CACHE).then(c => c.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);   // offline → whatever we had (may be undefined)
      return cached || networkFetch;
    })
  );
});

// ─── MESSAGE — force update from app ───
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
