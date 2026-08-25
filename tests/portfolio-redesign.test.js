import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferenceForItem } from '../app/assets/js/core/catalog-identity.js';
import { groupMatchingHoldings, renderPortfolio } from '../app/assets/js/views/portfolio.js';
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
    holdings, snapshots: [], priceHistory: { byKey: {} }, watchlistItems: [], alerts: [], compare: [],
    settings: { currency: 'USD', portfolioView: 'gallery' },
    portfolio: { section: 'holdings', query: '', category: 'all', sort: 'value-desc', filters: {}, view: 'gallery', selected: [], limit: 100 },
    featureFlags: { watchlists: true, publicPriceIntelligence: false },
    intelligence: { byVariant: {}, loading: false, error: '' },
    ...overrides
  };
}

test('Collection presents one compact truthful summary and keeps manual and unpriced items explicit', () => {
  const html = renderPortfolio(state());
  assert.match(html, /aria-label="Collection summary"/);
  // DCL-COLL-01: the summary compresses to a one-line strip -- value ·
  // item count · coverage % -- so the breakdown prefix is gone.
  assert.match(html, /<dt>Pricing coverage<\/dt><dd>67%<\/dd>/);
  // DCL-COLL-01: the aggregate market/manual/unpriced breakdown is
  // deleted from the summary strip; each source stays explicit per-card.
  assert.doesNotMatch(html, /1 market · 1 manual · 1 unpriced/);
  assert.match(html, /value-source manual">Manual/);
  assert.match(html, /value-source unpriced">Unpriced/);
  assert.match(html, /Alpha Set · #1 · foil · English/);
  assert.match(html, /Current value<\/dt><dd>Unpriced<\/dd>/);
  assert.match(html, /Saved market reference is not included until source rights are approved/);
  assert.doesNotMatch(html, /portfolio-value-trend|Value trend/);
  assert.doesNotMatch(html, /class="holding-select"/);
  assert.match(html, /class="collection-overflow"/);
  assert.match(html, /data-action="export-csv"/);
});

test('Collection never represents unknown value or cost as zero', () => {
  const onlyUnpriced = {
    ...holdings[2], purchasePrice: '', fees: '', manualMarketPrice: '',
    item: { ...holdings[2].item, price: null }
  };
  const html = renderPortfolio(state({
    holdings: [onlyUnpriced],
    portfolio: { ...state().portfolio, groupMode: 'purchases' }
  }));
  assert.match(html, /Value not available/);
  assert.match(html, /<dt>Pricing coverage<\/dt><dd>0%<\/dd>/);
  assert.match(html, /Current value<\/dt><dd>Unpriced<\/dd>/);
  assert.match(html, /Cost basis<\/dt><dd>Not recorded<\/dd>/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test('Collection combines filters, persists list presentation, and exposes bulk tools only in selection mode', () => {
  const html = renderPortfolio(state({
    portfolio: { section: 'holdings', query: 'Card', category: 'magic', sort: 'name-asc', filters: { setName: 'Alpha Set', pricing: 'market' }, view: 'list', groupMode: 'purchases', selectionMode: true, selected: ['market'], limit: 100 }
  }));
  assert.match(html, /portfolio-holdings list/);
  assert.match(html, /Category: Magic/);
  assert.match(html, /Set: Alpha Set/);
  assert.match(html, /Pricing: market/);
  assert.match(html, /aria-label="Bulk purchase actions"/);
  assert.match(html, /1 selected/);
  assert.match(html, /bulk-move-holdings/);
  assert.match(html, /bulk-tag-holdings/);
  assert.match(html, /bulk-duplicate-holdings/);
  assert.match(html, /bulk-delete-holdings/);
  assert.doesNotMatch(renderPortfolio(state()), /aria-label="Bulk purchase actions"/);
});

test('matching collection items can be grouped without losing individual purchase totals', () => {
  const secondPurchase = { ...holdings[0], id: 'market-second', quantity: 3, purchasePrice: 7 };
  const groups = groupMatchingHoldings([...holdings, secondPurchase], 'USD');
  const marketGroup = groups.find((group) => group.item.externalId === 'market');
  assert.equal(marketGroup.holdings.length, 2);
  assert.equal(marketGroup.quantity, 5);
  const grouped = renderPortfolio(state({ holdings: [...holdings, secondPurchase] }));
  assert.match(grouped, /4 purchases grouped by matching item/);
  assert.match(grouped, /Qty 5/);
  assert.match(grouped, /2 purchases/);
  assert.match(grouped, /data-action="show-individual-purchases"/);
  const purchases = renderPortfolio(state({ holdings: [...holdings, secondPurchase], portfolio: { ...state().portfolio, groupMode: 'purchases' } }));
  assert.match(purchases, /Showing individual purchases/);
  assert.equal((purchases.match(/class="portfolio-holding-card /g) || []).length, 4);
});

test('Collection shows a sparkline only after two valid dated value observations', () => {
  assert.doesNotMatch(renderPortfolio(state()), /class="collection-sparkline"/);
  const html = renderPortfolio(state({ snapshots: [
    { id: 'portfolio:USD:2026-08-01', date: '2026-08-01', currency: 'USD', marketValue: 60, costBasis: 20 }
  ] }));
  assert.match(html, /class="collection-sparkline"/);
  assert.match(html, /role="img"/);
});

test('empty Collection offers every supported intake route', () => {
  const html = renderPortfolio(state({ holdings: [] }));
  for (const copy of ['>Scan<', '>Search<', '>Import<', '>Custom item<']) assert.match(html, new RegExp(copy));
});

test('Full item detail keeps ownership actions sticky and technical mapping under Data & Methodology', () => {
  const item = { ...marketItem, name: '<script>bad</script>' };
  const catalogRef = catalogReferenceForItem(item);
  const html = renderPriceIntelligenceDetail({ origin: 'portfolio', item, catalogRef, holding: holdings[0] }, state());
  assert.doesNotMatch(html, /<script>bad<\/script>/);
  assert.match(html, /class="detail-product"/);
  assert.match(html, /Your collection/);
  assert.match(html, /data-action="edit-holding"/);
  assert.match(html, /class="detail-action-bar"/);
  assert.match(html, /Update quantity/);
  assert.match(html, /View purchases/);
  assert.match(html, /data-action="toggle-watch"/);
  assert.match(html, /data-action="share-detail"/);
  assert.match(html, /href="#detail-market"/);
  assert.match(html, /<details class="data-details" id="detail-data"><summary><span>Data &amp; Methodology/);
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
  assert.match(html, /1,000 items|1000 items/);
  assert.match(html, /data-action="load-more-holdings"/);
  assert.match(html, /Show 100 more/);
});

test('Portfolio Sets groups local printings without inventing catalog completion', () => {
  const samePrintingSecondLot = {
    ...holdings[0], id: 'market-lot-2', quantity: 3,
    item: { ...marketItem }, updatedAt: '2026-08-10T00:00:00.000Z'
  };
  const html = renderPortfolio(state({
    holdings: [...holdings, samePrintingSecondLot],
    portfolio: {
      ...state().portfolio,
      section: 'sets', setQuery: '', setCategory: 'all', setSort: 'recent-desc', setLimit: 60
    }
  }));
  assert.match(html, /aria-label="Set collection summary"/);
  assert.match(html, /<dt>Named sets<\/dt><dd>3<\/dd>/);
  assert.match(html, /Alpha Set/);
  assert.match(html, /1 distinct printing · 5 copies across 2 purchases/);
  // DCL-COLL-03/Appendix C: the banned "Catalog total not linked…" fine
  // print is deleted from the per-card and section governance copy.
  assert.doesNotMatch(html, /Catalog total not linked/);
  assert.match(html, /data-action="view-set-holdings"/);
  assert.doesNotMatch(html, /\d+% complete/i);
  assert.match(html, /data-portfolio-section="sets"/);
});

test('Portfolio retains TCGCSV game titles in holding and set category controls', () => {
  const tcgcsvHolding = {
    ...holdings[0],
    id: 'one-piece',
    item: {
      ...marketItem,
      provider: 'tcgcsv',
      externalId: '68:1000:2000',
      category: 'tcgcsv-category-68',
      game: 'One Piece Card Game',
      name: 'Monkey.D.Luffy',
      setName: 'Romance Dawn'
    }
  };
  const holdingHtml = renderPortfolio(state({
    holdings: [tcgcsvHolding],
    portfolio: { ...state().portfolio, category: 'tcgcsv-category-68' }
  }));
  assert.match(holdingHtml, /value="tcgcsv-category-68" selected>One Piece Card Game/);
  assert.match(holdingHtml, /Category: One Piece Card Game/);
  assert.match(holdingHtml, /One Piece Card Game · Romance Dawn/);

  const setHtml = renderPortfolio(state({
    holdings: [tcgcsvHolding],
    portfolio: { ...state().portfolio, section: 'sets', setCategory: 'tcgcsv-category-68' }
  }));
  assert.match(setHtml, /value="tcgcsv-category-68" selected>One Piece Card Game/);
  assert.match(setHtml, /<p class="eyebrow">One Piece Card Game<\/p>/);
});

test('Portfolio Sets retains every local group while bounding the first render', () => {
  const large = Array.from({ length: 1_000 }, (_, index) => ({
    ...holdings[0],
    id: `set-holding-${index}`,
    item: {
      ...marketItem,
      id: `set-card-${index}`,
      externalId: `set-card-${index}`,
      name: `Card ${index}`,
      setName: `Set ${String(index).padStart(4, '0')}`
    }
  }));
  const html = renderPortfolio(state({
    holdings: large,
    portfolio: { ...state().portfolio, section: 'sets', setLimit: 60 }
  }));
  assert.equal((html.match(/class="portfolio-set-card"/g) || []).length, 60);
  assert.match(html, /<strong>1000 sets<\/strong>|<strong>1,000 sets<\/strong>/);
  assert.match(html, /data-action="load-more-portfolio-sets"/);
  assert.match(html, /Show 60 more/);
});
