/* ============================================================
   GST Calculator — Service Worker
   CodeByRushi
   v3 — production update flow:
     • Cache name is versioned (gst-calc-codebyrushi-vN) — bumping
       the version on every deploy is what invalidates stale assets
       and is what the install/activate lifecycle reacts to.
     • install: pre-cache the app shell AND self.skipWaiting() so the
       new SW moves to "waiting" and is ready to take over.
     • activate: delete every cache that isn't the current version,
       then clients.claim() so the new SW controls open tabs without
       needing a reload to start serving them.
     • fetch:
         - Navigation requests (HTML pages): network-first, fall back
           to cache, then to a minimal offline shell. This is what
           guarantees an updated index.html is picked up after deploy.
         - Same-origin static assets (CSS/JS/manifest/icons): stale-
           while-revalidate. Serves the cached copy instantly (for
           offline support) and refreshes the cache in the background
           so the *next* load is up to date.
     • message: when the page sends { type: 'SKIP_WAITING' }, the new
       worker activates immediately. The page triggers this either
       automatically on controllerchange or when the user clicks the
       "Reload" button on the update banner.
   ============================================================ */

const CACHE_VERSION = 3;                                  // ← bump per deploy
const CACHE_NAME    = 'gst-calc-codebyrushi-v' + CACHE_VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install: pre-cache the app shell and move straight to "waiting"
// so an update is available the moment the page reloads.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete every cache that isn't the current version, then
// claim open clients so the new SW controls them without a reload.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Message channel: page can ask a waiting worker to activate now.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Minimal offline fallback so navigation requests never fail hard.
const OFFLINE_FALLBACK = '<!doctype html><meta charset="utf-8">' +
  '<title>Offline</title><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>body{font-family:system-ui,sans-serif;background:#0F1115;color:#E6E8EE;' +
  'min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;padding:24px}' +
  '.box{max-width:360px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{opacity:.7;margin:0}</style>' +
  '<div class="box"><h1>You\'re offline</h1><p>The app is not installed yet. Reconnect once to install it.</p></div>';

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GETs.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // ---- Navigation requests (HTML pages): network-first -----------
  // Guarantees an updated index.html is served on reload after deploy.
  // Falls back to cache (offline) and finally to a tiny offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Refresh the cached copy of the HTML so offline works next time.
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('./index.html'))
        )
        .then((res) => res || new Response(OFFLINE_FALLBACK, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        }))
    );
    return;
  }

  // ---- Same-origin static assets: stale-while-revalidate ---------
  // Serves the cached file instantly (offline support) and refreshes
  // it in the background so the next load sees the new version.
  if (sameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);   // network failed → keep using cache
        return cached || networkFetch;
      })
    );
    return;
  }

  // ---- Cross-origin: pass through, no caching --------------------
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
