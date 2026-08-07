import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntelligencePayload, trendLabel } from '../app/assets/js/core/intelligence-contract.js';

const publication = {
  variantId: '123e4567-e89b-42d3-a456-426614174000', supportTier: 4,
  payload: {
    observed: { price: 100, currency: 'usd', source: 'Approved', quality: 0.9 },
    trend: { return30d: 0.15, status: 'rise', confidence: 72 },
    fairValue: { q10: 80, q25: 90, q50: 100, q75: 110, q90: 120, position: 'within_range', confidence: 65 },
    forecasts: { 30: { q10: 75, q25: 90, q50: 105, q75: 120, q90: 140, probabilityUp: 0.6, confidence: 58 } }
  }
};

test('intelligence contract retains valid observed, trend, fair-value, and forecast values', () => {
  const value = normalizeIntelligencePayload(publication);
  assert.equal(value.observed.currency, 'USD');
  assert.equal(value.trend.return30d, 0.15);
  assert.equal(value.fairValue.q50, 100);
  assert.equal(value.forecasts[30].probabilityUp, 0.6);
  assert.equal(trendLabel(value.trend.status), 'Rise');
});

test('intelligence contract rejects unordered quantiles and out-of-range probabilities', () => {
  const value = normalizeIntelligencePayload({
    supportTier: 4,
    payload: { forecasts: { 30: { q10: 100, q25: 90, q50: 80, q75: 70, q90: 60, probabilityUp: 7 } } }
  });
  assert.deepEqual(value.forecasts, {});
});

test('intelligence contract caps driver text and ignores unknown horizons/statuses', () => {
  const value = normalizeIntelligencePayload({ payload: {
    trend: { status: 'rocket' },
    forecasts: { 12: { q10: 1, q25: 2, q50: 3, q75: 4, q90: 5 } },
    drivers: { supporting: Array(8).fill('x') }
  } });
  assert.equal(value.trend.status, 'insufficient');
  assert.equal(Object.keys(value.forecasts).length, 0);
  assert.equal(value.drivers.supporting.length, 5);
});
