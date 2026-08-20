import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterAndSortHoldings, holdingCostBasis, holdingGain, holdingMarketValue,
  portfolioSnapshotId, portfolioSummary, snapshotFor, unitMarketValue
} from '../app/assets/js/core/calculations.js';
import { PRICING_POLICY_VERSION } from '../app/assets/js/core/pricing-policy.js';

const holding = (overrides = {}) => ({
  id: overrides.id || 'one',
  item: { name: overrides.name || 'Card', category: overrides.category || 'pokemon', price: overrides.price ?? 12, currency: overrides.currency || 'USD' },
  quantity: overrides.quantity ?? 2,
  purchasePrice: overrides.purchasePrice ?? 7,
  purchaseCurrency: overrides.purchaseCurrency || overrides.currency || 'USD',
  fees: overrides.fees ?? 3,
  manualMarketPrice: overrides.manualMarketPrice ?? '',
  manualMarketCurrency: overrides.manualMarketCurrency || overrides.currency || 'USD',
  updatedAt: overrides.updatedAt || '2026-01-01T00:00:00.000Z'
});

test('valuation separates provider price, manual override, quantity, and fees', () => {
  const provider = holding();
  assert.equal(unitMarketValue(provider), 12);
  assert.equal(holdingMarketValue(provider), 24);
  assert.equal(holdingCostBasis(provider), 17);
  const manual = holding({ manualMarketPrice: 20 });
  assert.equal(unitMarketValue(manual), 20);
  assert.equal(manual.item.price, 12);
  assert.equal(holdingMarketValue(manual), 40);
});

test('legacy unlicensed Pokémon prices do not enter valuation, while manual values still do', () => {
  const restricted = holding();
  restricted.item.provider = 'pokemon';
  restricted.item.priceSource = 'Pokémon TCG API · TCGplayer market';
  assert.equal(unitMarketValue(restricted), 0);
  assert.equal(holdingMarketValue(restricted), 0);
  restricted.manualMarketPrice = 18;
  assert.equal(unitMarketValue(restricted), 18);
  assert.equal(holdingMarketValue(restricted), 36);
});

test('portfolio summary uses exact cost and gain rules', () => {
  const summary = portfolioSummary([holding(), holding({ id: 'two', price: 5, quantity: 1, purchasePrice: 10, fees: 0 })]);
  assert.deepEqual({ market: summary.marketValue, cost: summary.costBasis, gain: summary.gain, quantity: summary.totalQuantity }, { market: 29, cost: 27, gain: 2, quantity: 3 });
  assert.ok(Math.abs(summary.returnPercent - 7.407407) < 0.001);
});

test('gain remains unavailable until both an accepted value and cost basis exist', () => {
  const noPrice = holding({ id: 'no-price', purchasePrice: 10, fees: 0 });
  noPrice.item.price = null;
  const noCost = holding({ id: 'no-cost', price: 20, purchasePrice: '', fees: '' });
  assert.equal(holdingGain(noPrice), null);
  assert.equal(holdingGain(noCost), null);
  const summary = portfolioSummary([noPrice, noCost]);
  assert.equal(summary.gainEligibleItems, 0);
  assert.equal(summary.missingGainItems, 2);
  assert.equal(summary.returnPercent, null);
});

test('holdings filter and sort by value, gain, name, and recency', () => {
  const rows = [holding({ id: 'b', name: 'Beta', price: 8 }), holding({ id: 'a', name: 'Alpha', price: 20, category: 'magic', updatedAt: '2026-02-01T00:00:00.000Z' })];
  assert.deepEqual(filterAndSortHoldings(rows, { sort: 'value-desc' }).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(filterAndSortHoldings(rows, { sort: 'name-asc' }).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(filterAndSortHoldings(rows, { category: 'magic' }).map((row) => row.id), ['a']);
  assert.deepEqual(filterAndSortHoldings(rows, { query: 'bet' }).map((row) => row.id), ['b']);
});

test('holdings combine collection filters and expanded sorting without hiding unpriced records', () => {
  const rows = [
    holding({ id: 'graded', name: 'Alpha', category: 'magic', price: 20, purchasePrice: 10 }),
    holding({ id: 'manual', name: 'Beta', category: 'magic', manualMarketPrice: 5, purchasePrice: 10 }),
    holding({ id: 'unpriced', name: 'Gamma', category: 'pokemon', purchasePrice: 2 })
  ];
  rows[1].item.price = null;
  rows[2].item.price = null;
  rows[0].gradeCompany = 'PSA';
  rows[0].grade = '10';
  rows[0].item.setName = 'Alpha Set';
  rows[1].item.setName = 'Beta Set';
  assert.deepEqual(filterAndSortHoldings(rows, { filters: { ownership: 'graded' } }).map((row) => row.id), ['graded']);
  assert.deepEqual(filterAndSortHoldings(rows, { filters: { pricing: 'manual' } }).map((row) => row.id), ['manual']);
  assert.deepEqual(filterAndSortHoldings(rows, { filters: { pricing: 'unpriced' } }).map((row) => row.id), ['unpriced']);
  assert.deepEqual(filterAndSortHoldings(rows, { filters: { setName: 'beta' } }).map((row) => row.id), ['manual']);
  rows[2].item.setName = 'Beta Set 2';
  assert.deepEqual(filterAndSortHoldings(rows, { filters: { setName: 'Beta Set', setNameExact: true } }).map((row) => row.id), ['manual']);
  assert.deepEqual(filterAndSortHoldings(rows, { sort: 'gain-asc' }).map((row) => row.id), ['manual', 'graded', 'unpriced']);
});

test('daily snapshots use stable currency-qualified portfolio IDs', () => {
  const snapshot = snapshotFor([holding()], new Date('2026-07-31T12:00:00.000Z'));
  assert.equal(snapshot.id, 'portfolio:USD:2026-07-31');
  assert.equal(portfolioSnapshotId('2026-07-31', 'cad'), 'portfolio:CAD:2026-07-31');
  assert.equal(snapshotFor([holding()], new Date('2026-07-31T12:00:00.000Z'), { currency: 'CAD' }).id, 'portfolio:CAD:2026-07-31');
  assert.equal(snapshot.pricingPolicyVersion, PRICING_POLICY_VERSION);
  assert.equal(snapshot.currency, 'USD');
  assert.equal(snapshot.marketValue, 24);
  assert.equal(snapshot.costBasis, 17);
});

test('portfolio totals exclude other currencies instead of relabeling or guessing FX', () => {
  const usd = holding({ id: 'usd', price: 12, quantity: 1, purchasePrice: 7, fees: 0 });
  const eur = holding({ id: 'eur', currency: 'EUR', price: 20, quantity: 1, purchasePrice: 10, fees: 0 });
  const mixed = holding({ id: 'mixed', currency: 'EUR', purchaseCurrency: 'USD', price: 30, quantity: 1, purchasePrice: 5, fees: 0 });
  const summary = portfolioSummary([usd, eur, mixed], { currency: 'USD' });
  assert.equal(summary.marketValue, 12);
  assert.equal(summary.costBasis, 12);
  assert.equal(summary.gain, 5);
  assert.equal(summary.excludedMarketItems, 2);
  assert.equal(summary.excludedCostItems, 1);
  assert.equal(summary.excludedGainItems, 2);
  assert.deepEqual(summary.excludedCurrencies, ['EUR']);
  assert.equal(holdingGain(mixed), null);
  assert.deepEqual(filterAndSortHoldings([eur, usd], { currency: 'USD', sort: 'value-desc' }).map((entry) => entry.id), ['usd', 'eur']);
});
