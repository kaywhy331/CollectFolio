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
