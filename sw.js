/* ══════════════════════════════════════════════════
   sw.js  —  TES Pro Service Worker
   Caching strategy:
   • HTML navigation  → Network-first, offline fallback
   • Local assets     → Cache-first (instant on repeat visits)
   • CDN / Firebase   → Network-first, cache as backup
══════════════════════════════════════════════════ */

const CACHE   = 'tes-pro-v1';
const OFFLINE = 'index.html';
const PRECACHE = ['index.html', 'styles.css', 'app.js', 'firebase.js', 'manifest.json'];

/* ── Install: pre-cache core files ──────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: delete old caches ────────────────── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch: route-based caching strategy ────────── */
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  /* HTML navigation → network-first */
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then(r => { caches.open(CACHE).then(c => c.put(request, r.clone())); return r; })
        .catch(() => caches.match(OFFLINE))
    );
    return;
  }

  /* Same-origin assets (CSS, JS) → cache-first */
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(request).then(cached => cached ||
        fetch(request).then(r => {
          caches.open(CACHE).then(c => c.put(request, r.clone()));
          return r;
        })
      )
    );
    return;
  }

  /* Firebase / CDN → network-first, cache fallback */
  e.respondWith(
    fetch(request)
      .then(r => {
        if (r.ok) caches.open(CACHE).then(c => c.put(request, r.clone()));
        return r;
      })
      .catch(() => caches.match(request))
  );
});
