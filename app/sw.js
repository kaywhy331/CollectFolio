const CACHE = 'collectfolio-shell-v0.1.0';
const IMAGE_CACHE = 'collectfolio-provider-images-v1';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './runtime-config.js',
  './assets/css/app.css', './assets/icons/icon.svg', './assets/js/app.js',
  './assets/js/core/store.js', './assets/js/core/utils.js', './assets/js/core/ui.js',
  './assets/js/core/components.js', './assets/js/core/calculations.js', './assets/js/core/db.js',
  './assets/js/views/home.js', './assets/js/views/portfolio.js', './assets/js/views/profile.js',
  './assets/js/views/add.js'
];
const PROVIDER_IMAGE_HOSTS = new Set([
  'images.pokemontcg.io', 'cards.scryfall.io', 'images.ygoprodeck.com'
]);
const CATALOG_HOSTS = new Set([
  'api.pokemontcg.io', 'api.scryfall.com', 'db.ygoprodeck.com'
]);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => ![CACHE, IMAGE_CACHE].includes(key)).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (CATALOG_HOSTS.has(url.hostname)) return;
  if (PROVIDER_IMAGE_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(event.request, IMAGE_CACHE));
    return;
  }
  if (url.origin !== location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put('./index.html', response.clone()));
      return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(cacheFirst(event.request, CACHE));
});
