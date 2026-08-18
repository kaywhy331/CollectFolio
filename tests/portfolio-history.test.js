import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRetroSeriesWithSnapshots, reconstructPortfolioValueSeries } from '../app/assets/js/core/portfolio-history.js';

function holding(overrides = {}) {
  return {
    id: 'h1',
    quantity: 1,
    manualMarketPrice: '',
    item: { currency: 'USD' },
    currency: 'USD',
    purchaseCurrency: 'USD',
    purchasePrice: 0,
    fees: 0,
    ...overrides
  };
}

test('reconstructPortfolioValueSeries weights each week by quantity for a history-backed holding', () => {
  const holdings = [holding({ id: 'a', quantity: 3 })];
  const historyByHoldingId = { a: [['2026-06-06', 10], ['2026-06-13', 12]] };
  const { points, coverage } = reconstructPortfolioValueSeries(holdings, historyByHoldingId, {
    currency: 'USD', now: new Date('2026-06-20T00:00:00.000Z')
  });
  assert.equal(points.length, 2);
  assert.equal(points[0].marketValue, 30); // 10 * 3
  assert.equal(points[1].marketValue, 36); // 12 * 3
  assert.equal(coverage.withHistory, 1);
  assert.equal(coverage.flatOnly, 0);
  assert.equal(coverage.percent, 100);
});

test('reconstructPortfolioValueSeries respects purchaseDate as an acquisition cutoff', () => {
  const holdings = [holding({ id: 'a', quantity: 1, purchaseDate: '2026-06-10' })];
  const historyByHoldingId = { a: [['2026-06-06', 10], ['2026-06-13', 12], ['2026-06-20', 14]] };
  const { points } = reconstructPortfolioValueSeries(holdings, historyByHoldingId, {
    currency: 'USD', now: new Date('2026-06-25T00:00:00.000Z')
  });
  // The 2026-06-06 point predates the purchase date and must not appear
  // as a date this holding contributes to, and its value never counts.
  const dates = points.map((point) => point.date);
  assert.ok(!dates.includes('2026-06-06') || points.find((p) => p.date === '2026-06-06').marketValue === 0);
  const juneThirteen = points.find((point) => point.date === '2026-06-13');
  assert.equal(juneThirteen.marketValue, 12);
});

test('reconstructPortfolioValueSeries falls back to a flat current-value contribution when no history is resolvable', () => {
  const holdings = [holding({ id: 'a', quantity: 2 }), holding({ id: 'b', quantity: 1, manualMarketPrice: 50 })];
  // Only "a" has resolvable history; "b" has none, so it must fall back
  // to a flat contribution using its current market value at every week
  // "a" has an observed date for.
  const historyByHoldingId = { a: [['2026-06-06', 10], ['2026-06-13', 12]] };
  const { points, coverage } = reconstructPortfolioValueSeries(holdings, historyByHoldingId, {
    currency: 'USD', now: new Date('2026-06-20T00:00:00.000Z')
  });
  assert.equal(coverage.withHistory, 1);
  assert.equal(coverage.flatOnly, 1);
  assert.equal(coverage.total, 2);
  assert.equal(coverage.percent, 50);
  // Each week: a's history value (price*2) + b's flat current value (50*1).
  assert.equal(points[0].marketValue, 10 * 2 + 50);
  assert.equal(points[1].marketValue, 12 * 2 + 50);
});

test('reconstructPortfolioValueSeries reports empty coverage with no eligible holdings', () => {
  const result = reconstructPortfolioValueSeries([], {}, { currency: 'USD' });
  assert.deepEqual(result.points, []);
  assert.equal(result.coverage.total, 0);
});

test('reconstructPortfolioValueSeries excludes holdings whose currency does not match the requested one', () => {
  const holdings = [holding({ id: 'a', quantity: 1, item: { currency: 'EUR' }, currency: 'EUR' })];
  const { points, coverage } = reconstructPortfolioValueSeries(holdings, { a: [['2026-06-06', 10]] }, { currency: 'USD' });
  assert.deepEqual(points, []);
  assert.equal(coverage.total, 0);
});

test('mergeRetroSeriesWithSnapshots lets an observed snapshot win over a retro-reconstructed value on the same date', () => {
  const retro = [{ date: '2026-06-06', marketValue: 100, costBasis: 80 }, { date: '2026-06-13', marketValue: 110, costBasis: 80 }];
  const snapshots = [{ date: '2026-06-06', marketValue: 999, costBasis: 80 }];
  const merged = mergeRetroSeriesWithSnapshots(retro, snapshots);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((point) => point.date === '2026-06-06').marketValue, 999);
  assert.equal(merged.find((point) => point.date === '2026-06-13').marketValue, 110);
});

test('mergeRetroSeriesWithSnapshots sorts the merged series by date', () => {
  const merged = mergeRetroSeriesWithSnapshots(
    [{ date: '2026-06-13', marketValue: 1, costBasis: 1 }],
    [{ date: '2026-06-06', marketValue: 2, costBasis: 2 }]
  );
  assert.deepEqual(merged.map((point) => point.date), ['2026-06-06', '2026-06-13']);
});
