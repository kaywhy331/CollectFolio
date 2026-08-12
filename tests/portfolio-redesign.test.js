import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferenceForItem } from '../app/assets/js/core/catalog-identity.js';
import { renderPortfolio } from '../app/assets/js/views/portfolio.js';
import { renderPriceIntelligenceDetail } from '../app/assets/js/views/price-intelligence-detail.js';

const marketItem = {
  provider: 'scryfall', externalId: 'market', category: 'magic', game: 'Magic', name: 'Market Card',
  setName: 'Alpha Set', number: '1', variant: 'foil', language: 'English', rarity: 'Rare',
  image: '', imageSmall: '', price: 20, currency: 'USD', priceSource: 'Scryfall', priceUpdatedAt: '2026-08-09T00:00:00.000Z'
};

const holdings = [
  { id: 'market', item: marketItem, quantity: 2, condition: 'Near Mint', purchasePrice: 5, fees: 0, manualMarketPrice: '', updatedAt: '2026-08-09T00:00:00.000Z' },
  { id: 'manual', item: { provider: 'custom', category: 'sports', name: 'Manual Card', setName: 'Rookie Set', number: '2' }, quantity: 1, condition: 'Graded', gradeCompany: 'PSA', grade: '10', purchasePrice: 8, fees: 1, manualMarketPrice: 30, updatedAt: '2026-08-08T00:00:00.000Z' },
  { id: 'unpriced', item: { provider: 'pokemon', externalId: 'restricted', category: 'pokemon', name: 'Unpriced Card', setName: 'Beta Set', number: '3', variant: 'holofoil', price: 50, priceSource: 'Pokémon TCG API' }, quantity: 1, condition: 'Good', purchasePrice: 4, fees: 0, manualMarketPrice: '', updatedAt: '2026-08-07T00:00:00.000Z' }
];

function state(overrides = {}) {
  return {
    holdings, watchlistItems: [], alerts: [], compare: [],
    settings: { currency: 'USD', portfolioView: 'gallery' },
    portfolio: { section: 'holdings', query: '', category: 'all', sort: 'value-desc', filters: {}, view: 'gallery', selected: [], limit: 100 },
    featureFlags: { watchlists: true, publicPriceIntelligence: false },
    intelligence: { byVariant: {}, loading: false, error: '' },
    ...overrides
  };
}

test('Portfolio presents one cohesive summary and keeps manual and unpriced holdings explicit', () => {
  const html = renderPortfolio(state());
  assert.match(html, /aria-label="Portfolio summary"/);
  assert.match(html, /1 market · 1 manual · 1 unpriced/);
  assert.match(html, /value-source manual">Manual/);
  assert.match(html, /value-source unpriced">Unpriced/);
  assert.match(html, /Alpha Set · #1 · foil · English/);
  assert.match(html, /Current value<\/dt><dd>—<\/dd>/);
  assert.match(html, /Stored provider reference excluded pending licensed source rights/);
});

test('Portfolio combines filters, persists list presentation, and exposes bulk tools only after selection', () => {
  const html = renderPortfolio(state({
    portfolio: { section: 'holdings', query: 'Card', category: 'magic', sort: 'name-asc', filters: { setName: 'Alpha Set', pricing: 'market' }, view: 'list', selected: ['market'], limit: 100 }
  }));
  assert.match(html, /portfolio-holdings list/);
  assert.match(html, /Category: magic/);
  assert.match(html, /Set: Alpha Set/);
  assert.match(html, /Pricing: market/);
  assert.match(html, /aria-label="Bulk holding actions"/);
  assert.match(html, /1 selected/);
  assert.match(html, /bulk-move-holdings/);
  assert.match(html, /bulk-tag-holdings/);
  assert.match(html, /bulk-duplicate-holdings/);
  assert.match(html, /bulk-delete-holdings/);
  assert.doesNotMatch(renderPortfolio(state()), /aria-label="Bulk holding actions"/);
});

test('Full card detail keeps product actions above the fold and technical mapping under Data details', () => {
  const item = { ...marketItem, name: '<script>bad</script>' };
  const catalogRef = catalogReferenceForItem(item);
  const html = renderPriceIntelligenceDetail({ origin: 'portfolio', item, catalogRef, holding: holdings[0] }, state());
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /class="detail-product"/);
  assert.match(html, /Your holding/);
  assert.match(html, /data-action="edit-holding"/);
  assert.match(html, /data-action="toggle-watch"/);
  assert.match(html, /data-action="share-detail"/);
  assert.match(html, /href="#detail-market"/);
  assert.match(html, /<details class="data-details" id="detail-data">/);
  assert.match(html, /Market pricing has not been verified yet/);
});

test('a 1,000-holding portfolio renders a bounded first page', () => {
  const large = Array.from({ length: 1_000 }, (_, index) => ({
    ...holdings[0],
    id: `holding-${String(index).padStart(4, '0')}`,
    item: { ...marketItem, id: `market-${index}`, externalId: `market-${index}`, name: `Market Card ${index}` }
  }));
  const html = renderPortfolio(state({ holdings: large }));
  assert.equal((html.match(/class="portfolio-holding-card /g) || []).length, 100);
  assert.match(html, /1,000 holding|1000 holding/);
  assert.match(html, /data-action="load-more-holdings"/);
  assert.match(html, /Show 100 more/);
});
