import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferenceForItem } from '../app/assets/js/core/catalog-identity.js';
import { renderAdd } from '../app/assets/js/views/add.js';
import { renderQuickInspector } from '../app/assets/js/views/quick-inspector.js';
import { renderSearch } from '../app/assets/js/views/search.js';

const item = {
  provider: 'scryfall', externalId: 'abc', category: 'magic', game: 'Magic',
  name: 'Synthetic Lotus', setName: 'Synthetic Alpha', number: '001', variant: 'foil',
  rarity: 'Rare', language: 'English', image: '', imageSmall: '', price: 125,
  currency: 'USD', priceSource: 'Scryfall', priceUpdatedAt: '2026-08-09T00:00:00.000Z'
};

const forecastVariantId = '123e4567-e89b-42d3-a456-426614174000';
const forecastPublication = {
  variantId: forecastVariantId,
  supportTier: 4,
  publishedAt: '2026-08-14T00:00:00.000Z',
  seriesIdentity: {
    sourceId: 'licensed', currency: 'USD', language: 'en', finish: 'foil',
    conditionClass: 'raw', marketCondition: 'near-mint', priceSemantics: 'market'
  },
  payload: {
    observed: { price: 125, currency: 'USD', source: 'Licensed', observedAt: '2026-08-14T00:00:00.000Z' },
    trend: { return30d: 0.08, status: 'rise', volatility: 0.03, confidence: 80, historyDensity: 0.9 },
    forecasts: {
      30: { q10: 110, q25: 120, q50: 130, q75: 140, q90: 150, probabilityUp: 0.6 },
      90: { q10: 100, q25: 120, q50: 140, q75: 160, q90: 180, probabilityUp: 0.62 },
      180: { q10: 90, q25: 120, q50: 150, q75: 180, q90: 210, probabilityUp: 0.64 },
      365: { q10: 80, q25: 120, q50: 165, q75: 210, q90: 260, probabilityUp: 0.65 }
    }
  }
};

function state(overrides = {}) {
  return {
    holdings: [], watchlistItems: [], alerts: [], scanDraftCount: 0,
    settings: { currency: 'USD', discoverView: 'gallery', recentSearches: [] },
    search: { query: 'Lotus', category: 'magic', provider: 'all', filters: {}, view: 'gallery', loading: false, results: [], warnings: [] },
    featureFlags: { watchlists: true, publicPriceIntelligence: false },
    intelligence: { byVariant: {}, loading: false, error: '' },
    ...overrides
  };
}

test('Discover groups customer-facing match quality without exposing raw percentages', () => {
  const html = renderSearch(state({
    search: {
      query: 'Lotus', category: 'magic', provider: 'all', filters: {}, view: 'gallery', loading: false, warnings: [],
      results: [{ ...item, matchBucket: 'exact', matchScore: 1 }, { ...item, externalId: 'likely', name: 'Likely Lotus', matchBucket: 'likely', matchScore: .91 }]
    }
  }));
  assert.match(html, /Exact matches/);
  assert.match(html, /Likely matches/);
  assert.match(html, /Market price/);
  assert.match(html, /result-list gallery/);
  assert.doesNotMatch(html, /% text match|91%|100%/);
  assert.doesNotMatch(html, />Details</);
});

test('Discover adapts filters and keeps provider choice under Data source', () => {
  const sports = renderSearch(state({ search: { query: '', category: 'sports', provider: 'all', filters: {}, view: 'list', loading: false, results: [], warnings: [] } }));
  assert.match(sports, /Player/);
  assert.match(sports, /Set \/ product/);
  assert.match(sports, /Grade/);
  assert.match(sports, /<summary>Data source<\/summary>/);
  assert.match(sports, /Create custom item/);
});

test('Discover retains a complete result set while rendering large catalogs in bounded batches', () => {
  const results = Array.from({ length: 205 }, (_, index) => ({
    ...item,
    externalId: `printing-${index}`,
    id: `scryfall:printing-${index}`,
    name: `Synthetic Lotus ${index}`
  }));
  const html = renderSearch(state({
    search: {
      query: 'Lotus', category: 'magic', provider: 'scryfall', filters: {}, view: 'gallery',
      limit: 200, loading: false, warnings: [], results
    }
  }));
  assert.match(html, /Showing 200 of 205 results/);
  assert.match(html, /data-action="load-more-results">Show 5 more/);
  assert.match(html, /data-action="show-all-results">Show all 205/);
  assert.equal((html.match(/data-action="open-detail"/g) || []).length, 200);
});

test('Discover browse renders a compact game-to-set index without exposing private sources', () => {
  const html = renderSearch(state({
    discover: {
      mode: 'browse', game: 'pokemon', setId: '', query: '', sort: 'newest', scope: 'all', loading: false, warnings: [], error: '',
      sets: [{ id: 'pokemon:swsh12', externalId: 'swsh12', gameId: 'pokemon', game: 'Pokémon', name: 'Silver Tempest', code: 'SIT', year: '2022', releasedAt: '2022-11-11', cardCount: 195, series: 'Sword & Shield', supplemental: false }],
      products: []
    }
  }));
  assert.match(html, /aria-label="Discover mode"/);
  assert.match(html, /Browse sets/);
  assert.match(html, /data-set-id="swsh12"/);
  assert.match(html, /Silver Tempest/);
  assert.match(html, /SIT · 2022 · 195 cards/);
  assert.match(html, /More games will appear as coverage expands/);
  assert.doesNotMatch(html, /TCGCSV|Data source/);
  assert.doesNotMatch(html, /catalog-search/);
});

test('Discover browse retains a complete set manifest while rendering bounded tiles', () => {
  const sets = Array.from({ length: 121 }, (_, index) => ({
    id: `magic:set-${index}`,
    externalId: `set-${index}`,
    gameId: 'magic',
    game: 'Magic: The Gathering',
    name: `Set ${String(index).padStart(3, '0')}`,
    code: `S${index}`,
    releasedAt: `2025-01-${String((index % 28) + 1).padStart(2, '0')}`,
    year: '2025',
    cardCount: index + 1,
    supplemental: false
  }));
  const html = renderSearch(state({
    discover: { mode: 'browse', game: 'magic', setId: '', query: '', sort: 'alpha', scope: 'all', setLimit: 120, loading: false, warnings: [], error: '', sets, products: [] }
  }));
  assert.match(html, /Showing 120 of 121 sets/);
  assert.match(html, /data-action="load-more-browse-sets">Show 1 more/);
  assert.match(html, /data-action="show-all-browse-sets">Show all 121/);
  assert.equal((html.match(/class="browse-set-tile"/g) || []).length, 120);
});

test('Discover set view renders complete card batches with browse-scoped actions and no SKU claim', () => {
  const products = Array.from({ length: 121 }, (_, index) => ({
    ...item,
    id: `pokemon:card-${index + 1}`,
    externalId: `card-${index + 1}`,
    provider: 'pokemon',
    category: 'pokemon',
    game: 'Pokémon',
    setName: 'Silver Tempest',
    number: String(index + 1),
    name: `Card ${index + 1}`,
    price: null,
    priceOptions: []
  }));
  const html = renderSearch(state({
    discover: {
      mode: 'browse', game: 'pokemon', setId: 'swsh12', query: '', sort: 'newest', scope: 'all', productQuery: '', productSort: 'number', limit: 120, loading: false, warnings: [], error: '',
      selectedSet: { externalId: 'swsh12', gameId: 'pokemon', name: 'Silver Tempest', code: 'SIT', year: '2022' },
      sets: [], products
    }
  }));
  assert.match(html, /121 cards/);
  assert.match(html, /Showing 1 more|Show 1 more/);
  assert.equal((html.match(/data-action="open-detail" data-catalog-scope="browse" data-index=/g) || []).length, 120);
  assert.doesNotMatch(html, /match-badge/);
  assert.doesNotMatch(html, /Near Mint|English SKU|Condition price/);
});

test('Discover shows approved 30-day trend and 1/3/6/12-month estimates on results', () => {
  const forecastItem = {
    ...item,
    canonicalVariantId: forecastVariantId,
    conditionClass: 'raw',
    marketCondition: 'near-mint',
    type: 'Artifact'
  };
  const html = renderSearch(state({
    featureFlags: { watchlists: true, publicPriceIntelligence: true },
    intelligence: { byVariant: { [forecastVariantId]: forecastPublication }, loading: false, error: '' },
    search: {
      query: 'Lotus', category: 'magic', provider: 'all', filters: {},
      view: 'gallery', loading: false, warnings: [], results: [forecastItem]
    }
  }));
  assert.match(html, /Synthetic Alpha · #001 · Artifact · foil · Rare/);
  assert.match(html, /30D trend/);
  assert.match(html, /\+8\.0%/);
  assert.match(html, /1 mo est\./);
  assert.match(html, /3 mo est\./);
  assert.match(html, /6 mo est\./);
  assert.match(html, /1 year est\./);
  assert.match(html, /\$130\.00/);
  assert.match(html, /\$165\.00/);
});

test('Quick Inspector shows exact identity and truthful unavailable states with all required actions', () => {
  const catalogRef = catalogReferenceForItem({ ...item, name: '<script>bad</script>' });
  const html = renderQuickInspector({ origin: 'search', item: { ...item, name: '<script>bad</script>' }, catalogRef }, state());
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /Synthetic Alpha · #001 · foil · english · Rare/i);
  assert.match(html, /No approved outlook published/);
  assert.match(html, /data-action="add-from-detail"/);
  assert.match(html, /data-action="toggle-watch"/);
  assert.match(html, /data-action="open-full-detail"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
});

test('Add begins with one automatic image intake instead of asking single versus multiple', () => {
  const html = renderAdd(state());
  assert.match(html, /Scan or upload cards/);
  assert.match(html, /detects whether it contains one item or several/);
  assert.equal((html.match(/data-action="start-multi-scan"/g) || []).length, 1);
  assert.doesNotMatch(html, /Scan one item|Scan multiple items/);
});
