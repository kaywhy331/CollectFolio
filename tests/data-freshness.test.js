import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionFreshness,
  priceFreshness,
  providerFreshnessThresholdDays
} from '../app/assets/js/core/data-freshness.js';

const NOW = new Date('2026-08-20T12:00:00.000Z');

test('provider freshness thresholds are explicit and configurable', () => {
  assert.equal(providerFreshnessThresholdDays('scryfall'), 2);
  assert.equal(providerFreshnessThresholdDays('scryfall', { scryfall: 5 }), 5);
  assert.equal(providerFreshnessThresholdDays('unknown'), 7);
});

test('price freshness uses readable today, recent, stale, and unknown states', () => {
  assert.equal(priceFreshness({ provider: 'tcgcsv', priceUpdatedAt: '2026-08-20T02:00:00.000Z' }, NOW).label, 'Updated today');
  assert.match(priceFreshness({ provider: 'tcgcsv', priceUpdatedAt: '2026-08-18T02:00:00.000Z' }, NOW).label, /Updated recently/);
  assert.match(priceFreshness({ provider: 'scryfall', priceUpdatedAt: '2026-08-10T02:00:00.000Z' }, NOW).label, /Price may be stale/);
  assert.equal(priceFreshness({}, NOW).label, 'Update time unavailable');
});

test('collection freshness excludes manual values and reports stale market values', () => {
  const result = collectionFreshness([
    { item: { provider: 'scryfall', priceUpdatedAt: '2026-08-10T02:00:00.000Z' }, manualMarketPrice: '' },
    { item: { provider: 'tcgcsv', priceUpdatedAt: '2026-08-20T02:00:00.000Z' }, manualMarketPrice: '' },
    { item: { provider: 'custom', updatedAt: '2026-01-01T00:00:00.000Z' }, manualMarketPrice: 12 }
  ], NOW);
  assert.equal(result.known, 2);
  assert.equal(result.stale, 1);
  assert.equal(result.latest.state, 'today');
});
