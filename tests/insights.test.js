import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertHistoryModels,
  forecastAvailabilityForHolding,
  forecastAssets,
  portfolioForecastSummary,
  predictionHistoryModels,
  publishedScorecards
} from '../app/assets/js/core/insights.js';
import { renderInsights } from '../app/assets/js/views/insights.js';

const variantId = '123e4567-e89b-42d3-a456-426614174000';
const secondVariantId = '223e4567-e89b-42d3-a456-426614174000';
const item = { provider: 'pokemon', category: 'pokemon', name: 'Pikachu ex', setName: 'Test Set', number: '1', variant: 'holofoil', language: 'en', price: 80, currency: 'USD' };

function publication(overrides = {}) {
  return {
    variantId,
    seriesIdentity: { sourceId: 'approved-source', currency: 'USD', language: 'en', finish: 'holofoil', conditionClass: 'raw', marketCondition: 'near-mint', priceSemantics: 'market' },
    supportTier: 4,
    publishedAt: '2026-08-01T00:00:00.000Z',
    reasonCodes: [],
    sourceAttributions: [{ name: 'Approved fixture' }],
    payload: {
      observed: { price: 100, currency: 'USD', source: 'Approved fixture', observedAt: '2026-08-01T00:00:00.000Z' },
      history: [
        { price: 88, currency: 'USD', observedAt: '2026-06-01T00:00:00.000Z' },
        { price: 94, currency: 'USD', observedAt: '2026-07-01T00:00:00.000Z' }
      ],
      forecasts: {
        90: {
          q10: 80, q25: 90, q50: 110, q75: 130, q90: 150,
          confidence: 60, confidenceReason: 'History is complete enough for a reviewed medium-width range.',
          coverageStatus: 'Exact raw variant', origin: '2026-08-01T00:00:00.000Z',
          maturesAt: '2026-10-30T00:00:00.000Z', modelVersion: 'model-v1'
        }
      },
      drivers: { supporting: ['Sustained collector demand'], limiting: ['Wide recent volatility'] }
    },
    ...overrides
  };
}

function state(overrides = {}) {
    const holding = { id: 'h1', canonicalVariantId: variantId, item, condition: 'Near Mint', marketCondition: 'near-mint', quantity: 2, purchasePrice: 60, fees: 0, manualMarketPrice: '' };
  return {
    holdings: [holding],
    snapshots: [],
    watchlistItems: [],
    alerts: [],
    settings: { currency: 'USD' },
    overview: { range: '3M' },
    insights: { view: 'forecasts', horizon: 90, alertFilter: 'all' },
    intelligence: { byVariant: { [variantId]: publication() }, history: [], loading: false, error: '' },
    featureFlags: { publicPriceIntelligence: true, watchlists: true },
    ...overrides
  };
}

test('portfolio forecast summary covers only approved non-manual holdings in the same currency', () => {
  const holdings = [
    { id: 'covered', canonicalVariantId: variantId, item, condition: 'Near Mint', marketCondition: 'near-mint', quantity: 2, manualMarketPrice: '' },
    { id: 'manual', canonicalVariantId: variantId, item, condition: 'Near Mint', marketCondition: 'near-mint', quantity: 1, manualMarketPrice: 50 },
    { id: 'unmapped', canonicalVariantId: '', item: { ...item, price: null }, quantity: 1, manualMarketPrice: '' },
    { id: 'currency', canonicalVariantId: secondVariantId, item, condition: 'Near Mint', marketCondition: 'near-mint', quantity: 1, manualMarketPrice: '' }
  ];
  const eur = publication({ variantId: secondVariantId, payload: {
    observed: { price: 90, currency: 'EUR', observedAt: '2026-08-01T00:00:00.000Z' },
    forecasts: { 90: { q10: 70, q25: 80, q50: 95, q75: 110, q90: 120 } }
  } });
  const summary = portfolioForecastSummary(holdings, { [variantId]: publication(), [secondVariantId]: eur }, 90, { currency: 'USD' });
  assert.equal(summary.coveredHoldings, 1);
  assert.equal(summary.totalHoldings, 4);
  assert.equal(summary.approvedCurrentValue, 200);
  assert.equal(summary.lowerBound, 180);
  assert.equal(summary.expectedValue, 220);
  assert.equal(summary.upperBound, 260);
  assert.match(summary.rows.find((row) => row.holding.id === 'manual').reason, /manual value/i);
  assert.match(summary.rows.find((row) => row.holding.id === 'currency').reason, /cannot be combined/i);
});

test('forecast availability preserves explicit limited status and explains missing horizons', () => {
  const limited = publication();
  limited.payload.forecasts[90].status = 'limited';
  const holding = { canonicalVariantId: variantId, item, condition: 'Near Mint', marketCondition: 'near-mint', quantity: 1, manualMarketPrice: '' };
  assert.equal(forecastAvailabilityForHolding(holding, limited, 90).status, 'limited');
  const unavailable = forecastAvailabilityForHolding(holding, limited, 30);
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.nextAction, /90 days/);
});

test('forecast availability selects one exact market series and rejects condition mismatches', () => {
  const nearMint = publication();
  const lightlyPlayed = publication({
    seriesIdentity: { ...publication().seriesIdentity, marketCondition: 'lightly-played' },
    payload: { ...publication().payload, forecasts: { 90: { ...publication().payload.forecasts[90], q50: 75 } } }
  });
  const holding = { canonicalVariantId: variantId, item, condition: 'Near Mint', marketCondition: 'near-mint', quantity: 1, manualMarketPrice: '' };
  const selected = forecastAvailabilityForHolding(holding, [lightlyPlayed, nearMint], 90);
  assert.equal(selected.status, 'available');
  assert.equal(selected.forecast.q50, 110);
  const mismatch = forecastAvailabilityForHolding({ ...holding, marketCondition: 'moderately-played' }, [nearMint, lightlyPlayed], 90);
  assert.equal(mismatch.status, 'unavailable');
  assert.match(mismatch.reason, /different language, printing, or market condition/i);
});

test('generic collection condition never substitutes for confirmed marketplace condition', () => {
  const legacy = { canonicalVariantId: variantId, item, condition: 'Good', quantity: 1, manualMarketPrice: '' };
  const result = forecastAvailabilityForHolding(legacy, publication(), 90);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /complete exact market identity/i);
});

test('forecast assets deduplicate only the same exact series', () => {
  const holding = { id: 'nm', canonicalVariantId: variantId, item, marketCondition: 'near-mint', quantity: 1, manualMarketPrice: '' };
  const watch = (condition) => ({
    watchKey: `watch:${condition}`,
    canonicalVariantId: variantId,
    marketCondition: condition,
    catalogRef: { ...item, finish: 'holofoil', conditionClass: 'raw', marketCondition: condition, currency: 'USD' }
  });
  const nearMint = publication();
  const lightlyPlayed = publication({
    seriesIdentity: { ...publication().seriesIdentity, marketCondition: 'lightly-played' }
  });
  const assets = forecastAssets(
    [holding],
    [watch('near-mint'), watch('lightly-played')],
    { [variantId]: [nearMint, lightlyPlayed] },
    90,
    { currency: 'USD' }
  );
  assert.deepEqual(assets.map((asset) => asset.key).sort(), ['holding:nm', 'watch:watch:lightly-played']);
});

test('prediction history links immutable revisions and excludes incomplete matured outcomes from metrics', () => {
  const first = publication();
  const second = publication({ publishedAt: '2026-08-05T00:00:00.000Z', payload: {
    ...publication().payload,
    forecasts: { 90: {
      ...publication().payload.forecasts[90], q25: 95, q50: 115, q75: 135,
      maturesAt: '2026-08-09T00:00:00.000Z', modelVersion: 'model-v2'
    } }
  } });
  const history = predictionHistoryModels([{ value: first }, { value: second }], {}, new Date('2026-08-10T00:00:00.000Z'));
  assert.equal(history.length, 2);
  assert.equal(history[0].status, 'awaiting-evaluation');
  assert.ok(history[0].previousForecastId);
  assert.match(history[0].whatChanged, /changed/i);

  second.payload.forecasts[90] = {
    ...second.payload.forecasts[90], maturedAt: '2026-08-10T00:00:00.000Z',
    actualValueAtMaturity: 112, absoluteError: 3, directionResult: 'correct'
  };
  const evaluated = predictionHistoryModels([{ value: second }], {}, new Date('2026-08-10T00:00:00.000Z'));
  assert.equal(evaluated[0].status, 'matured');
  assert.equal(evaluated[0].absoluteError, 3);
});

test('prediction history never chains revisions across market conditions', () => {
  const nearMint = publication({ publishedAt: '2026-08-01T00:00:00.000Z' });
  const lightlyPlayed = publication({
    publishedAt: '2026-08-02T00:00:00.000Z',
    seriesIdentity: { ...publication().seriesIdentity, marketCondition: 'lightly-played' }
  });
  const history = predictionHistoryModels([], { [variantId]: [nearMint, lightlyPlayed] });
  assert.equal(history.length, 2);
  assert.ok(history.every((value) => value.previousForecastId === ''));
});

test('track record exposes percentages only from complete tier-5 scorecards', () => {
  const tierFour = publication();
  tierFour.payload.scorecards = [{ modelVersion: 'm', cohort: 'raw', horizonDays: 90, maturedForecasts: 20, medianAbsoluteErrorPct: 12, directionAccuracy: 0.7, interval80Coverage: 0.8, baselineErrorPct: 18 }];
  assert.deepEqual(publishedScorecards({ [variantId]: tierFour }), []);
  const tierFive = { ...tierFour, supportTier: 5 };
  assert.equal(publishedScorecards({ [variantId]: tierFive }).length, 1);
});

test('alert history keeps read, muted, exact-variant, and system states textual', () => {
  const watch = { watchKey: 'watch:1', catalogRef: { name: 'Pikachu ex' } };
  const alerts = [
    { id: 'a1', watchKey: 'watch:1', kind: 'forecast_change', message: 'Changed', readAt: '', mutedAt: '' },
    { id: 'a2', watchKey: 'watch:1', kind: 'system_sync', message: 'Sync failed', readAt: 'now', mutedAt: 'now' }
  ];
  assert.deepEqual(alertHistoryModels(alerts, [watch], 'unread').map((entry) => entry.id), ['a1']);
  const muted = alertHistoryModels(alerts, [watch], 'muted');
  assert.equal(muted[0].system, true);
  assert.equal(muted[0].item.name, 'Pikachu ex');
});

test('Insights renders actual and forecast values separately with an accessible ribbon summary', () => {
  const html = renderInsights(state());
  assert.match(html, /Current recorded portfolio value/);
  assert.match(html, /90-day likely modeled range/);
  assert.match(html, /Current market observation/);
  assert.match(html, /Present boundary/);
  assert.match(html, /Forecast values are modeled ranges, not observed history/);
  assert.match(html, /History is complete enough/);
  assert.match(html, /Sustained collector demand/);
  assert.match(html, /never added to current portfolio value/);
});

test('Insights keeps published forecasts fail closed while local scenarios remain available', () => {
  const html = renderInsights(state({ featureFlags: { publicPriceIntelligence: false, watchlists: true } }));
  assert.match(html, /Local scenario outlook/);
  assert.match(html, /Published market forecasts remain gated/);
  assert.match(html, /local-scenario-chart/);
  assert.doesNotMatch(html, /Approved forecast projection/);
  assert.doesNotMatch(html, /Probability of gain/);
});
