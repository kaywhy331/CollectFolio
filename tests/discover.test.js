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
  const sports = renderSearch(state({ discover: { mode: 'search', searchFiltersOpen: true }, search: { query: '', category: 'sports', provider: 'all', filters: {}, view: 'list', loading: false, results: [], warnings: [] } }));
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
  assert.doesNotMatch(html, /show-all-results/);
  assert.equal((html.match(/data-action="open-detail"/g) || []).length, 200);
});

test('Discover keeps a 5,000-item catalog interaction bounded to the visible 200-card page', () => {
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
      limit: 200, loading: false, warnings: [], results
    }
  }));
  const duration = performance.now() - started;
  assert.equal((html.match(/data-action="open-detail"/g) || []).length, 200);
  assert.match(html, /Showing 200 of 5,000 results/);
  assert.match(html, /Show 200 more/);
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
  assert.match(drilled, /data-action="browse-all-games">All games</);
  assert.doesNotMatch(drilled, /class="category-picker"/);
  assert.equal((drilled.match(/data-game-search-text=/g) || []).length, 0);
  assert.match(drilled, /data-set-id="swsh12"/);

  const priorLocation = globalThis.location;
  globalThis.location = { href: 'https://collectfolio.example/' };
  const grouped = renderSearch(state({
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
  assert.match(grouped, /class="browse-set-group"/);
  // Commander group header uses the most recent Commander set's cover.
  assert.match(grouped, /<summary><img class="browse-set-group-art" src="https:\/\/cards\.scryfall\.io\/cmm-cover\.jpg"[^>]*><strong>Commander<\/strong>/);
  // Main expansions header falls back to the set's own provider image.
  assert.match(grouped, /<summary><img class="browse-set-group-art" src="https:\/\/svgs\.scryfall\.io\/sets\/fdn\.svg"[^>]*><strong>Main expansions<\/strong>/);
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
  assert.match(browse, /data-action="browse-all-games">All games</);
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
  assert.match(search, /class="result-facts"><span>One Piece Card Game<\/span>/);
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
    discover: { mode: 'browse', game: 'magic', setId: '', query: '', sort: 'alpha', scope: 'all', setLimit: 24, loading: false, warnings: [], error: '', sets, products: [] }
  }));
  assert.match(html, /Showing 24 of 121 sets/);
  assert.match(html, /data-action="load-more-browse-sets">Show 24 more/);
  assert.doesNotMatch(html, /show-all-browse-sets/);
  assert.equal((html.match(/class="browse-set-tile"/g) || []).length, 24);
});

test('Discover set view renders compact 24-card batches with full titles and no forecast disclaimer', () => {
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
      mode: 'browse', game: 'pokemon', setId: 'swsh12', query: '', sort: 'newest', scope: 'all', productQuery: '', productSort: 'number', limit: 24, productTotal: 121, productNextCursor: '24', loading: false, warnings: [], error: '',
      selectedSet: { externalId: 'swsh12', gameId: 'pokemon', name: 'Silver Tempest', code: 'SIT', year: '2022' },
      sets: [], products
    }
  }));
  assert.match(html, /121 cards/);
  assert.match(html, /Load 24 more/);
  assert.equal((html.match(/data-action="open-detail" data-catalog-scope="browse" data-index=/g) || []).length, 24);
  assert.match(html, new RegExp(`<h3>${longTitle}</h3>`));
  assert.match(html, /result-card gallery browse-compact/);
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
      mode: 'browse', game: 'magic', setId: 'alpha', productQuery: '', productSort: 'number', limit: 24,
      productTotal: 1, productNextCursor: '', loading: false, warnings: [], error: '',
      selectedSet: { externalId: 'alpha', gameId: 'magic', name: 'Synthetic Alpha' },
      sets: [], products: [forecastItem]
    }
  }));
  assert.match(html, /1 mo est\./);
  assert.match(html, /3 mo est\./);
  assert.doesNotMatch(html, /6 mo est\.|1 year est\.|30D trend|modeled|result-outlook-note|Treat as wider/);
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

test('Discover landing limits recognizable categories and keeps the universal search primary', () => {
  const html = renderSearch(state({
    search: { query: '', category: 'all', provider: 'all', filters: {}, view: 'gallery', loading: false, results: [], warnings: [] },
    discover: { mode: 'search', games: [], sets: [], products: [] }
  }));
  assert.match(html, /placeholder="Search cards, sets, players, products, or set codes"/);
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
  assert.match(html, /Price sorting is unavailable/);
  assert.doesNotMatch(html, /result-market-outlook/);
});

test('Discover groups related sealed formats into a named product family', () => {
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
  assert.match(html, /Product family/);
  assert.match(html, /<h3[^>]*>Strike of Illusionary Shadows<\/h3>/);
  assert.match(html, />3 formats</);
  assert.match(html, /product-format-badge">Booster pack/);
  assert.match(html, /product-format-badge">Booster box/);
  assert.match(html, /product-format-badge">Case/);
});

test('Quick Inspector requires identity confirmation, hides empty metrics, and supports both mobile detents', () => {
  const catalogRef = catalogReferenceForItem({ ...item, name: '<script>bad</script>' });
  const html = renderQuickInspector({ origin: 'search', item: { ...item, name: '<script>bad</script>' }, catalogRef }, state());
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /Synthetic Alpha · #001 · foil · english · Rare/i);
  assert.match(html, /Identity unresolved/);
  assert.match(html, /data-action="confirm-detail-identity">Confirm exact item/);
  assert.doesNotMatch(html, /No approved outlook published/);
  assert.doesNotMatch(html, /data-action="add-from-detail"/);
  assert.doesNotMatch(html, /data-action="toggle-watch"/);
  assert.match(html, /data-action="open-full-detail"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /data-sheet-detent="medium"/);

  const confirmed = renderQuickInspector({ origin: 'search', item, catalogRef, identityConfirmed: true, detent: 'expanded' }, state());
  assert.match(confirmed, /confirmed by you/i);
  assert.match(confirmed, /data-action="add-from-detail"/);
  assert.match(confirmed, /data-action="toggle-watch"/);
  assert.match(confirmed, /data-sheet-detent="expanded"/);
});

test('Scan separates camera and upload, previews the workflow, and keeps export in Settings', () => {
  const html = renderAdd(state());
  assert.match(html, /<h1>Scan<\/h1>/);
  assert.match(html, /Open Camera/);
  assert.match(html, /Upload Photo/);
  assert.match(html, /Scan or upload[\s\S]*Review detected items[\s\S]*Confirm and add/);
  assert.match(html, /data-scan-dropzone/);
  assert.match(html, /drop an image here or paste one/);
  assert.match(html, /Import collection/);
  assert.doesNotMatch(html, /data-action="export-json"/);
  assert.doesNotMatch(html, /data-action="start-multi-scan"/);
});
