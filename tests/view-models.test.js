import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forecastViewModels,
  holdingViewModel,
  matchBucketFor,
  pricingStatusFor,
  searchResultViewModel,
  shellViewModel
} from '../app/assets/js/core/view-models.js';

const item = {
  id: 'scryfall:abc',
  externalId: 'abc',
  provider: 'scryfall',
  category: 'magic',
  name: 'Synthetic Lotus',
  setName: 'Synthetic Alpha',
  number: '001',
  variant: 'nonfoil',
  currency: 'USD',
  price: 125,
  priceSource: 'Scryfall',
  priceUpdatedAt: '2026-08-09T00:00:00.000Z',
  matchScore: 1
};

const publication = {
  variantId: '11111111-1111-4111-8111-111111111111',
  supportTier: 4,
  publishedAt: '2026-08-09T00:00:00.000Z',
  reasonCodes: ['qualified'],
  payload: {
    observed: { price: 100, currency: 'USD', source: 'Licensed source', observedAt: '2026-08-08T00:00:00.000Z' },
    forecasts: {
      30: { q10: 80, q25: 90, q50: 105, q75: 120, q90: 140, confidence: 72, maturesAt: '2026-09-08', modelVersion: 'v1' }
    },
    drivers: { supporting: ['Demand'], limiting: ['Sparse history'] }
  }
};

test('text similarity alone never creates an Exact customer-facing match bucket', () => {
  assert.equal(matchBucketFor({ name: 'Synthetic', matchScore: 1 }), 'likely');
  assert.equal(matchBucketFor({ ...item, matchBucket: 'exact' }), 'exact');
  assert.equal(matchBucketFor({ name: 'Synthetic', matchBucket: 'exact' }), 'likely');
});

test('pricing status remains distinct for verified, manual, restricted, and unavailable values', () => {
  assert.equal(pricingStatusFor(item), 'verified');
  assert.equal(pricingStatusFor(item, 50), 'manual');
  assert.equal(pricingStatusFor({ ...item, provider: 'pokemon', priceSource: 'Pokémon TCG API' }), 'unsupported');
  assert.equal(pricingStatusFor({ provider: 'custom' }), 'unavailable');
});

test('search adapter emits normalized truth-preserving fields', () => {
  const result = searchResultViewModel(item, { publication });
  assert.equal(result.id.startsWith('source:v1:scryfall:abc:'), true);
  assert.equal(result.matchBucket, 'likely');
  assert.equal(result.pricingStatus, 'verified');
  assert.equal(result.currentMarketValue, 125);
  assert.equal(result.change30d, null);
  assert.equal(result.forecastStatus, 'available');
});

test('holding adapter does not rewrite persistence and identifies local/manual value semantics', () => {
  const holding = { id: 'holding-1', item, quantity: 2, purchasePrice: 40, fees: 5, manualMarketPrice: 90, condition: 'Near Mint', updatedAt: '2026-08-09T00:00:00.000Z' };
  const before = structuredClone(holding);
  const result = holdingViewModel(holding, { publication });
  assert.equal(result.valueSource, 'manual');
  assert.equal(result.marketValue, 180);
  assert.equal(result.costBasis, 85);
  assert.equal(result.syncStatus, 'local');
  assert.equal(result.forecasts.length, 1);
  assert.deepEqual(holding, before);
});

test('forecast adapter fails closed below the approved publication tier', () => {
  assert.deepEqual(forecastViewModels({ ...publication, supportTier: 3 }), []);
  const [forecast] = forecastViewModels(publication, { holdingId: 'holding-1' });
  assert.deepEqual([forecast.lowerBound, forecast.expectedValue, forecast.upperBound], [80, 105, 140]);
  assert.equal(forecast.confidenceLabel, '72 / 100');
  assert.equal(forecast.actualValueAtMaturity, null);
});

test('shell adapter reports only supported local and cloud states', () => {
  assert.equal(shellViewModel({ auth: { session: null, syncing: false } }).syncLabel, 'Saved on this device');
  assert.equal(shellViewModel({ auth: { session: { user: { email: 'collector@example.test' } }, syncing: true } }).syncStatus, 'syncing');
});
