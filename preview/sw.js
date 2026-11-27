const V = 'pdf-zoom-preview-1';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'manifest.webmanifest',
  '../../vendor/pdf.min.mjs',
  '../../vendor/pdf.worker.min.mjs',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== V && k !== 'pdf-zoom-shared').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Android share sheet → this app
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      try {
        const form = await event.request.formData();
        const file = form.get('pdf');
        if (file && file.name) {
          const cache = await caches.open('pdf-zoom-shared');
          await cache.put('/__shared__', new Response(file, {
            headers: { 'content-type': 'application/pdf', 'x-filename': encodeURIComponent(file.name) },
          }));
        }
      } catch (err) { /* fall through to app */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (event.request.method !== 'GET') return;

  // cMap / font assets: cache-first
  if (url.pathname.includes('/vendor/cmaps/') || url.pathname.includes('/vendor/standard_fonts/')) {
    event.respondWith((async () => {
      const hit = await caches.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) {
        const c = await caches.open(V);
        c.put(event.request, res.clone());
      }
      return res;
    })());
    return;
  }

  // app shell: network-first so updates land, offline falls back to cache
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      if (res.ok && url.origin === location.origin) {
        const c = await caches.open(V);
        c.put(event.request, res.clone());
      }
      return res;
    } catch (err) {
      const hit = await caches.match(event.request);
      if (hit) return hit;
      if (event.request.mode === 'navigate') return caches.match('index.html');
      throw err;
    }
  })());
});
