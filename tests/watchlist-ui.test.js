import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferenceForItem } from '../app/assets/js/core/catalog-identity.js';
import { renderPortfolio } from '../app/assets/js/views/portfolio.js';
import { renderInsights } from '../app/assets/js/views/insights.js';
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
    snapshots: [],
    overview: { range: '3M' },
    insights: { view: 'forecasts', horizon: 90, alertFilter: 'all' },
    portfolio: { section: 'holdings', query: '', category: 'all', sort: 'recent-desc' },
    featureFlags: { watchlists: true, publicPriceIntelligence: false },
    intelligence: { byVariant: {}, history: [], loading: false, error: '' },
    alerts: [],
    search: { query: '', category: 'all', provider: 'all', loading: false, results: [], warnings: [] },
    ...overrides
  };
}

test('portfolio exposes supported collection sections while forecasts remain under Insights', () => {
  const html = renderPortfolio(baseState());
  assert.match(html, /role="tablist"/);
  assert.match(html, />Items</);
  assert.match(html, />Watchlist</);
  assert.doesNotMatch(html, />Forecasts</);
  const insights = renderInsights(baseState());
  assert.match(insights, /<h1>Insights<\/h1>/);
  assert.match(insights, /Insights sections/);
});

test('watchlist renders exact identity safely and explains unsupported intelligence', () => {
  const catalogRef = catalogReferenceForItem({ ...item, name: '<script>bad</script>' });
  const html = renderPortfolio(baseState({
    portfolio: { section: 'watchlist', query: '', category: 'all', sort: 'recent-desc' },
    watchlistItems: [{ id: catalogRef.watchKey, watchKey: catalogRef.watchKey, catalogRef, canonicalVariantId: '', targetPrice: '', updatedAt: '2026-08-05T00:00:00.000Z' }]
  }));
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  // DCL-LEX-08: badge sweep -- SUPPORT_LABELS' sentence-style tier 0 text
  // becomes the shared registry's short badge ("Identified").
  assert.match(html, /support-badge unsupported">Identified</);
  // DCL-COLL-02: the support-badge sentence is dropped -- the badge keeps
  // its short status text only, no appended verification-status clause.
  assert.doesNotMatch(html, /awaiting card verification/);
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
  // DCL-COLL-07: overview reads "N watched cards · M alerts" -- the
  // "Approved intelligence alerts:" label is deleted.
  assert.match(html, /1 alert/);
  assert.doesNotMatch(html, /Approved intelligence alerts/);
  assert.match(html, /Target reached/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('search shows watching state and forecast center publishes no invented number', () => {
  const catalogRef = catalogReferenceForItem(item);
  const legacyPricedItem = {
    ...item, matchBucket: 'exact', matchScore: 1,
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
  assert.match(search, />Watching</);
  assert.match(search, /data-action="add-catalog"/);
  assert.doesNotMatch(search, /Review and add/);
  assert.match(search, /Pricing not supported/);
  assert.doesNotMatch(search, /Choose finish|\$90\.00|\$70\.00/);

  const forecasts = renderInsights(baseState());
  // DCL-LEX-06/DCL-INS-03: the "Research gate active" badge and the
  // publication-gate explainer card are both removed; with the flag off,
  // the published-forecasts section simply doesn't render.
  assert.doesNotMatch(forecasts, /Research gate active/);
  assert.doesNotMatch(forecasts, /Published market forecasts remain gated/);
  assert.doesNotMatch(forecasts, /Probability of gain|\$845/);
});

test('conditionless search results recognize condition-aware mapped watches', () => {
  const variantId = '123e4567-e89b-42d3-a456-426614174000';
  const mappedItem = { ...item, canonicalVariantId: variantId, matchBucket: 'exact', matchScore: 1 };
  const catalogRef = catalogReferenceForItem(mappedItem, { marketCondition: 'Near Mint' });
  const search = renderSearch(baseState({
    watchlistItems: [{
      id: catalogRef.watchKey,
      watchKey: catalogRef.watchKey,
      canonicalVariantId: variantId,
      catalogRef,
      marketCondition: 'near-mint',
      updatedAt: '2026-08-10T00:00:00.000Z'
    }],
    search: { query: 'Charizard', category: 'pokemon', provider: 'pokemon', loading: false, results: [mappedItem], warnings: [] }
  }));
  assert.match(search, />Watching</);
});

test('multi-finish search results require an explicit finish choice before watching', () => {
  const search = renderSearch(baseState({
    search: {
      query: 'Sol Ring', category: 'magic', provider: 'scryfall', loading: false, warnings: [],
      results: [{ ...item, provider: 'scryfall', category: 'magic', game: 'Magic', name: 'Sol Ring', matchBucket: 'exact', matchScore: 1, priceSource: 'Scryfall daily price', priceOptions: [{ finish: 'regular', price: 90 }, { finish: 'foil', price: 105 }] }]
    }
  }));
  assert.match(search, /Choose finish/);
  assert.match(search, /2 finishes/);
});

test('forecast center renders only a validated approved publication contract', () => {
  const variantId = '123e4567-e89b-42d3-a456-426614174000';
  const html = renderInsights(baseState({
    holdings: [{
      id: 'holding', canonicalVariantId: variantId, item: { ...item, language: 'en' },
      condition: 'Near Mint', marketCondition: 'near-mint', quantity: 1, manualMarketPrice: ''
    }],
    insights: { view: 'forecasts', horizon: 30, alertFilter: 'all' },
    featureFlags: { watchlists: true, publicPriceIntelligence: true },
    intelligence: { byVariant: { [variantId]: {
      variantId, seriesIdentity: { sourceId: 'approved', currency: 'USD', language: 'en', finish: 'holofoil', conditionClass: 'raw', marketCondition: 'near-mint', priceSemantics: 'market' }, supportTier: 4, reasonCodes: [], sourceAttributions: [{ name: 'Approved source' }],
      payload: {
        observed: { price: 100, currency: 'USD', source: 'Approved source' },
        forecasts: { 30: { q10: 80, q25: 90, q50: 105, q75: 120, q90: 140, probabilityUp: 0.6, confidence: 58, modelVersion: 'baseline-v1' } }
      }
    } }, history: [], loading: false, error: '' }
  }));
  assert.match(html, /Published Forecasts/);
  assert.match(html, /Current market/);
  assert.match(html, /Middle 50%/);
  assert.match(html, /1 covered/);
  assert.match(html, /\$105\.00/);
  assert.match(html, /Limited evidence/);
  assert.doesNotMatch(html, /Approved forecast projection|60%|baseline-v1/);
});
