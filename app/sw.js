const CACHE = 'collectfolio-shell-v0.8.36';
const IMAGE_CACHE = 'collectfolio-provider-images-v1';
const VISUAL_INDEX_CACHE = 'collectfolio-visual-index-v1';
const MAX_PROVIDER_IMAGE_ENTRIES = 160;
const MAX_VISUAL_INDEX_ENTRIES = 20;
const SHELL = [
  './', './index.html', './manifest.webmanifest', './runtime-config.js',
  './assets/css/app.css', './assets/icons/icon.svg', './assets/icons/icon-192.png',
  './assets/icons/icon-512.png', './assets/js/app.js',
  './assets/js/core/store.js', './assets/js/core/utils.js', './assets/js/core/ui.js',
  './assets/js/core/components.js', './assets/js/core/calculations.js', './assets/js/core/catalog-identity.js', './assets/js/core/catalog-images.js', './assets/js/core/catalog-crumb.js',
  './assets/js/core/pricing-policy.js', './assets/js/core/market-series.js', './assets/js/core/compare.js', './assets/js/core/router.js',
  './assets/js/core/view-models.js', './assets/js/core/settings.js', './assets/js/core/data-freshness.js', './assets/js/core/portfolio-sets.js',
  './assets/js/core/intelligence-contract.js', './assets/js/core/intelligence-alerts.js', './assets/js/core/insights.js', './assets/js/core/local-scenarios.js', './assets/js/core/scenario-lab.js', './assets/js/core/db.js',
  './assets/js/core/history-chart.js', './assets/js/core/chart-hover.js', './assets/js/core/portfolio-history.js',
  './assets/js/core/copy.js', './assets/js/core/methodology.js', './assets/js/core/icons.js',
  './assets/js/views/home.js', './assets/js/views/portfolio.js', './assets/js/views/profile.js',
  './assets/js/views/insights.js', './assets/js/views/onboarding.js',
  './assets/js/views/price-intelligence-detail.js', './assets/js/views/quick-inspector.js', './assets/js/views/holding-form.js',
  './assets/js/views/add.js', './assets/js/views/search.js', './assets/js/services/catalog.js', './assets/js/services/catalog-browse.js',
  './assets/js/services/providers/pokemon.js', './assets/js/services/providers/scryfall.js',
  './assets/js/services/providers/ygoprodeck.js', './assets/js/services/providers/tcgcsv.js', './assets/js/services/providers/tcgcsv-categories.js', './assets/js/services/image-algorithms.js',
  './assets/js/services/image.js', './assets/js/services/scan-workbench.js', './assets/js/services/scan-detection-worker.js',
  './assets/js/services/scan-review.js', './assets/js/services/visual-index.js', './assets/js/services/supabase.js', './assets/js/services/watchlist.js',
  './assets/js/services/collectcapture.js',
  './assets/js/services/price-intelligence.js',
  './assets/js/services/forecast-trajectory.js',
  './assets/js/services/history-trajectory.js',
  './assets/js/services/catalog-enrichment.js',
  './assets/js/services/justtcg-refresh.js',
  './assets/js/services/tcgcsv-refresh-status.js',
  './assets/js/services/demand-events.js',
  './assets/js/views/scan.js',
  './assets/data/visual-index/pokemon-v1/manifest.json'
];
const PROVIDER_IMAGE_HOSTS = new Set([
  'images.pokemontcg.io', 'images.scrydex.com', 'assets.tcgdex.net', 'cards.scryfall.io', 'svgs.scryfall.io', 'images.ygoprodeck.com',
  'tcgplayer-cdn.tcgplayer.com'
]);
const CATALOG_HOSTS = new Set([
  'api.pokemontcg.io', 'api.tcgdex.net', 'api.scryfall.com', 'db.ygoprodeck.com'
]);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => ![CACHE, IMAGE_CACHE, VISUAL_INDEX_CACHE].includes(key)).map((key) => caches.delete(key)));
    await trimCache(IMAGE_CACHE, MAX_PROVIDER_IMAGE_ENTRIES);
    await trimCache(VISUAL_INDEX_CACHE, MAX_VISUAL_INDEX_ENTRIES);
    await self.clients.claim();
  })());
});

async function trimCache(cacheName, maximumEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = Math.max(0, keys.length - maximumEntries);
  if (excess) await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
}

async function cacheFirst(request, cacheName, maximumEntries = 0) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request)
    || (cacheName === VISUAL_INDEX_CACHE ? await caches.open(CACHE).then((shell) => shell.match(request)) : null);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') {
    try {
      await cache.put(request, response.clone());
      if (maximumEntries) await trimCache(cacheName, maximumEntries);
    } catch { /* Never hide a usable response when browser storage is unavailable. */ }
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      try { await cache.put(request, response.clone()); } catch { /* The live configuration remains usable without CacheStorage. */ }
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (CATALOG_HOSTS.has(url.hostname)) return;
  if (PROVIDER_IMAGE_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(event.request, IMAGE_CACHE, MAX_PROVIDER_IMAGE_ENTRIES));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/assets/data/visual-index/')) {
    event.respondWith(cacheFirst(event.request, VISUAL_INDEX_CACHE, MAX_VISUAL_INDEX_ENTRIES));
    return;
  }
  if (url.pathname === '/runtime-config.js') {
    event.respondWith(networkFirst(event.request, CACHE));
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(async (response) => {
      if (response.ok) await caches.open(CACHE).then((cache) => cache.put('./index.html', response.clone()));
      return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(cacheFirst(event.request, CACHE));
});
