const CACHE_NAME = 'mane-synth-v3';
const ASSETS = [
  './',
  './index.html',
  './script.js',
  './styles.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Instalar: cachear todos los archivos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activar: limpiar caches viejos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: servir desde cache, fallback a red
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
