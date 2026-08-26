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
    search: { query: 'Lotus', category: 'magic', provider: 'all', filters: {}, view: 'gallery', sort: 'newest', page: 1, limit: 48, loading: false, results: [], warnings: [] },
    featureFlags: { watchlists: true, publicPriceIntelligence: false },
    intelligence: { byVariant: {}, loading: false, error: '' },
    ...overrides
  };
}

test('Discover uses one ungrouped tile grid and trusts extracted/matched identity without confirmation badges', () => {
  // Decision D-5: catalog results ARE the identity -- no grouped exact/likely
  // buckets, no match-confidence badge, every card offers Add unconditionally.
  const html = renderSearch(state({
    search: {
      query: 'Lotus', category: 'magic', provider: 'all', filters: {}, view: 'gallery', loading: false, warnings: [],
      results: [{ ...item, matchBucket: 'exact', matchScore: 1 }, { ...item, externalId: 'likely', name: 'Likely Lotus', matchBucket: 'likely', matchScore: .91 }]
    }
  }));
  assert.doesNotMatch(html, /Exact matches|Likely matches|result-group/);
  assert.match(html, /catalog-tile-grid result-list gallery/);
  assert.doesNotMatch(html, /match-badge/);
  assert.equal((html.match(/class="result-card gallery catalog-tile"/g) || []).length, 2);
  assert.equal((html.match(/data-action="add-catalog"/g) || []).length, 2);
  assert.doesNotMatch(html, /Confirm exact item|review-catalog-identity/);
  assert.doesNotMatch(html, /% text match|91%|100%/);
  assert.doesNotMatch(html, />Details</);
});

test('Discover orders one ungrouped result grid by newest released set by default', () => {
  const html = renderSearch(state({
    search: {
      query: 'Dragon', category: 'magic', provider: 'tcgcsv', filters: {}, view: 'gallery', loading: false, warnings: [],
      results: [
        { ...item, id: 'old', externalId: 'old', name: 'Old Dragon', setName: 'Old Set', releasedAt: '2021-01-01', year: '2021' },
        { ...item, id: 'new', externalId: 'new', name: 'New Dragon', setName: 'New Set', releasedAt: '2026-06-12', year: '2026' },
        { ...item, id: 'mid', externalId: 'mid', name: 'Middle Dragon', setName: 'Middle Set', releasedAt: '2024-03-08', year: '2024' }
      ]
    }
  }));
  assert.match(html, /value="newest" selected>Newest release/);
  assert.ok(html.indexOf('New Dragon') < html.indexOf('Middle Dragon'));
  assert.ok(html.indexOf('Middle Dragon') < html.indexOf('Old Dragon'));
  assert.doesNotMatch(html, /result-group/);
});

test('Discover adapts category filters and keeps custom-item creation', () => {
  const sports = renderSearch(state({ discover: { mode: 'search', searchFiltersOpen: true }, search: { query: '', category: 'sports', provider: 'all', filters: {}, view: 'list', loading: false, results: [], warnings: [] } }));
  assert.match(sports, /Player/);
  assert.match(sports, /Set \/ product/);
  assert.match(sports, /Grade/);
  // DCL-DISC-09: the "Data source" control and its explanation are removed
  // from the filter panel entirely (Decision D-4).
  assert.doesNotMatch(sports, /Data source/);
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
      page: 1, limit: 48, loading: false, warnings: [], results
    }
  }));
  assert.match(html, /Showing 1–48 of 205 results/);
  assert.match(html, /Page 1 of 5/);
  assert.match(html, /data-action="search-results-page" data-page="2"/);
  assert.doesNotMatch(html, /load-more-results|show-all-results/);
  assert.equal((html.match(/data-action="open-detail"/g) || []).length, 48);

  const lastPage = renderSearch(state({
    search: { query: 'Lotus', category: 'magic', provider: 'scryfall', filters: {}, view: 'gallery', page: 5, limit: 48, loading: false, warnings: [], results }
  }));
  assert.match(lastPage, /Showing 193–205 of 205 results/);
  assert.equal((lastPage.match(/data-action="open-detail"/g) || []).length, 13);
});

test('Discover keeps a 5,000-item catalog interaction bounded to the visible 48-tile page', () => {
  const results = Array.from({ length: 5_000 }, (_, index) => ({
    ...item,
    externalId: `scale-${index}`,
    id: `scryfall:scale-${index}`,
    name: `Scale Card ${String(index).padStart(4, '0')}`
  }));
  const started = performance.now();
  const html = renderSearch(state({
    search: {
      query: 'Scale', category: 'magic', provider: 'tcgcsv', filters: {}, view: 'gallery',
      page: 1, limit: 48, loading: false, warnings: [], results
    }
  }));
  const duration = performance.now() - started;
  assert.equal((html.match(/data-action="open-detail"/g) || []).length, 48);
  assert.match(html, /Showing 1–48 of 5,000 results/);
  assert.match(html, /Page 1 of 105/);
  assert.ok(duration < 1_000, `bounded 5,000-item render took ${duration.toFixed(1)}ms`);
});

test('Discover defers set rendering until a game is selected and keeps the complete category directory in its picker', () => {
  const browseState = {
    mode: 'browse', game: 'all', setId: '', query: '', sort: 'newest', scope: 'all', loading: false, warnings: [], error: '',
    sets: [{ id: 'pokemon:swsh12', externalId: 'swsh12', gameId: 'pokemon', game: 'Pokémon', name: 'Silver Tempest', code: 'SIT', year: '2022', releasedAt: '2022-11-11', cardCount: 195, series: 'Sword & Shield', supplemental: false }],
    products: []
  };
  const html = renderSearch(state({
    discover: {
      ...browseState
    }
  }));
  assert.match(html, /aria-label="Discover mode"/);
  assert.match(html, /Browse sets/);
  assert.doesNotMatch(html, /data-set-id="swsh12"/);
  assert.doesNotMatch(html, /Silver Tempest/);
  assert.match(html, /Popular games/);
  assert.match(html, /data-action="open-category-picker">View All/);
  assert.equal((html.match(/class="discover-category-tile"/g) || []).length, 3);
  assert.equal((html.match(/data-game-search-text=/g) || []).length, 0);
  assert.doesNotMatch(html, /class="category-picker"/);

  const picker = renderSearch(state({ discover: { ...browseState, categoryPickerOpen: true } }));
  assert.match(picker, /class="category-picker" role="dialog" aria-modal="true"/);
  assert.match(picker, /All games and categories/);
  assert.equal((picker.match(/data-game-search-text=/g) || []).length, 90);
  assert.equal((html.match(/data-catalog-locked="true"/g) || []).length, 0);
  assert.match(picker, /data-game="pokemon"/);
  assert.match(picker, /data-game="magic"/);
  assert.match(picker, /data-game="yugioh"/);
  assert.match(picker, /data-game="tcgcsv-category-23"[^>]*>[\s\S]*?Dragon Ball Z TCG/);
  assert.match(picker, /data-game="tcgcsv-category-68"[^>]*>[\s\S]*?One Piece Card Game/);
  assert.match(picker, /data-game="tcgcsv-category-90"[^>]*>[\s\S]*?CookieRun: Braverse TCG/);
  assert.doesNotMatch(html, /Data source/);
  assert.doesNotMatch(html, /catalog-search/);

  const drilled = renderSearch(state({
    discover: {
      mode: 'browse', game: 'pokemon', setId: '', query: '', sort: 'newest', scope: 'all', loading: false, warnings: [], error: '',
      sets: [{ id: 'pokemon:swsh12', externalId: 'swsh12', gameId: 'pokemon', game: 'Pokémon', name: 'Silver Tempest', code: 'SIT', year: '2022', releasedAt: '2022-11-11', cardCount: 195, series: 'Sword & Shield', supplemental: false }],
      products: []
    }
  }));
  assert.match(drilled, /class="browse-breadcrumbs"/);
  assert.match(drilled, /data-action="browse-all-games">Discover</);
  assert.match(drilled, /<h2>Pokémon<\/h2>/);
  // DCL-NAV-04: the separate "All games" button is removed -- the
  // breadcrumb's "Discover" crumb (asserted above) is the sole upward nav.
  assert.doesNotMatch(drilled, />All games</);
  assert.doesNotMatch(drilled, /class="category-picker"/);
  assert.equal((drilled.match(/data-game-search-text=/g) || []).length, 0);
  assert.match(drilled, /data-set-id="swsh12"/);

  const priorLocation = globalThis.location;
  globalThis.location = { href: 'https://collectfolio.example/' };
  const flat = renderSearch(state({
    discover: {
      mode: 'browse', game: 'magic', setId: '', query: '', sort: 'newest', scope: 'all', groupBy: 'family', loading: false, warnings: [], error: '',
      setCovers: { 'magic:cmm': 'https://cards.scryfall.io/cmm-cover.jpg' },
      sets: [
        { id: 'magic:fdn', externalId: 'fdn', gameId: 'magic', game: 'Magic: The Gathering', name: 'Foundations', releasedAt: '2024-11-15', year: '2024', supplemental: false, image: 'https://svgs.scryfall.io/sets/fdn.svg' },
        { id: 'magic:cmm', externalId: 'cmm', gameId: 'magic', game: 'Magic: The Gathering', name: 'Commander Masters', releasedAt: '2023-08-04', year: '2023', supplemental: true },
        { id: 'magic:c21', externalId: 'c21', gameId: 'magic', game: 'Magic: The Gathering', name: 'Commander 2021', releasedAt: '2021-04-23', year: '2021', supplemental: true, image: 'https://svgs.scryfall.io/sets/c21.svg' }
      ],
      products: []
    }
  }));
  assert.doesNotMatch(flat, /browse-set-group|data-browse-set-group/);
  assert.equal((flat.match(/class="browse-set-tile"/g) || []).length, 3);
  assert.ok(flat.indexOf('Foundations') < flat.indexOf('Commander Masters'));
  assert.ok(flat.indexOf('Commander Masters') < flat.indexOf('Commander 2021'));
  assert.match(flat, /https:\/\/cards\.scryfall\.io\/cmm-cover\.jpg/);
  assert.match(flat, /https:\/\/svgs\.scryfall\.io\/sets\/fdn\.svg/);
  if (priorLocation === undefined) delete globalThis.location;
  else globalThis.location = priorLocation;
});

test('Discover maps TCGCSV categories to their source game titles in browse and search', () => {
  const games = [
    { id: 'tcgcsv-category-3', name: 'Pokemon', shortName: 'Pokemon', provider: 'tcgcsv', categoryId: 3 },
    { id: 'tcgcsv-category-68', name: 'One Piece Card Game', shortName: 'One Piece Card Game', provider: 'tcgcsv', categoryId: 68 }
  ];
  const browse = renderSearch(state({
    auth: { session: { access_token: 'personal-test' } },
    discover: {
      mode: 'browse', game: 'tcgcsv-category-68', games, setId: '', query: '', sort: 'newest', scope: 'all', loading: false, warnings: [], error: '',
      sets: [{ id: 'tcgcsv:68:1000', externalId: '68:1000', gameId: 'tcgcsv-category-68', game: 'One Piece Card Game', name: 'Romance Dawn', code: 'OP-01', cardCount: 154, supplemental: false }],
      products: []
    }
  }));
  assert.match(browse, /class="browse-breadcrumbs"/);
  assert.match(browse, /<h2>One Piece Card Game<\/h2>/);
  assert.match(browse, /Catalog category/);
  assert.doesNotMatch(browse, /TCGCSV category 68/);
  // DCL-NAV-04: the separate "All games" button is removed -- the
  // breadcrumb's "Discover" crumb is the sole upward nav.
  assert.match(browse, /data-action="browse-all-games">Discover</);
  assert.doesNotMatch(browse, />All games</);
  assert.doesNotMatch(browse, /All games and categories/);
  assert.equal((browse.match(/data-game-search-text=/g) || []).length, 0);
  assert.match(browse, /One Piece Card Game[\s\S]*Romance Dawn/);
  assert.doesNotMatch(browse, /Full catalog|Full TCGCSV catalog/);

  const search = renderSearch(state({
    auth: { session: { access_token: 'personal-test' } },
    discover: { mode: 'search', games, searchFiltersOpen: true },
    search: {
      query: 'Luffy', category: 'tcgcsv-category-68', provider: 'tcgcsv', filters: {}, view: 'gallery', loading: false, warnings: [],
      results: [{ ...item, provider: 'tcgcsv', externalId: '68:1000:2000', category: 'tcgcsv-category-68', game: 'One Piece Card Game', name: 'Monkey.D.Luffy' }]
    }
  }));
  assert.match(search, /<optgroup label="More games and categories \(87\)">/);
  assert.match(search, /value="tcgcsv-category-68" selected>One Piece Card Game/);
  assert.match(search, /class="catalog-tile-grid result-list gallery"/);
  assert.match(search, /Monkey\.D\.Luffy/);
  assert.doesNotMatch(search, /Full catalog|Full TCGCSV catalog/);

  const signedOutSearch = renderSearch(state({
    discover: { mode: 'search' },
    search: { query: 'Luffy', category: 'tcgcsv-category-68', provider: 'tcgcsv', filters: {}, view: 'gallery', loading: false, warnings: [], results: [] }
  }));
  assert.match(signedOutSearch, /data-filter="category">One Piece Card Game/);
  assert.doesNotMatch(signedOutSearch, /sign in/i);
  assert.doesNotMatch(signedOutSearch, /catalog-auth-gate/);
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
    discover: { mode: 'browse', game: 'magic', setId: '', query: '', sort: 'alpha', scope: 'all', setPage: 1, setLimit: 48, loading: false, warnings: [], error: '', sets, products: [] }
  }));
  assert.match(html, /Showing 1–48 of 121 sets/);
  assert.match(html, /Page 1 of 3/);
  assert.match(html, /data-action="browse-sets-page" data-page="2"/);
  assert.doesNotMatch(html, /load-more-browse-sets|show-all-browse-sets/);
  assert.equal((html.match(/class="browse-set-tile"/g) || []).length, 48);
});

test('Discover set view renders a maximum of 48 shared tiles with full titles and no forecast disclaimer', () => {
  const longTitle = 'Card 24 — A Very Long Complete Product Title With Every Collector Detail Preserved';
  const products = Array.from({ length: 121 }, (_, index) => ({
    ...item,
    id: `pokemon:card-${index + 1}`,
    externalId: `card-${index + 1}`,
    provider: 'pokemon',
    category: 'pokemon',
    game: 'Pokémon',
    setName: 'Silver Tempest',
    number: String(index + 1),
    name: index === 23 ? longTitle : `Card ${index + 1}`,
    price: null,
    priceOptions: []
  }));
  const html = renderSearch(state({
    discover: {
      mode: 'browse', game: 'pokemon', setId: 'swsh12', query: '', sort: 'newest', scope: 'all', productQuery: '', productSort: 'number', productKind: 'all', productPage: 1, limit: 48, productTotal: 121, productNextCursor: '48', loading: false, warnings: [], error: '',
      selectedSet: { externalId: 'swsh12', gameId: 'pokemon', name: 'Silver Tempest', code: 'SIT', year: '2022' },
      sets: [], products
    }
  }));
  assert.match(html, /121 cards/);
  assert.match(html, /Page 1 of 3/);
  assert.match(html, /data-action="browse-products-page" data-page="2"/);
  assert.equal((html.match(/data-action="open-detail" data-catalog-scope="browse" data-index=/g) || []).length, 48);
  assert.match(html, new RegExp(`<h3>${longTitle}</h3>`));
  assert.match(html, /catalog-tile-grid result-list gallery browse-product-grid/);
  assert.match(html, /result-card gallery catalog-tile/);
  assert.doesNotMatch(html, /result-outlook-note|Cold start estimate|Early estimate|Treat as wider/);
  assert.doesNotMatch(html, /match-badge/);
  assert.doesNotMatch(html, /Near Mint|English SKU|Condition price/);
});

test('Discover set cards retain concise forecast values without forecast disclaimer copy', () => {
  const forecastItem = {
    ...item,
    id: 'magic:forecast-card',
    canonicalVariantId: forecastVariantId,
    conditionClass: 'raw',
    marketCondition: 'near-mint',
    productKind: 'card'
  };
  const html = renderSearch(state({
    featureFlags: { watchlists: true, publicPriceIntelligence: true },
    intelligence: { byVariant: { [forecastVariantId]: forecastPublication }, loading: false, error: '' },
    discover: {
      mode: 'browse', game: 'magic', setId: 'alpha', productQuery: '', productSort: 'number', productKind: 'all', productPage: 1, limit: 48,
      productTotal: 1, productNextCursor: '', loading: false, warnings: [], error: '',
      selectedSet: { externalId: 'alpha', gameId: 'magic', name: 'Synthetic Alpha' },
      sets: [], products: [forecastItem]
    }
  }));
  // DCL-DISC-02: the outlook <dl> (all horizons) is deleted from result
  // cards entirely -- forecast estimates no longer render on gallery tiles.
  assert.doesNotMatch(html, /1 mo est\.|3 mo est\.|6 mo est\.|1 year est\.|30D trend|modeled|result-outlook-note|Treat as wider/);
});

test('Discover uses the same concise forecast tile template as set products', () => {
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
  assert.match(html, /Synthetic Alpha · #001 · foil · Rare/);
  // DCL-DISC-02: result cards no longer carry any forecast estimate --
  // "model baseline" is also an Appendix-C banned phrase.
  assert.doesNotMatch(html, /1 mo est\.|3 mo est\.|\$130\.00|\$140\.00|vs model baseline/);
  assert.doesNotMatch(html, /30D trend|6 mo est\.|1 year est\.|result-outlook-note/);
});

test('Discover withholds a trajectory whose published baseline is stale', () => {
  const trajectoryItem = {
    ...item,
    provider: 'tcgcsv', externalId: '3:100:5001', category: 'tcgcsv-category-3',
    categoryId: 3, groupId: 100, productId: 5001, variant: 'Holofoil',
    pricingEntitlement: 'community-free-access'
  };
  const packet = {
    productId: 5001, subTypeName: 'Holofoil', modelVersion: 'trajectory-v1', confidence: 'standard',
    lastKnownDate: '2026-01-01', lastKnownPrice: 100, medianPath: [],
    horizons: { 30: { q10: 80, q25: 90, q50: 105, q75: 120, q90: 140 } }
  };
  const html = renderSearch(state({
    search: { query: 'Lotus', category: 'pokemon', provider: 'tcgcsv', filters: {}, view: 'gallery', loading: false, warnings: [], results: [trajectoryItem] },
    trajectoryForecasts: {
      byKey: { '3:100:5001:Holofoil': { eligibility: 'published', packet, manifest: { asOf: '2026-08-10' } } },
      loading: false, error: ''
    }
  }));
  assert.doesNotMatch(html, /1 mo est\.|result-market-outlook/);
});

test('Discover landing limits recognizable categories and keeps the universal search primary', () => {
  const html = renderSearch(state({
    search: { query: '', category: 'all', provider: 'all', filters: {}, view: 'gallery', loading: false, results: [], warnings: [] },
    discover: { mode: 'search', games: [], sets: [], products: [] }
  }));
  // DCL-DISC-05: search placeholder shortened to "Search the catalog".
  assert.match(html, /placeholder="Search the catalog"/);
  assert.match(html, /Popular games/);
  assert.equal((html.match(/class="discover-category-tile"/g) || []).length, 3);
  assert.match(html, /data-action="open-category-picker">View All/);
  assert.doesNotMatch(html, /class="category-picker"/);
  assert.doesNotMatch(html, /Find an exact printing/);
});

test('Discover exposes removable filter chips and only supported result sorting', () => {
  const html = renderSearch(state({
    search: {
      query: 'Lotus', category: 'magic', provider: 'all', filters: { setName: 'Alpha', year: '2026' },
      view: 'gallery', sort: 'price-desc', loading: false, warnings: [],
      results: [{ ...item, price: null, priceSource: '', priceUpdatedAt: '' }]
    }
  }));
  assert.match(html, /Filters <span>3<\/span>/);
  assert.match(html, /data-filter="category">Magic: The Gathering/);
  assert.match(html, /data-filter="setName">Set or series: Alpha/);
  assert.match(html, /data-filter="year">Year: 2026/);
  assert.match(html, /data-action="clear-search-filters">Clear all/);
  assert.doesNotMatch(html, /value="price-desc"/);
  // DCL-DISC-08: the "Price sorting is unavailable…" notice is deleted;
  // the hidden option needs no explanation.
  assert.doesNotMatch(html, /Price sorting is unavailable/);
  assert.doesNotMatch(html, /result-market-outlook/);
});

test('Discover never enables or applies price sorting to rights-suppressed provider values', () => {
  const restricted = [
    { ...item, externalId: 'low', name: 'First restricted result', provider: 'pokemon', category: 'pokemon', price: 5, priceSource: 'Pokémon TCG API' },
    { ...item, externalId: 'high', name: 'Second restricted result', provider: 'pokemon', category: 'pokemon', price: 500, priceSource: 'Pokémon TCG API' }
  ];
  const html = renderSearch(state({
    search: {
      query: 'restricted', category: 'pokemon', provider: 'all', filters: {},
      view: 'gallery', sort: 'price-desc', loading: false, warnings: [], results: restricted
    }
  }));
  assert.doesNotMatch(html, /value="price-desc"/);
  // DCL-DISC-08: the "Price sorting is unavailable…" notice is deleted.
  assert.doesNotMatch(html, /Price sorting is unavailable/);
  assert.ok(html.indexOf('First restricted result') < html.indexOf('Second restricted result'));
  assert.equal((html.match(/Pricing not supported/g) || []).length, 2);
});

test('Discover renders related sealed formats as independent tiles without family buckets', () => {
  const products = [
    ['pack', 'Strike of Illusionary Shadows Booster Pack', 5],
    ['box', 'Strike of Illusionary Shadows Booster Box', 90],
    ['case', 'Strike of Illusionary Shadows 16-Box Case', 1200]
  ].map(([id, name, price]) => ({
    ...item, id, externalId: id, provider: 'tcgcsv', category: 'tcgcsv-category-1', game: 'Magic',
    name, number: '', rarity: '', productKind: 'sealed', price
  }));
  const html = renderSearch(state({
    discover: {
      mode: 'browse', game: 'magic', setId: '1:42', productKind: 'sealed', productSort: 'name',
      selectedSet: { externalId: '1:42', gameId: 'magic', name: 'Strike of Illusionary Shadows', year: '2026' },
      sets: [], products, loading: false, warnings: [], error: ''
    }
  }));
  assert.doesNotMatch(html, /Product family|product-family/);
  assert.equal((html.match(/class="result-card gallery catalog-tile"/g) || []).length, 3);
  assert.match(html, /product-format-badge">Booster pack/);
  assert.match(html, /product-format-badge">Booster box/);
  assert.match(html, /product-format-badge">Case/);
});

test('Quick Inspector trusts extracted identity without confirmation, hides empty metrics, shows the catalog crumb, and is a non-modal panel supporting both detents', () => {
  // Decision D-5: there is no "confirm exact item" step left anywhere --
  // Add/Watch are always available the instant the panel opens.
  const catalogRef = catalogReferenceForItem({ ...item, name: '<script>bad</script>' });
  const html = renderQuickInspector({ origin: 'search', item: { ...item, name: '<script>bad</script>' }, catalogRef }, state());
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /Synthetic Alpha · #001 · foil · english · Rare/i);
  assert.doesNotMatch(html, /match-badge|>No match</);
  assert.doesNotMatch(html, /confirm-detail-identity|Confirm exact item/);
  assert.doesNotMatch(html, /No approved outlook published/);
  // Directive 3: the game/set catalog breadcrumb renders inside the panel.
  assert.match(html, /<nav class="catalog-crumb" aria-label="Catalog path">/);
  assert.match(html, /data-action="add-from-detail">Add to collection/);
  assert.match(html, /data-action="toggle-watch" data-detail-watch="true"/);
  assert.match(html, /data-action="open-full-detail"/);
  // Directive 2: a real side panel, not a modal dialog -- no aria-modal,
  // no focus trap semantics baked into the markup.
  assert.match(html, /role="complementary" aria-labelledby="quick-inspector-title"/);
  assert.doesNotMatch(html, /role="dialog"|aria-modal/);
  assert.match(html, /data-sheet-detent="medium"/);

  const expanded = renderQuickInspector({ origin: 'search', item, catalogRef, detent: 'expanded' }, state());
  assert.match(expanded, /data-action="add-from-detail">Add to collection/);
  assert.match(expanded, /data-action="toggle-watch"/);
  assert.match(expanded, /data-sheet-detent="expanded"/);
});

test('Scan separates camera and upload, previews the workflow, and keeps import copy terse', () => {
  const html = renderAdd(state());
  assert.match(html, /<h1>Scan<\/h1>/);
  assert.match(html, /Open Camera/);
  assert.match(html, /Upload Photo/);
  assert.match(html, /Scan or upload[\s\S]*Review detected items[\s\S]*Confirm and add/);
  assert.match(html, /data-scan-dropzone/);
  // DCL-SCAN-01: hero prose collapses to one line ("Drop or paste an image
  // anywhere."); the older "drop an image here or paste one" restatement
  // and the separate capture-help paragraph are both gone.
  assert.match(html, /Drop or paste an image anywhere\./);
  assert.doesNotMatch(html, /drop an image here or paste one/);
  assert.match(html, /Import collection/);
  // DCL-SCAN-09: import card copy no longer gives Settings directions.
  assert.match(html, /Merge a CollectFolio backup file\./);
  assert.doesNotMatch(html, /Export is available in Settings under Data &amp; Backups/);
  assert.doesNotMatch(html, /Settings → Data &amp; Backups/);
  assert.doesNotMatch(html, /data-action="export-json"/);
  assert.doesNotMatch(html, /data-action="start-multi-scan"/);
  // DCL-SCAN-02: the full privacy text now lives once, inside the shared
  // "How photos are handled" disclosure.
  assert.match(html, /full source photo never leaves this browser and is never saved/i);
});

test('Scan exposes each saved draft with independent resume and discard controls', () => {
  const html = renderAdd(state({
    scanDraftCount: 2,
    scanDrafts: [
      { id: 'draft-a', updatedAt: '2026-08-20T12:00:00.000Z', crops: [{ id: 'a' }] },
      { id: 'draft-b', updatedAt: '2026-08-19T12:00:00.000Z', crops: [{ id: 'b' }, { id: 'c' }] }
    ]
  }));
  assert.equal((html.match(/data-action="resume-scan"/g) || []).length, 2);
  assert.equal((html.match(/data-action="discard-scan"/g) || []).length, 2);
  assert.match(html, /data-draft-id="draft-a"/);
  assert.match(html, /1 cropped item/);
  assert.match(html, /2 cropped items/);
});
