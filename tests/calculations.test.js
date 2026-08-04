import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterAndSortHoldings, holdingCostBasis, holdingMarketValue,
  portfolioSummary, snapshotFor, unitMarketValue
} from '../app/assets/js/core/calculations.js';

const holding = (overrides = {}) => ({
  id: overrides.id || 'one',
  item: { name: overrides.name || 'Card', category: overrides.category || 'pokemon', price: overrides.price ?? 12 },
  quantity: overrides.quantity ?? 2,
  purchasePrice: overrides.purchasePrice ?? 7,
  fees: overrides.fees ?? 3,
  manualMarketPrice: overrides.manualMarketPrice ?? '',
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

test('portfolio summary uses exact cost and gain rules', () => {
  const summary = portfolioSummary([holding(), holding({ id: 'two', price: 5, quantity: 1, purchasePrice: 10, fees: 0 })]);
  assert.deepEqual({ market: summary.marketValue, cost: summary.costBasis, gain: summary.gain, quantity: summary.totalQuantity }, { market: 29, cost: 27, gain: 2, quantity: 3 });
  assert.ok(Math.abs(summary.returnPercent - 7.407407) < 0.001);
});

test('holdings filter and sort by value, gain, name, and recency', () => {
  const rows = [holding({ id: 'b', name: 'Beta', price: 8 }), holding({ id: 'a', name: 'Alpha', price: 20, category: 'magic', updatedAt: '2026-02-01T00:00:00.000Z' })];
  assert.deepEqual(filterAndSortHoldings(rows, { sort: 'value-desc' }).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(filterAndSortHoldings(rows, { sort: 'name-asc' }).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(filterAndSortHoldings(rows, { category: 'magic' }).map((row) => row.id), ['a']);
  assert.deepEqual(filterAndSortHoldings(rows, { query: 'bet' }).map((row) => row.id), ['b']);
});

test('daily snapshot uses a stable replaceable portfolio ID', () => {
  const snapshot = snapshotFor([holding()], new Date('2026-07-31T12:00:00.000Z'));
  assert.equal(snapshot.id, 'portfolio:2026-07-31');
  assert.equal(snapshot.marketValue, 24);
  assert.equal(snapshot.costBasis, 17);
});
