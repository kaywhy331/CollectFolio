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

const tcgcsvItem = {
  provider: 'tcgcsv', externalId: '3:604:97847', category: 'tcgcsv-category-3', game: 'Pokemon',
  name: 'Charizard ex', setName: 'Obsidian Flames', number: '223', variant: 'Holofoil', language: 'en', marketCondition: 'near-mint',
  rarity: 'Special Illustration Rare', image: '', imageSmall: '', price: 90, currency: 'USD',
  categoryId: 3, groupId: 604, productId: 97847,
  priceOptions: [
    { finish: 'Holofoil', price: 90, source: 'TCGCSV community catalog · market', selectedField: 'marketPrice', marketPrice: 90, midPrice: 85, lowPrice: 60, highPrice: 140, directLowPrice: 58 },
    { finish: 'Normal', price: 4.5, source: 'TCGCSV community catalog · market', selectedField: 'marketPrice', marketPrice: 4.5, midPrice: 4, lowPrice: 2, highPrice: 9, directLowPrice: 1.8 }
  ],
  extendedData: [
    { name: 'Number', displayName: 'Number', value: '223/197' },
    { name: 'Rarity', displayName: 'Rarity', value: 'Special Illustration Rare' },
    { name: 'Stage', displayName: 'Stage', value: 'Stage 2' },
    { name: 'HP', displayName: 'HP', value: '330' },
    { name: 'CardText', displayName: 'Attack 1', value: '<script>alert(1)</script> Deals 330 damage.' }
  ],
  tcgcsvGroup: { name: 'Obsidian Flames', groupId: 604 },
  tcgcsvCategory: { displayName: 'Pokemon', categoryId: 3 }
};

test('detail view without a selection offers a way back instead of crashing', () => {
  const html = renderPriceIntelligenceDetail(null, baseState());
  assert.match(html, /No item selected/);
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
  assert.doesNotMatch(html, /Your collection/);
  assert.match(html, /Condition<\/dt><dd>Unconfirmed/);
});

test('item detail prioritizes price, uses direct image zoom, and keeps methodology collapsed', () => {
  const pictured = { ...item, image: 'https://images.example/card.webp', priceSource: 'Licensed source', priceUpdatedAt: '2026-08-19T00:00:00.000Z' };
  const catalogRef = catalogReferenceForItem(pictured);
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: pictured, catalogRef }, baseState());
  assert.match(html, /class="detail-image-frame" type="button" data-action="zoom-detail-image"/);
  assert.doesNotMatch(html, />Zoom image</);
  assert.ok(html.indexOf('Current value') < html.indexOf('<dl class="detail-metadata">'));
  assert.match(html, /Price history will appear after additional verified updates/);
  assert.match(html, /<details class="data-details" id="detail-data">/);
  assert.doesNotMatch(html, /<details class="data-details" id="detail-data" open/);
});

test('item detail preserves a long title and labels missing identity fields without invented metadata', () => {
  const name = 'A Deliberately Long Collector Edition Product Title With Multiple Descriptors and a Numbered Anniversary Treatment';
  const sparse = { ...item, name, language: '', marketCondition: '', variant: '', rarity: '' };
  const catalogRef = catalogReferenceForItem(sparse, { marketCondition: '' });
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: sparse, catalogRef }, baseState());
  assert.match(html, new RegExp(name));
  assert.match(html, /Condition<\/dt><dd>Unconfirmed/);
  assert.match(html, /Language<\/dt><dd>Not specified/);
  assert.match(html, /Variant not specified/);
});

test('sealed item metadata names its product format and never labels it Raw', () => {
  const sealed = { ...item, name: 'DZ-BT15 Booster Pack', productFormat: 'booster pack', conditionClass: 'sealed', edition: 'standard', language: 'English', setName: 'DZ-BT15' };
  const catalogRef = catalogReferenceForItem(sealed, { conditionClass: 'sealed' });
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: sealed, catalogRef }, baseState());
  assert.match(html, /Type<\/dt><dd>Sealed product/);
  assert.match(html, /Format<\/dt><dd>Booster Pack/);
  assert.match(html, /Condition<\/dt><dd>Unconfirmed/);
  assert.doesNotMatch(html, />Raw</);
});

test('detail price-history chart requires two distinct valid observations', () => {
  const catalogRef = catalogReferenceForItem(tcgcsvItem);
  const key = '3:604:97847:Holofoil';
  const one = renderPriceIntelligenceDetail({ origin: 'search', item: tcgcsvItem, catalogRef }, baseState({
    priceHistory: { byKey: { [key]: { available: true, points: [['2026-08-01', 90]] } } }
  }));
  assert.doesNotMatch(one, /history-line-chart/);
  assert.match(one, /Price history will appear after additional verified updates/);
  const two = renderPriceIntelligenceDetail({ origin: 'search', item: tcgcsvItem, catalogRef }, baseState({
    priceHistory: { byKey: { [key]: { available: true, points: [['2026-08-01', 90], ['2026-08-08', 95]] } } }
  }));
  assert.match(two, /history-line-chart/);
  assert.doesNotMatch(two, /Price history will appear after additional verified updates/);
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
  assert.match(html, /<p class="eyebrow">Your scenario<\/p>/);
  assert.match(html, /catalog item uses published outlooks when enough evidence is available/);
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
  assert.match(html, /<p class="eyebrow">Your scenario<\/p>/);
  assert.match(html, /Your estimate/);
  assert.match(html, /local-scenario-chart/);
  assert.match(html, /No forecast published/);
  assert.doesNotMatch(html, /Approved forecast projection/);
});

test('trajectory-v1 90d-only serving mode (cat 1/2 standard) renders only the horizons the T5 gate actually served', () => {
  // forecast-display-everywhere: publish_category now strips a packet's
  // horizons object down to only the (category, cohort) horizons the T4
  // holdout gate served (see forecast_publisher.eligible_horizons /
  // NINETY_DAY_ONLY_OVERRIDE) -- here the packet legitimately carries only
  // "90". The app must render only the 90-day outlook, never fabricate a
  // 30-day block that was never published.
  const tcgcsvItem = { ...item, provider: 'tcgcsv', categoryId: 1, groupId: 42, productId: 777, variant: 'Holofoil' };
  const catalogRef = catalogReferenceForItem(tcgcsvItem, { canonicalVariantId: variantId });
  const packet = {
    modelVersion: 'trajectory-v1', confidence: 'standard', lastKnownDate: '2026-08-01', lastKnownPrice: 90,
    horizons: { 90: { q10: 70, q25: 80, q50: 95, q75: 105, q90: 120 } },
    medianPath: [{ date: '2026-08-01', price: 90 }, { date: '2026-08-31', price: 95 }]
  };
  const state = baseState({
    trajectoryForecasts: {
      byKey: { '1:42:777:Holofoil': { eligibility: 'published', packet, manifest: { asOf: '2026-08-01' } } },
      loading: false, error: ''
    }
  });
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: tcgcsvItem, catalogRef }, state);
  assert.match(html, /90-day outlook/);
  assert.doesNotMatch(html, /30-day outlook/);
  assert.match(html, /Modeled trajectory/);
});

test('trajectory-v1 excluded/unknown packet still shows the honest insufficient-evidence state, not a fabricated horizon', () => {
  const tcgcsvItem = { ...item, provider: 'tcgcsv', categoryId: 85, groupId: 9, productId: 111, variant: 'Normal' };
  const catalogRef = catalogReferenceForItem(tcgcsvItem, { canonicalVariantId: variantId });
  const state = baseState({
    trajectoryForecasts: {
      byKey: { '85:9:111:Normal': { eligibility: 'excluded', packet: null } },
      loading: false, error: ''
    }
  });
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: tcgcsvItem, catalogRef }, state);
  assert.match(html, /Insufficient evidence for a price forecast/);
  assert.doesNotMatch(html, /90-day outlook/);
  assert.doesNotMatch(html, /30-day outlook/);
});

test('trajectory-v1 withholds values whose price baseline is stale at publication time', () => {
  const tcgcsvItem = { ...item, provider: 'tcgcsv', categoryId: 3, groupId: 42, productId: 777, variant: 'Holofoil' };
  const catalogRef = catalogReferenceForItem(tcgcsvItem, { canonicalVariantId: variantId });
  const packet = {
    modelVersion: 'trajectory-v1', confidence: 'standard', lastKnownDate: '2026-01-01', lastKnownPrice: 90,
    horizons: { 30: { q10: 70, q25: 80, q50: 95, q75: 105, q90: 120 } }, medianPath: []
  };
  const state = baseState({
    trajectoryForecasts: {
      byKey: { '3:42:777:Holofoil': { eligibility: 'published', packet, manifest: { asOf: '2026-08-10' } } },
      loading: false, error: ''
    }
  });
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: tcgcsvItem, catalogRef }, state);
  assert.match(html, /A fresher market observation is required/);
  assert.doesNotMatch(html, /30-day outlook|\$95\.00/);
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
  assert.match(html, /Condition<\/dt><dd>near-mint/);
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

test('B4: full TCGCSV attributes section stays collapsed by default and omits already-curated fields', () => {
  const catalogRef = catalogReferenceForItem(tcgcsvItem);
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: tcgcsvItem, catalogRef }, baseState());
  assert.match(html, /id="detail-attributes"/);
  assert.doesNotMatch(html, /<details class="data-details" id="detail-attributes" open/);
  assert.match(html, /All attributes/);
  // "Number" and "Rarity" are already surfaced by the curated header/metadata
  // UI, so the visibility config keeps them out of the collapsible section.
  const attributesSection = html.slice(html.indexOf('id="detail-attributes"'));
  assert.doesNotMatch(attributesSection, /<dt>Number<\/dt>/);
  assert.doesNotMatch(attributesSection, /<dt>Rarity<\/dt>/);
});

test('B4: attributes not in the curated visibility config render (in DOM, collapsed) with markup escaped', () => {
  const catalogRef = catalogReferenceForItem(tcgcsvItem);
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: tcgcsvItem, catalogRef }, baseState());
  assert.match(html, /<dt>Stage<\/dt><dd>Stage 2<\/dd>/);
  assert.match(html, /<dt>HP<\/dt><dd>330<\/dd>/);
  // Markup-ish extendedData value must be escaped, never rendered as live HTML.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('B4: all price subtypes and fields (market/mid/low/high/directLow) are surfaced per finish', () => {
  const catalogRef = catalogReferenceForItem(tcgcsvItem);
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: tcgcsvItem, catalogRef }, baseState());
  assert.match(html, /Holofoil.*Market/);
  assert.match(html, /Holofoil.*Direct low/);
  assert.match(html, /Normal.*Market/);
  assert.match(html, /Normal.*Direct low/);
});

test('B4: group/category identity (categoryId/groupId/productId, category + set names) is surfaced', () => {
  const catalogRef = catalogReferenceForItem(tcgcsvItem);
  const html = renderPriceIntelligenceDetail({ origin: 'search', item: tcgcsvItem, catalogRef }, baseState());
  assert.match(html, /<dt>Category ID<\/dt><dd>3<\/dd>/);
  assert.match(html, /<dt>Group ID<\/dt><dd>604<\/dd>/);
  assert.match(html, /<dt>Product ID<\/dt><dd>97847<\/dd>/);
  assert.match(html, /<dt>Category<\/dt><dd>Pokemon<\/dd>/);
  assert.match(html, /<dt>Set \/ group<\/dt><dd>Obsidian Flames<\/dd>/);
});

test('B4: non-TCGCSV items (secondary providers) do not render the all-attributes section', () => {
  const catalogRef = catalogReferenceForItem(item, { canonicalVariantId: variantId });
  const html = renderPriceIntelligenceDetail({ origin: 'search', item, catalogRef }, baseState());
  assert.doesNotMatch(html, /id="detail-attributes"/);
  assert.doesNotMatch(html, /All attributes/);
});
