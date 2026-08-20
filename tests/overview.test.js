import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewChange, overviewSeries, pricingCoverage, renderHome } from '../app/assets/js/views/home.js';

const marketItem = {
  provider: 'scryfall', externalId: 'market-1', category: 'magic', name: 'Market card',
  setName: 'Test Set', number: '1', variant: 'nonfoil', price: 25,
  currency: 'USD', priceSource: 'Scryfall', priceUpdatedAt: '2026-08-09T00:00:00.000Z'
};

function holding(id, item = marketItem, overrides = {}) {
  return {
    id, item, quantity: 1, purchasePrice: 10, fees: 0, manualMarketPrice: '',
    condition: 'Near Mint', createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides
  };
}

function state(overrides = {}) {
  return {
    holdings: [], snapshots: [], watchlistItems: [], alerts: [], scanDraftCount: 0,
    settings: { currency: 'USD' }, overview: { range: '3M' },
    featureFlags: { watchlists: true, publicPriceIntelligence: false },
    intelligence: { byVariant: {}, loading: false, error: '' },
    ...overrides
  };
}

test('Home starts a truthful single-point series after the first holding', () => {
  const points = overviewSeries([holding('h1')], [], '3M', new Date('2026-08-10T12:00:00.000Z'));
  assert.equal(points.length, 1);
  assert.equal(points[0].date, '2026-08-10');
  assert.equal(points[0].marketValue, 25);
  assert.deepEqual(overviewChange(points), { amount: null, percent: null });
});

test('Home ranges filter real snapshots and calculate selected-range movement', () => {
  const points = overviewSeries([holding('h1')], [
    { id: 'portfolio:2026-07-01', date: '2026-07-01', marketValue: 10, costBasis: 10 },
    { id: 'portfolio:2026-08-05', date: '2026-08-05', marketValue: 20, costBasis: 10 }
  ], '7D', new Date('2026-08-10T12:00:00.000Z'));
  assert.deepEqual(points.map((point) => point.date), ['2026-08-05', '2026-08-10']);
  assert.deepEqual(overviewChange(points), { amount: 5, percent: 25 });
});

test('Home pricing coverage keeps market, manual, and unpriced values distinct', () => {
  const coverage = pricingCoverage([
    holding('market'),
    holding('manual', { provider: 'custom', category: 'other', name: 'Manual item' }, { manualMarketPrice: 12 }),
    holding('unpriced', { provider: 'pokemon', category: 'pokemon', name: 'Restricted item', price: 90, priceSource: 'Pokémon TCG API' })
  ]);
  assert.deepEqual({ ...coverage, percent: Math.round(coverage.percent) }, { market: 1, manual: 1, unpriced: 1, covered: 2, total: 3, percent: 67 });
});

test('Home discloses partial pricing without duplicating Scenario Lab', () => {
  const html = renderHome(state({
    holdings: [holding('market'), holding('manual', { provider: 'custom', category: 'other', name: 'Manual item' }, { manualMarketPrice: 12 })]
  }));
  assert.match(html, /1 market · 1 manual · 0 unpriced/);
  assert.match(html, /<h1>Home<\/h1>/);
  assert.match(html, /<span>Pricing coverage<\/span><strong>100%<\/strong>/);
  assert.doesNotMatch(html, /Scenario coverage|Local 90-day scenarios/);
  assert.equal((html.match(/class="summary-stat"/g) || []).length, 4);
  assert.match(html, /<details class="card data-health">/);
  assert.doesNotMatch(html, /<details class="card data-health" open/);
  assert.match(html, /data-overview-range="3M" aria-pressed="true"/);
  assert.match(html, /Tracking began today/);
});

test('Home never turns an entirely unpriced collection into a zero-dollar value', () => {
  const unpriced = holding('unknown', {
    provider: 'custom', category: 'other', name: 'Unpriced keepsake', price: null,
    currency: 'USD', priceSource: '', priceUpdatedAt: ''
  }, { purchasePrice: '', manualMarketPrice: '' });
  const html = renderHome(state({ holdings: [unpriced] }));
  assert.match(html, /class="overview-value">Value not available</);
  assert.match(html, /0 of 1 items priced/);
  assert.match(html, /1 unpriced item/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test('Home keeps readable refresh status inside collapsed Data Health', () => {
  const html = renderHome(state({
    tcgcsvRefresh: {
      status: 'current',
      sourceUpdatedAt: '2026-08-15T20:05:57.000Z',
      lastSuccessfulSourceBuild: '2026-08-15T20:05:57.000Z',
      lastSuccessfulAt: '2026-08-16T03:30:00.000Z',
      error: ''
    }
  }));
  assert.match(html, /Prices updated recently/);
  assert.match(html, /Last successful refresh:/);
  assert.doesNotMatch(html, /market data build|R2|artifact|runs\//i);
});
