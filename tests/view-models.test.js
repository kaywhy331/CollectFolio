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
  type: 'Artifact',
  name: 'Synthetic Lotus',
  setName: 'Synthetic Alpha',
  number: '001',
  variant: 'nonfoil',
  language: 'en',
  marketCondition: 'near-mint',
  currency: 'USD',
  price: 125,
  priceSource: 'Scryfall',
  priceUpdatedAt: '2026-08-09T00:00:00.000Z',
  matchScore: 1
};

const publication = {
  variantId: '11111111-1111-4111-8111-111111111111',
  seriesIdentity: { sourceId: 'licensed', currency: 'USD', language: 'en', finish: 'nonfoil', conditionClass: 'raw', marketCondition: 'near-mint', priceSemantics: 'market' },
  supportTier: 4,
  publishedAt: '2026-08-09T00:00:00.000Z',
  reasonCodes: ['qualified'],
  payload: {
    observed: { price: 100, currency: 'USD', source: 'Licensed source', observedAt: '2026-08-08T00:00:00.000Z' },
    trend: { return30d: 0.08, status: 'rise', volatility: 0.03, confidence: 80, historyDensity: 0.9 },
    forecasts: {
      30: { q10: 80, q25: 90, q50: 105, q75: 120, q90: 140, confidence: 72, maturesAt: '2026-09-08', modelVersion: 'v1' },
      90: { q10: 75, q25: 90, q50: 110, q75: 135, q90: 160, confidence: 60, maturesAt: '2026-11-07', modelVersion: 'v1' },
      180: { q10: 70, q25: 90, q50: 120, q75: 150, q90: 190, confidence: 50, maturesAt: '2027-02-05', modelVersion: 'v1' },
      365: { q10: 60, q25: 90, q50: 135, q75: 180, q90: 240, confidence: 40, maturesAt: '2027-08-09', modelVersion: 'v1' }
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
  assert.equal(result.id.startsWith('source:v2:scryfall:abc:'), true);
  assert.equal(result.matchBucket, 'likely');
  assert.equal(result.pricingStatus, 'verified');
  assert.equal(result.currentMarketValue, 125);
  assert.equal(result.type, 'Artifact');
  assert.equal(result.change30d, 0.08);
  assert.equal(result.forecastStatus, 'available');
  assert.equal(result.forecast30d.estimatedValue, 105);
  assert.equal(result.forecast90d.estimatedValue, 110);
  assert.equal(result.forecast180d.estimatedValue, 120);
  assert.equal(result.forecast365d.estimatedValue, 135);
  assert.ok(Math.abs(result.forecast30d.estimatedChange - 0.05) < 1e-12);
});

test('approved observed price fills a rights-suppressed catalog price on forecast results', () => {
  const result = searchResultViewModel({
    ...item,
    provider: 'pokemon',
    category: 'pokemon',
    priceSource: 'Pokémon TCG API'
  }, { publication });
  assert.equal(result.pricingStatus, 'verified');
  assert.equal(result.currentMarketValue, 100);
  assert.equal(result.priceUpdatedAt, '2026-08-08T00:00:00.000Z');
  assert.ok(Math.abs(result.forecast30d.estimatedChange - 0.05) < 1e-12);
});

test('holding adapter does not rewrite persistence and identifies local/manual value semantics', () => {
  const holding = { id: 'holding-1', item, quantity: 2, purchasePrice: 40, fees: 5, manualMarketPrice: 90, condition: 'Near Mint', marketCondition: 'near-mint', updatedAt: '2026-08-09T00:00:00.000Z' };
  const before = structuredClone(holding);
  const result = holdingViewModel(holding, { publication });
  assert.equal(result.valueSource, 'manual');
  assert.equal(result.marketValue, 180);
  assert.equal(result.costBasis, 85);
  assert.equal(result.syncStatus, 'local');
  assert.equal(result.forecasts.length, 4);
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
