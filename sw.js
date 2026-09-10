// TPJ cache migration: fresh pages, live-only JSON, no caching of admin/API traffic.
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = 'tpj-public-' + encodeURIComponent(SCOPE.pathname) + '-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
const keyFor = path => new URL(path, SCOPE).href;
const STATIC_PATHS = new Set(['tpj-logo.png', 'manifest.webmanifest']);
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k === 'tpj-static-v1' || (k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  if (req.headers.has('Authorization')) return;
  const path = url.pathname.slice(SCOPE.pathname.length);
  // Do not serve stale calendar/news/review data on network failure.
  // The page's existing error handling tells the user when live data is unavailable.
  if (path.endsWith('.json') || path === 'admin.html' || path === 'review-admin.js') {
    event.respondWith(fetch(req, {cache:'no-store'}));
    return;
  }
  const isHome = path === '' || path === 'index.html';
  if (!isHome && !STATIC_PATHS.has(path)) return;
  const key = keyFor(isHome ? 'index.html' : path);
  const response = (async () => {
    try {
      const res = await fetch(req, {cache:'no-store'});
      if (res.ok && res.type !== 'opaque' && !res.redirected) {
        const copy = res.clone();
        // Cache writes cannot make a successful online response fail.
        await caches.open(CACHE_NAME).then(c => c.put(key,copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.open(CACHE_NAME).then(c => c.match(key)).catch(() => null);
      if (cached) return cached;
      if (isHome) return new Response('<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اتصال اینترنت</title><p>برای دریافت آخرین اخبار و مواعید به اینترنت وصل شوید و صفحه را دوباره باز کنید.</p></html>', {status:503,headers:{'Content-Type':'text/html; charset=utf-8'}});
      return Response.error();
    }
  })();
  event.respondWith(response);
  event.waitUntil(response.then(() => {}).catch(() => {}));
});
