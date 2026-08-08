import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferenceForItem } from '../app/assets/js/core/catalog-identity.js';
import { renderPortfolio } from '../app/assets/js/views/portfolio.js';
import { renderSearch } from '../app/assets/js/views/search.js';

const item = {
  provider: 'pokemon', externalId: 'sv3-223', category: 'pokemon', game: 'Pokémon',
  name: 'Charizard ex', setName: 'Obsidian Flames', number: '223', variant: 'holofoil',
  rarity: 'Special Illustration Rare', image: '', imageSmall: '', price: 90, currency: 'USD'
};

function baseState(overrides = {}) {
  return {
    holdings: [],
    watchlistItems: [],
    settings: { currency: 'USD' },
    portfolio: { section: 'holdings', query: '', category: 'all', sort: 'recent-desc' },
    featureFlags: { watchlists: true, publicPriceIntelligence: false },
    intelligence: { byVariant: {}, loading: false, error: '' },
    alerts: [],
    search: { query: '', category: 'all', provider: 'all', loading: false, results: [], warnings: [] },
    ...overrides
  };
}

test('portfolio exposes the three sections without adding primary navigation', () => {
  const html = renderPortfolio(baseState());
  assert.match(html, /role="tablist"/);
  assert.match(html, />Holdings</);
  assert.match(html, />Watchlist</);
  assert.match(html, />Forecasts</);
});

test('watchlist renders exact identity safely and explains unsupported intelligence', () => {
  const catalogRef = catalogReferenceForItem({ ...item, name: '<script>bad</script>' });
  const html = renderPortfolio(baseState({
    portfolio: { section: 'watchlist', query: '', category: 'all', sort: 'recent-desc' },
    watchlistItems: [{ id: catalogRef.watchKey, watchKey: catalogRef.watchKey, catalogRef, canonicalVariantId: '', targetPrice: '', updatedAt: '2026-08-05T00:00:00.000Z' }]
  }));
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /Tier 0/);
  assert.match(html, /awaiting canonical mapping/);
  assert.match(html, /data-action="edit-watch"/);
});

test('watchlist surfaces only escaped approved-intelligence alert messages', () => {
  const variantId = '123e4567-e89b-42d3-a456-426614174000';
  const catalogRef = catalogReferenceForItem(item, { canonicalVariantId: variantId });
  const html = renderPortfolio(baseState({
    portfolio: { section: 'watchlist', query: '', category: 'all', sort: 'recent-desc' },
    watchlistItems: [{ id: catalogRef.watchKey, watchKey: catalogRef.watchKey, catalogRef, canonicalVariantId: variantId, targetPrice: '' }],
    alerts: [{ id: 'alert', watchKey: catalogRef.watchKey, message: '<img src=x onerror=bad> Target reached', triggeredAt: '2026-08-05T00:00:00Z', readAt: '' }]
  }));
  assert.match(html, /Approved intelligence alerts/);
  assert.match(html, /Target reached/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('search shows watching state and forecast center publishes no invented number', () => {
  const catalogRef = catalogReferenceForItem(item);
  const legacyPricedItem = {
    ...item,
    priceSource: 'Pokémon TCG API · TCGplayer market',
    priceOptions: [
      { finish: 'holofoil', price: 90, source: 'TCGplayer market' },
      { finish: 'reverse holofoil', price: 70, source: 'TCGplayer market' }
    ]
  };
  const search = renderSearch(baseState({
    watchlistItems: [{ id: catalogRef.watchKey, watchKey: catalogRef.watchKey, catalogRef }],
    search: { query: 'Charizard', category: 'pokemon', provider: 'pokemon', loading: false, results: [legacyPricedItem], warnings: [] }
  }));
  assert.match(search, /★ Watching/);
  assert.match(search, /Add to portfolio/);
  assert.doesNotMatch(search, /Review and add/);
  assert.match(search, /Price unavailable/);
  assert.doesNotMatch(search, /Choose finish|\$90\.00|\$70\.00/);

  const forecasts = renderPortfolio(baseState({
    portfolio: { section: 'forecasts', query: '', category: 'all', sort: 'recent-desc' }
  }));
  assert.match(forecasts, /Research gate active/);
  assert.doesNotMatch(forecasts, /Probability of gain|1-year outlook|\$845/);
});

test('multi-finish search results require an explicit finish choice before watching', () => {
  const search = renderSearch(baseState({
    search: {
      query: 'Sol Ring', category: 'magic', provider: 'scryfall', loading: false, warnings: [],
      results: [{ ...item, provider: 'scryfall', category: 'magic', game: 'Magic', name: 'Sol Ring', priceSource: 'Scryfall daily price', priceOptions: [{ finish: 'regular', price: 90 }, { finish: 'foil', price: 105 }] }]
    }
  }));
  assert.match(search, /Choose finish/);
  assert.match(search, /2 finishes/);
});

test('forecast center renders only a validated approved publication contract', () => {
  const variantId = '123e4567-e89b-42d3-a456-426614174000';
  const html = renderPortfolio(baseState({
    holdings: [{ id: 'holding', canonicalVariantId: variantId, item }],
    portfolio: { section: 'forecasts', query: '', category: 'all', sort: 'recent-desc' },
    featureFlags: { watchlists: true, publicPriceIntelligence: true },
    intelligence: { byVariant: { [variantId]: {
      variantId, supportTier: 4, reasonCodes: [], sourceAttributions: [{ name: 'Approved source' }],
      payload: {
        observed: { price: 100, currency: 'USD', source: 'Approved source' },
        forecasts: { 30: { q10: 80, q25: 90, q50: 105, q75: 120, q90: 140, probabilityUp: 0.6, confidence: 58, modelVersion: 'baseline-v1' } }
      }
    } }, loading: false, error: '' }
  }));
  assert.match(html, /30-day outlook/);
  assert.match(html, /Approved forecast projection/);
  assert.match(html, /Observed now/);
  assert.match(html, /1 product · 1 approved horizon/);
  assert.match(html, /\$105\.00/);
  assert.match(html, /60%/);
  assert.match(html, /baseline-v1/);
  assert.match(html, /Approved source/);
});
