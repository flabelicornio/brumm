// sw.js - Versión 4.0.0 Optimizada
const CACHE_NAME = 'brumm-cache-v4.0.0';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg'
];

// Instalación: Guardar recursos estáticos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activación: Borrar cachés viejas inmediatamente
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Estrategia de Red: Stale-While-Revalidate para archivos de app, bypass para streaming
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // No almacenar audio/video en caché para evitar llenar la memoria interna
  if (
    url.hostname.includes('jamendo.com') ||
    url.hostname.includes('archive.org') ||
    event.request.destination === 'audio' ||
    event.request.destination === 'video'
  ) {
    return;
  }

  // Responder rápido desde caché y actualizar la caché desde la red en segundo plano
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      });
    })
  );
});