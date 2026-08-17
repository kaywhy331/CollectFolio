import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferenceForItem } from '../app/assets/js/core/catalog-identity.js';
import { renderPriceIntelligenceDetail } from '../app/assets/js/views/price-intelligence-detail.js';
import { portfolioMovers, renderHome, watchlistSignals } from '../app/assets/js/views/home.js';

const variantId = '123e4567-e89b-42d3-a456-426614174000';
const item = {
  provider: 'pokemon', externalId: 'sv3-223', category: 'pokemon', game: 'Pokémon',
  name: 'Charizard ex', setName: 'Obsidian Flames', number: '223', variant: 'holofoil', language: 'en', marketCondition: 'near-mint',
  rarity: 'Special Illustration Rare', image: '', imageSmall: '', price: 90, currency: 'USD'
};

function baseState(overrides = {}) {
  return {
    holdings: [],
    snapshots: [],
    watchlistItems: [],
    settings: { currency: 'USD' },
    portfolio: { section: 'holdings', query: '', category: 'all', sort: 'recent-desc' },
    featureFlags: { watchlists: true, publicPriceIntelligence: false },
    intelligence: { byVariant: {}, loading: false, error: '' },
    alerts: [],
    scanDraftCount: 0,
    search: { query: '', category: 'all', provider: 'all', loading: false, results: [], warnings: [] },
    ...overrides
  };
}

function publication(payload, supportTier, reasonCodes = []) {
  return { variantId, seriesIdentity: { sourceId: 'approved', currency: 'USD', language: 'en', finish: 'holofoil', conditionClass: 'raw', marketCondition: 'near-mint', priceSemantics: 'market' }, supportTier, publicationStatus: 'published', reasonCodes, payload, sourceAttributions: [], publishedAt: '2026-08-01T00:00:00Z', expiresAt: '' };
}

test('detail view without a selection offers a way back instead of crashing', () => {
  const html = renderPriceIntelligenceDetail(null, baseState());
  assert.match(html, /No card selected/);
  assert.match(html, /data-go="portfolio"/);
});

test('unmapped card detail explains the mapping gap and invents no numbers', () => {
  const catalogRef = catalogReferenceForItem({ ...item, name: '<script>bad</script>' });
  const html = renderPriceIntelligenceDetail({ origin: 'search', item, catalogRef }, baseState());
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /Card identified; pricing pending/);
  assert.match(html, /exact card verification/i);
  assert.match(html, /Nothing here is a fabricated estimate/);
  assert.doesNotMatch(html, /Modeled range \(10–90%\)/);
});

test('mapped card without a publication states unavailability honestly', () => {
  const catalogRef = catalogReferenceForItem(item, { canonicalVariantId: variantId });
  const html = renderPriceIntelligenceDetail({ origin: 'portfolio', item, catalogRef }, baseState());
  assert.match(html, /Why intelligence is unavailable/);
  assert.match(html, /disabled until source rights/);
});

test('detail abstains instead of choosing the first ambiguous holding series', () => {
  const conditionlessItem = { ...item, marketCondition: '' };
  const catalogRef = catalogReferenceForItem(conditionlessItem, { canonicalVariantId: variantId, marketCondition: '' });
  const holdings = [
    { id: 'nm', canonicalVariantId: variantId, item: conditionlessItem, condition: 'Near Mint', marketCondition: 'near-mint', quantity: 1 },
    { id: 'lp', canonicalVariantId: variantId, item: conditionlessItem, condition: 'Excellent', marketCondition: 'lightly-played', quantity: 1 }
  ];
  const html = renderPriceIntelligenceDetail(
    { origin: 'search', item: conditionlessItem, catalogRef },
    baseState({ holdings })
  );
  assert.doesNotMatch(html, /Your holding/);
  assert.match(html, /Market condition<\/dt><dd>Not confirmed/);
});

test('owned catalog card detail no longer renders local-scenario-v1, deferring to a published trajectory forecast', () => {
  // local-scenario-v1 is demoted to manual/custom items only (T6): this
  // holding is catalog-linked (item.provider 'pokemon'), so its detail
  // must show the demotion reason instead of a modeled manual-scenario
  // range, even though it carries a manual price override.
  const catalogRef = catalogReferenceForItem(item, { canonicalVariantId: variantId });
  const holding = {
    id: 'owned-local', canonicalVariantId: variantId, item, quantity: 1,
    condition: 'Near Mint', manualMarketPrice: 95, manualMarketCurrency: 'USD', purchasePrice: 70, fees: 2
  };
  const html = renderPriceIntelligenceDetail({ origin: 'portfolio', item, catalogRef, holding }, baseState({ holdings: [holding] }));
  assert.match(html, /Manual scenario outlook/);
  assert.match(html, /does not apply to catalog-linked items/);
  assert.doesNotMatch(html, /local-scenario-chart/);
  assert.match(html, /No forecast published/);
  assert.doesNotMatch(html, /Approved forecast projection/);
});

test('owned manual/custom card detail still renders a manual scenario when public intelligence is disabled', () => {
  const manualItem = { ...item, provider: 'custom' };
  const catalogRef = catalogReferenceForItem(manualItem, { canonicalVariantId: variantId });
  const holding = {
    id: 'owned-manual', canonicalVariantId: variantId, item: manualItem, quantity: 1,
    condition: 'Near Mint', manualMarketPrice: 95, manualMarketCurrency: 'USD', purchasePrice: 70, fees: 2
  };
  const html = renderPriceIntelligenceDetail({ origin: 'portfolio', item: manualItem, catalogRef, holding }, baseState({ holdings: [holding] }));
  assert.match(html, /Manual scenario outlook/);
  assert.match(html, /Your estimate/);
  assert.match(html, /local-scenario-chart/);
  assert.match(html, /No forecast published/);
  assert.doesNotMatch(html, /Approved forecast projection/);
});

test('tier-4 publication renders observed, trend, fair value, forecast, and drivers separately', () => {
  const catalogRef = catalogReferenceForItem(item, { canonicalVariantId: variantId });
  const state = baseState({
    featureFlags: { watchlists: true, publicPriceIntelligence: true },
    intelligence: { byVariant: { [variantId]: publication({
      observed: { price: 802, currency: 'USD', source: 'Approved source', observedAt: '2026-08-06T00:00:00Z', quality: 0.86 },
      trend: { return30d: 0.182, return90d: 0.241, status: 'strong_rise', volatility: 0.37, confidence: 72 },
      fairValue: { q10: 510, q25: 560, q50: 620, q75: 690, q90: 730, position: 'above_range', confidence: 64 },
      forecasts: { 365: { q10: 540, q25: 720, q50: 845, q75: 990, q90: 1210, probabilityUp: 0.58, confidence: 47, origin: '2026-08-01T00:00:00Z', maturesAt: '2027-08-01T00:00:00Z', modelVersion: 'pokemon_raw_365d_v1.3' } },
      drivers: { supporting: ['Strong character premium'], limiting: ['Current price above structural band'] }
    }, 4) }, loading: false, error: '' }
  });
  const html = renderPriceIntelligenceDetail({ origin: 'portfolio', item, catalogRef }, state);
  assert.match(html, /Forecast available/);
  assert.match(html, /Strong rise/);
  assert.match(html, /Above modeled range/);
  assert.match(html, /365-day outlook/);
  assert.match(html, /Observed price to modeled range/);
  assert.match(html, /Approved forecast projection/);
  assert.match(html, /Observed now/);
  assert.match(html, /Probability of gain/);
  assert.match(html, /Market condition<\/dt><dd>near-mint/);
  assert.match(html, /Strong character premium/);
  assert.match(html, /Current price above structural band/);
  assert.match(html, /never rewritten/);
});

test('tier-2 publication shows trend but explicitly withholds fair value and forecasts', () => {
  const catalogRef = catalogReferenceForItem(item, { canonicalVariantId: variantId });
  const state = baseState({
    featureFlags: { watchlists: true, publicPriceIntelligence: true },
    intelligence: { byVariant: { [variantId]: publication({
      observed: { price: 90, currency: 'USD', source: 'Approved source', observedAt: '2026-08-06T00:00:00Z' },
      history: [
        { price: 85, currency: 'USD', source: 'Approved source', observedAt: '2026-07-06T00:00:00Z', quality: 0.9 },
        { price: 90, currency: 'USD', source: 'Approved source', observedAt: '2026-08-06T00:00:00Z', quality: 0.9 }
      ],
      trend: { return30d: -0.05, status: 'fall', volatility: 0.2, confidence: 55 }
    }, 2) }, loading: false, error: '' }
  });
  const html = renderPriceIntelligenceDetail({ origin: 'portfolio', item, catalogRef }, state);
  assert.match(html, /Fair value not supported/);
  assert.match(html, /No forecast published/);
  assert.doesNotMatch(html, /projection-chart/);
  assert.match(html, /2 final approved price points/);
  assert.match(html, /No recorded driver evidence/);
});

test('home renders no movers or signals chrome when there is no supporting data', () => {
  const html = renderHome(baseState());
  assert.doesNotMatch(html, /Portfolio movers/);
  assert.doesNotMatch(html, /Watchlist signals/);
});

test('portfolio movers ranks by absolute 30-day move and requires trend support', () => {
  const byVariant = {
    [variantId]: publication({ observed: { price: 100, currency: 'USD' }, trend: { return30d: -0.3, status: 'strong_fall' } }, 2),
    '223e4567-e89b-42d3-a456-426614174000': publication({ observed: { price: 50, currency: 'USD' }, trend: { return30d: 0.1, status: 'rise' } }, 2)
  };
  byVariant['223e4567-e89b-42d3-a456-426614174000'].variantId = '223e4567-e89b-42d3-a456-426614174000';
  const holdings = [
    { id: 'h1', canonicalVariantId: variantId, item, condition: 'Near Mint', quantity: 1 },
    { id: 'h2', canonicalVariantId: '223e4567-e89b-42d3-a456-426614174000', item: { ...item, name: 'Pikachu' }, condition: 'Near Mint', quantity: 1 },
    { id: 'h3', canonicalVariantId: '', item: { ...item, name: 'Unmapped' }, quantity: 1 }
  ];
  const movers = portfolioMovers(holdings, byVariant);
  assert.equal(movers.length, 2);
  assert.equal(movers[0].holding.id, 'h1'); // |-30%| beats |+10%|
});

test('watchlist signals lists only unread alerts for still-watched cards', () => {
  const signals = watchlistSignals([
    { id: 'a1', watchKey: 'k1', message: 'Target reached', readAt: '' },
    { id: 'a2', watchKey: 'k1', message: 'Old news', readAt: '2026-08-01T00:00:00Z' },
    { id: 'a3', watchKey: 'gone', message: 'Unwatched', readAt: '' }
  ], [{ watchKey: 'k1' }]);
  assert.deepEqual(signals.map((entry) => entry.id), ['a1']);
});
