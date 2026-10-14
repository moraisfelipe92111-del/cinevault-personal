/* CineVault Service Worker: application shell in production; TMDb posters offline everywhere. */
/* The build script replaces __CV_ASSETS__ below with hashed Vite filenames. */
const SHELL_VERSION = 'cinevault-shell-v131-1';
const IMAGE_CACHE = 'cinevault-posters-w342-v1';
const SHELL_ASSETS = /* __CV_ASSETS__ */ [];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (SHELL_ASSETS.length) {
      const cache = await caches.open(SHELL_VERSION);
      await cache.addAll(SHELL_ASSETS);
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('cinevault-shell-') && k !== SHELL_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // A controlled document may ask for remote, no-CORS images. Opaque cached
  // responses can be returned to <img> without accessing their bodies.
  if (url.hostname === 'image.tmdb.org' && url.pathname.startsWith('/t/p/')) {
    event.respondWith((async () => {
      const cache = await caches.open(IMAGE_CACHE);
      const local = await cache.match(req.url);
      if (local) return local;
      try { return await fetch(req); } catch { return Response.error(); }
    })());
    return;
  }
  if (url.origin !== self.location.origin || !SHELL_ASSETS.length) return;
  // Offline navigation fallback; online freshness still wins.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(req); }
      catch { return (await caches.match('/index.html')) || Response.error(); }
    })());
    return;
  }
  // Fingerprinted bundles are immutable. They may always be served from cache.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});
