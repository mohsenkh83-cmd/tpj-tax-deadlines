const CACHE_NAME = "tpj-static-v1";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./tpj-logo.png",
  "./manifest.webmanifest"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(() => null)
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // JSON data must stay fresh: network first, cache fallback.
  if (
    url.pathname.endsWith("/deadlines.json") ||
    url.pathname.endsWith("/holidays.json") ||
    url.pathname.endsWith("/latest-updates.json") ||
    url.pathname.endsWith("/deadline-changes.json")
  ) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Static files: cache first, network fallback.
  event.respondWith(
    caches.match(req).then(cached => {
      return cached || fetch(req).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        return res;
      });
    })
  );
});
