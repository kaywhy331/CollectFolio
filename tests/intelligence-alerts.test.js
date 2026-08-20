import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWatchlistAlerts, evaluateWatchlistItemAlerts } from '../app/assets/js/core/intelligence-alerts.js';

const variantId = '123e4567-e89b-42d3-a456-426614174000';
const baseEntry = {
  watchKey: `variant:${variantId}`,
  canonicalVariantId: variantId,
  catalogRef: { name: 'Pikachu ex', language: 'en', finish: 'holofoil', conditionClass: 'raw', currency: 'USD' },
  marketCondition: 'near-mint',
  targetPrice: 95,
  targetCurrency: 'USD',
  alertPercentChange: 10,
  alertTrendChange: true,
  alertRangeChange: true,
  alertForecastChange: true
};

function publication(price = 100, trend = 'stable', position = 'within_range', median = 110, currency = 'USD') {
  return {
    variantId,
    seriesIdentity: { sourceId: 'approved', currency, language: 'en', finish: 'holofoil', conditionClass: 'raw', marketCondition: 'near-mint', priceSemantics: 'market' },
    supportTier: 4,
    publishedAt: `2026-08-05T${price}:00:00Z`,
    payload: {
      observed: { price, currency, source: 'Approved source' },
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

test('target alerts do not compare unlike currencies', () => {
  const result = evaluateWatchlistItemAlerts({ ...baseEntry, targetCurrency: 'EUR' }, publication(90), '2026-08-05T00:00:00Z');
  assert.deepEqual(result.alerts, []);
  assert.equal(result.baseline.currency, 'USD');
});

test('publication currency mismatches leave the exact-series baseline unchanged', () => {
  const original = evaluateWatchlistItemAlerts(baseEntry, publication(100), '2026-08-05T00:00:00Z');
  const corrected = evaluateWatchlistItemAlerts(
    { ...baseEntry, intelligenceBaseline: original.baseline },
    publication(90, 'stable', 'within_range', 110, 'CAD'),
    '2026-08-06T00:00:00Z'
  );
  assert.equal(corrected.baseline, original.baseline);
  assert.equal(corrected.baseline.currency, 'USD');
  assert.deepEqual(corrected.alerts, []);
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

test('catalog price availability transitions create plain price alerts', () => {
  const unpriced = publication();
  unpriced.payload.observed.price = null;
  const original = evaluateWatchlistItemAlerts(baseEntry, unpriced, '2026-08-05T00:00:00Z');
  assert.deepEqual(original.alerts, []);

  const newlyPriced = evaluateWatchlistItemAlerts(
    { ...baseEntry, intelligenceBaseline: original.baseline },
    publication(100),
    '2026-08-06T00:00:00Z'
  );
  assert.deepEqual(newlyPriced.alerts.map((entry) => entry.kind), ['new_catalog_price']);

  const missingAgain = publication();
  missingAgain.payload.observed.price = null;
  missingAgain.publishedAt = '2026-08-07T00:00:00Z';
  const becameUnpriced = evaluateWatchlistItemAlerts(
    { ...baseEntry, intelligenceBaseline: newlyPriced.baseline },
    missingAgain,
    '2026-08-07T00:00:00Z'
  );
  assert.deepEqual(becameUnpriced.alerts.map((entry) => entry.kind), ['became_unpriced']);
});

test('an approved price creates one stale transition when its expiry passes', () => {
  const expiring = { ...publication(100), expiresAt: '2026-08-10T00:00:00Z' };
  const fresh = evaluateWatchlistItemAlerts(baseEntry, expiring, '2026-08-09T00:00:00Z');
  assert.equal(fresh.baseline.stale, false);

  const stale = evaluateWatchlistItemAlerts(
    { ...baseEntry, intelligenceBaseline: fresh.baseline },
    expiring,
    '2026-08-11T00:00:00Z'
  );
  assert.equal(stale.baseline.stale, true);
  assert.deepEqual(stale.alerts.map((entry) => entry.kind), ['price_stale']);

  const repeated = evaluateWatchlistItemAlerts(
    { ...baseEntry, intelligenceBaseline: stale.baseline },
    expiring,
    '2026-08-12T00:00:00Z'
  );
  assert.deepEqual(repeated.alerts, []);
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
