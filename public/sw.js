const CACHE_NAME = 'brumm-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Ignorar peticiones externas de audio/video de la caché para no saturar almacenamiento
  if (e.request.url.includes('jamendo.com') || e.request.url.includes('archive.org')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
