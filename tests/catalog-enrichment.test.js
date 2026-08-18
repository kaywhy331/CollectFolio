import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEnrichmentToItem,
  bridgeProductMatch,
  fetchBridgeTable,
  fetchProviderCard,
  getEnrichmentForItem
} from '../app/assets/js/services/catalog-enrichment.js';

// Same minimal in-memory IndexedDB shim used by forecast-trajectory.test.js
// -- catalog-enrichment.js reuses the same 'catalogCache' store via
// core/db.js's getRecord/putRecord.
function installFakeIndexedDB() {
  const stores = { catalogCache: new Map() };
  function requestFor(action) {
    const target = new EventTarget();
    target.result = undefined;
    target.error = undefined;
    queueMicrotask(() => {
      try {
        target.result = action();
        target.dispatchEvent(new Event('success'));
      } catch (error) {
        target.error = error;
        target.dispatchEvent(new Event('error'));
      }
    });
    return target;
  }
  const db = {
    objectStoreNames: { contains: () => true },
    transaction(_names, _mode) {
      const txTarget = new EventTarget();
      queueMicrotask(() => txTarget.dispatchEvent(new Event('complete')));
      return {
        objectStore: (name) => ({
          get: (key) => requestFor(() => stores[name].get(key)),
          put: (value) => requestFor(() => { stores[name].set(value.key, value); return value; })
        }),
        addEventListener: txTarget.addEventListener.bind(txTarget)
      };
    }
  };
  const original = globalThis.indexedDB;
  globalThis.indexedDB = { open: () => requestFor(() => db) };
  return () => { globalThis.indexedDB = original; };
}

globalThis.window = { COLLECTFOLIO_CONFIG: { TCGCSV_CATALOG_URL: 'https://catalog.example/' } };

function fakeCatalogResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

function bridgeTable(overrides = {}) {
  return {
    modelVersion: 'catalog-bridge-v1',
    categoryId: 3,
    provider: 'pokemon',
    asOf: '2026-08-17',
    sets: [{ groupId: 1102, providerSetId: 'swsh12', matchMethod: 'name-exact' }],
    products: [{ groupId: 1102, productId: 5001, providerSetId: 'swsh12', providerCardId: 'poke-1', matchMethod: 'collector-number' }],
    ...overrides
  };
}

function tcgcsvItem(overrides = {}) {
  return { provider: 'tcgcsv', categoryId: 3, groupId: 1102, productId: 5001, image: '', name: 'Pikachu', rarity: '', ...overrides };
}

// Installs a stub globalThis.fetch that resolves the Pokemon card-detail
// endpoint getPokemonCard hits -- the only provider fetch path these
// tests exercise (no per-call injection point exists on the provider
// modules themselves, per pokemon.js/scryfall.js/ygoprodeck.js).
function installFakeGlobalFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('bridgeProductMatch finds a row by groupId+productId and is fail-closed otherwise', () => {
  const table = bridgeTable();
  assert.equal(bridgeProductMatch(table, 1102, 5001).providerCardId, 'poke-1');
  assert.equal(bridgeProductMatch(table, 1102, 9999), null);
  assert.equal(bridgeProductMatch(null, 1102, 5001), null);
  assert.equal(bridgeProductMatch({ products: null }, 1102, 5001), null);
});

test('fetchBridgeTable is fail-closed on a 404 (unpublished category) and does not throw', async () => {
  const restore = installFakeIndexedDB();
  try {
    const fetchImpl = async () => fakeCatalogResponse({}, { ok: false, status: 404 });
    const table = await fetchBridgeTable(3, { session: {}, fetchImpl, bypassCache: true });
    assert.equal(table, null);
  } finally {
    restore();
  }
});

test('fetchBridgeTable rejects a malformed payload (unknown provider, missing products array)', async () => {
  const restore = installFakeIndexedDB();
  try {
    const fetchImpl = async () => fakeCatalogResponse({ provider: 'not-a-real-provider', products: [] });
    assert.equal(await fetchBridgeTable(3, { session: {}, fetchImpl, bypassCache: true }), null);

    const fetchImpl2 = async () => fakeCatalogResponse({ provider: 'pokemon' });
    assert.equal(await fetchBridgeTable(3, { session: {}, fetchImpl: fetchImpl2, bypassCache: true }), null);
  } finally {
    restore();
  }
});

test('fetchBridgeTable reuses the cached value within TTL and skips a second network call', async () => {
  const restore = installFakeIndexedDB();
  try {
    // A categoryId untouched by any other test in this file: core/db.js
    // memoizes its IndexedDB connection at module scope, so the fake
    // store installed by installFakeIndexedDB() is *not* fully isolated
    // between tests in the same process -- reusing categoryId 3 here
    // would read back an earlier test's cached bridge table instead of
    // exercising a real cache hit.
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return fakeCatalogResponse(bridgeTable({ categoryId: 42 })); };
    const first = await fetchBridgeTable(42, { session: {}, fetchImpl });
    const second = await fetchBridgeTable(42, { session: {}, fetchImpl });
    assert.equal(calls, 1);
    assert.deepEqual(first, second);
  } finally {
    restore();
  }
});

test('fetchProviderCard is fail-closed when the provider fetch throws', async () => {
  const restore = installFakeIndexedDB();
  const restoreFetch = installFakeGlobalFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    const card = await fetchProviderCard('pokemon', 'poke-1', { bypassCache: true });
    assert.equal(card, null);
  } finally {
    restoreFetch();
    restore();
  }
});

test('fetchProviderCard returns null for an unknown provider or a missing externalId', async () => {
  const restore = installFakeIndexedDB();
  try {
    assert.equal(await fetchProviderCard('not-a-provider', 'x'), null);
    assert.equal(await fetchProviderCard('pokemon', ''), null);
  } finally {
    restore();
  }
});

test('getEnrichmentForItem is fail-closed for a non-tcgcsv item or missing catalog identifiers', async () => {
  assert.equal(await getEnrichmentForItem({ provider: 'scryfall' }), null);
  assert.equal(await getEnrichmentForItem(tcgcsvItem({ groupId: undefined })), null);
  assert.equal(await getEnrichmentForItem(tcgcsvItem({ productId: 0 })), null);
});

test('getEnrichmentForItem is fail-closed when the bridge table has no mapped product', async () => {
  const restore = installFakeIndexedDB();
  try {
    const fetchImpl = async () => fakeCatalogResponse(bridgeTable({ products: [] }));
    const enrichment = await getEnrichmentForItem(tcgcsvItem(), { session: {}, fetchImpl, bypassCache: true });
    assert.equal(enrichment, null);
  } finally {
    restore();
  }
});

test('getEnrichmentForItem resolves end to end: bridge table -> mapped product -> provider card -> display fields', async () => {
  const restore = installFakeIndexedDB();
  const restoreFetch = installFakeGlobalFetch(async (url) => {
    assert.match(String(url), /api\.pokemontcg\.io\/v2\/cards\/poke-1/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'poke-1', name: 'Pikachu VMAX', rarity: 'Rare Holo', set: { name: 'Silver Tempest', releaseDate: '2022-11-11' }, number: '7', images: { large: 'https://images.example/large.png', small: 'https://images.example/small.png' } } })
    };
  });
  try {
    const bridgeFetchImpl = async () => fakeCatalogResponse(bridgeTable());
    const enrichment = await getEnrichmentForItem(tcgcsvItem(), { session: {}, fetchImpl: bridgeFetchImpl, bypassCache: true });
    assert.ok(enrichment);
    assert.equal(enrichment.provider, 'pokemon');
    assert.equal(enrichment.matchMethod, 'collector-number');
    assert.equal(enrichment.name, 'Pikachu VMAX');
    assert.equal(enrichment.image, 'https://images.example/large.png');
    assert.equal(enrichment.rarity, 'Rare Holo');
  } finally {
    restoreFetch();
    restore();
  }
});

test('applyEnrichmentToItem is a no-op passthrough when there is no enrichment', () => {
  const item = tcgcsvItem({ image: 'https://tcgcsv.example/img.png' });
  assert.equal(applyEnrichmentToItem(item, null), item);
});

test('applyEnrichmentToItem prefers the provider image on detail view but keeps the fast TCGCSV image on list/browse', () => {
  const enrichment = { provider: 'pokemon', matchMethod: 'collector-number', image: 'https://provider.example/hi-res.png', imageSmall: '', name: 'Pikachu VMAX', rarity: 'Rare Holo' };
  const item = tcgcsvItem({ image: 'https://tcgcsv.example/img.png' });

  const detailView = applyEnrichmentToItem(item, enrichment, { preferProviderImage: true });
  // externalImage() (core/components.js) picks src from
  // [userImage, imageSmall, image] in that order, so the provider's
  // high-res art must land in `imageSmall` to actually win detail-view
  // display, with the original TCGCSV image kept as its fallback.
  assert.equal(detailView.imageSmall, 'https://provider.example/hi-res.png');
  assert.equal(detailView.image, 'https://tcgcsv.example/img.png');
  assert.equal(detailView.enrichment, enrichment);

  const listView = applyEnrichmentToItem(item, enrichment);
  assert.equal(listView.image, 'https://tcgcsv.example/img.png');
});

test('applyEnrichmentToItem falls back to the provider image when TCGCSV has none, even outside detail view', () => {
  const enrichment = { provider: 'pokemon', matchMethod: 'name-exact', image: 'https://provider.example/only.png', imageSmall: '', name: 'Pikachu VMAX', rarity: '' };
  const item = tcgcsvItem({ image: '' });
  const listView = applyEnrichmentToItem(item, enrichment);
  assert.equal(listView.image, 'https://provider.example/only.png');
});
