import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWatchlistAlerts, evaluateWatchlistItemAlerts } from '../app/assets/js/core/intelligence-alerts.js';

const variantId = '123e4567-e89b-42d3-a456-426614174000';
const baseEntry = {
  watchKey: `variant:${variantId}`,
  canonicalVariantId: variantId,
  catalogRef: { name: 'Pikachu ex' },
  targetPrice: 95,
  alertPercentChange: 10,
  alertTrendChange: true,
  alertRangeChange: true,
  alertForecastChange: true
};

function publication(price = 100, trend = 'stable', position = 'within_range', median = 110) {
  return {
    variantId,
    supportTier: 4,
    publishedAt: `2026-08-05T${price}:00:00Z`,
    payload: {
      observed: { price, currency: 'USD', source: 'Approved source' },
      trend: { status: trend },
      fairValue: { q10: 80, q25: 90, q50: 100, q75: 110, q90: 120, position },
      forecasts: { 30: { q10: 80, q25: 90, q50: median, q75: 120, q90: 140, probabilityUp: 0.6, modelVersion: 'model-v1' } }
    }
  };
}

test('first approved publication establishes a baseline and fires a reached target once', () => {
  const first = evaluateWatchlistItemAlerts(baseEntry, publication(90), '2026-08-05T00:00:00Z');
  assert.ok(first.baseline.fingerprint);
  assert.deepEqual(first.alerts.map((entry) => entry.kind), ['target_price']);

  const repeated = evaluateWatchlistItemAlerts({ ...baseEntry, intelligenceBaseline: first.baseline }, publication(90), '2026-08-05T01:00:00Z');
  assert.deepEqual(repeated.alerts, []);
  assert.equal(repeated.baseline, first.baseline);
});

test('subsequent approved publications evaluate percent, trend, range, and forecast changes', () => {
  const original = evaluateWatchlistItemAlerts(baseEntry, publication(), '2026-08-05T00:00:00Z');
  const changed = evaluateWatchlistItemAlerts(
    { ...baseEntry, intelligenceBaseline: original.baseline },
    publication(120, 'rise', 'above_range', 115),
    '2026-08-06T00:00:00Z'
  );
  assert.deepEqual(new Set(changed.alerts.map((entry) => entry.kind)), new Set([
    'percent_change', 'trend_change', 'range_change', 'forecast_change'
  ]));
  assert.equal(new Set(changed.alerts.map((entry) => entry.id)).size, 4);
});

test('batch evaluation ignores unmapped items and indexes canonical variants', () => {
  const result = evaluateWatchlistAlerts(
    [baseEntry, { watchKey: 'source:unmapped', canonicalVariantId: '' }],
    { [variantId]: publication(90) },
    '2026-08-05T00:00:00Z'
  );
  assert.equal(result.items.length, 2);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.items[1].intelligenceBaseline, undefined);
});
