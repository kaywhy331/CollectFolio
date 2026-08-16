import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComparison, COMPARE_LIMIT, toggleCompareSelection } from '../app/assets/js/core/compare.js';
import { normalizeIntelligencePayload, normalizeModelScorecard } from '../app/assets/js/core/intelligence-contract.js';
import { catalogReferenceForItem } from '../app/assets/js/core/catalog-identity.js';
import { renderPriceIntelligenceDetail } from '../app/assets/js/views/price-intelligence-detail.js';

const variantA = '123e4567-e89b-42d3-a456-426614174000';
const variantB = '223e4567-e89b-42d3-a456-426614174000';
const item = {
  provider: 'pokemon', externalId: 'sv3-223', category: 'pokemon', game: 'Pokémon',
  name: 'Charizard ex', setName: 'Obsidian Flames', number: '223', variant: 'holofoil', language: 'en', marketCondition: 'near-mint',
  price: 90, currency: 'USD'
};

function watched(watchKey, canonicalVariantId, catalogRef) {
  return { id: watchKey, watchKey, canonicalVariantId, catalogRef, marketCondition: 'near-mint', targetPrice: '' };
}

function publication(variantId, supportTier, payload) {
  return { variantId, seriesIdentity: { sourceId: 'approved', currency: 'USD', language: 'en', finish: 'holofoil', conditionClass: 'raw', marketCondition: 'near-mint', priceSemantics: 'market' }, supportTier, reasonCodes: [], payload, sourceAttributions: [], publishedAt: '2026-08-01T00:00:00Z' };
}

test('compare selection toggles, removes, and caps at the PRD limit of four', () => {
  let selection = [];
  for (const key of ['a', 'b', 'c', 'd']) selection = toggleCompareSelection(selection, key);
  assert.equal(selection.length, COMPARE_LIMIT);
  assert.equal(toggleCompareSelection(selection, 'e'), selection); // cap: unchanged reference
  assert.deepEqual(toggleCompareSelection(selection, 'b'), ['a', 'c', 'd']);
});

test('comparison columns show dashes for unavailable values, never invented numbers', () => {
  const ref = catalogReferenceForItem(item);
  const { columns, confidenceDiffers } = buildComparison([ref.watchKey], [watched(ref.watchKey, '', ref)], {});
  assert.equal(columns.length, 1);
  assert.equal(columns[0].return30d, '—');
  assert.equal(columns[0].probabilityUp, '—');
  assert.equal(columns[0].confidenceLabel, 'Unknown');
  assert.equal(confidenceDiffers, false);
});

test('mixed-confidence comparisons are flagged as not like-for-like', () => {
  const refA = catalogReferenceForItem(item, { canonicalVariantId: variantA });
  const refB = catalogReferenceForItem({ ...item, name: 'Pikachu', externalId: 'sv3-16' }, { canonicalVariantId: variantB });
  const byVariant = {
    [variantA]: publication(variantA, 2, { observed: { price: 800, currency: 'USD' }, trend: { return30d: 0.18, status: 'strong_rise', confidence: 85 } }),
    [variantB]: publication(variantB, 2, { observed: { price: 30, currency: 'USD' }, trend: { return30d: 0.02, status: 'stable', confidence: 25 } })
  };
  const comparison = buildComparison(
    [refA.watchKey, refB.watchKey],
    [watched(refA.watchKey, variantA, refA), watched(refB.watchKey, variantB, refB)],
    byVariant
  );
  assert.equal(comparison.confidenceDiffers, true);
  assert.equal(comparison.columns[0].confidenceLabel, 'High');
  assert.equal(comparison.columns[1].confidenceLabel, 'Low');
});

test('column overall confidence is the weakest contributing confidence', () => {
  const ref = catalogReferenceForItem(item, { canonicalVariantId: variantA });
  const byVariant = {
    [variantA]: publication(variantA, 4, {
      observed: { price: 800, currency: 'USD' },
      trend: { return30d: 0.18, status: 'strong_rise', confidence: 90 },
      fairValue: { q10: 500, q25: 550, q50: 600, q75: 680, q90: 720, position: 'above_range', confidence: 70 },
      forecasts: {
        30: { q10: 760, q25: 780, q50: 820, q75: 850, q90: 880, probabilityUp: 0.6, confidence: 45 },
        365: { q10: 540, q25: 700, q50: 850, q75: 990, q90: 1200, probabilityUp: 0.9, confidence: 20 }
      }
    })
  };
  const { columns } = buildComparison([ref.watchKey], [watched(ref.watchKey, variantA, ref)], byVariant);
  assert.equal(columns[0].confidence, 45);
  assert.equal(columns[0].confidenceLabel, 'Medium-low');
  assert.equal(columns[0].probabilityUp, '60%');
  assert.equal(columns[0].forecastHorizon, 30);
});

test('scorecard normalization rejects incomplete or out-of-range entries', () => {
  const valid = {
    modelVersion: 'pokemon_raw_365d_v1.3', cohort: 'Modern English raw', horizonDays: 365,
    maturedForecasts: 842, medianAbsoluteErrorPct: 18.4, directionAccuracy: 0.612,
    interval80Coverage: 0.779, baselineErrorPct: 22.7, lastTrained: '2026-07-01'
  };
  assert.ok(normalizeModelScorecard(valid));
  assert.equal(normalizeModelScorecard({ ...valid, horizonDays: 45 }), null);
  assert.equal(normalizeModelScorecard({ ...valid, maturedForecasts: 0 }), null);
  assert.equal(normalizeModelScorecard({ ...valid, directionAccuracy: 1.2 }), null);
  assert.equal(normalizeModelScorecard({ ...valid, baselineErrorPct: undefined }), null);
});

test('scorecards are stripped below tier 5 and rendered at tier 5', () => {
  const scorecard = {
    modelVersion: 'pokemon_raw_365d_v1.3', cohort: 'Modern English raw', horizonDays: 365,
    maturedForecasts: 842, medianAbsoluteErrorPct: 18.4, directionAccuracy: 0.612,
    interval80Coverage: 0.779, baselineErrorPct: 22.7, lastTrained: '2026-07-01'
  };
  const payload = {
    observed: { price: 800, currency: 'USD' },
    trend: { return30d: 0.1, status: 'rise', confidence: 70 },
    fairValue: { q10: 500, q25: 550, q50: 600, q75: 680, q90: 720, position: 'within_range', confidence: 60 },
    forecasts: { 365: { q10: 540, q25: 700, q50: 850, q75: 990, q90: 1200, probabilityUp: 0.6, confidence: 50 } },
    scorecards: [scorecard]
  };
  assert.equal(normalizeIntelligencePayload(publication(variantA, 4, payload)).scorecards.length, 0);
  const tier5 = normalizeIntelligencePayload(publication(variantA, 5, payload));
  assert.equal(tier5.scorecards.length, 1);

  const catalogRef = catalogReferenceForItem(item, { canonicalVariantId: variantA });
  const state = {
    holdings: [], watchlistItems: [], alerts: [],
    settings: { currency: 'USD' },
    featureFlags: { watchlists: true, publicPriceIntelligence: true },
    intelligence: { byVariant: { [variantA]: publication(variantA, 5, payload) } }
  };
  const html = renderPriceIntelligenceDetail({ origin: 'portfolio', item, catalogRef }, state);
  assert.match(html, /Model scorecard/);
  assert.match(html, /842/);
  assert.match(html, /No-change baseline error/);
  assert.match(html, /Held-out or prospective results only/);
});
