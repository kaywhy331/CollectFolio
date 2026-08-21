import { marketSeriesIdentity } from './market-series.js';

export const FORECAST_HORIZONS = Object.freeze([7, 30, 90, 180, 365]);
const HORIZONS = new Set(FORECAST_HORIZONS);
const TREND_STATUSES = new Set(['strong_rise', 'rise', 'stable', 'fall', 'strong_fall', 'insufficient']);
const FORECAST_STATUSES = new Set(['available', 'limited']);
const DIRECTION_RESULTS = new Set(['correct', 'incorrect', 'flat', 'unscorable']);

const finite = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const nonNegative = (value) => {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
};
const bounded = (value, min, max) => {
  const number = finite(value);
  return number !== null && number >= min && number <= max ? number : null;
};
const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';

function orderedPrices(input = {}) {
  const values = ['q10', 'q25', 'q50', 'q75', 'q90'].map((key) => nonNegative(input[key]));
  if (values.some((value) => value === null)) return null;
  if (values.some((value, index) => index && value < values[index - 1])) return null;
  return Object.fromEntries(['q10', 'q25', 'q50', 'q75', 'q90'].map((key, index) => [key, values[index]]));
}

export function normalizeIntelligencePayload(publication = {}) {
  const supportTier = Math.max(0, Math.min(5, Number(publication.supportTier) || 0));
  const input = publication.payload && typeof publication.payload === 'object' ? publication.payload : {};
  const seriesInput = publication.seriesIdentity || input.seriesIdentity || {};
  const seriesIdentity = marketSeriesIdentity(seriesInput);
  const observedInput = input.observed || {};
  const observedPrice = nonNegative(observedInput.price);
  const currency = text(observedInput.currency || 'USD', 3).toUpperCase();
  const observed = observedPrice === null ? null : {
    price: observedPrice,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD',
    source: text(observedInput.source),
    observedAt: text(observedInput.observedAt, 40),
    quality: bounded(observedInput.quality, 0, 1)
  };

  const historyInput = Array.isArray(input.history)
    ? input.history
    : Array.isArray(input.observations) ? input.observations : [];
  const history = historyInput.map((entry) => {
    const price = nonNegative(entry?.price);
    const observedAt = text(entry?.observedAt || entry?.date, 40);
    if (price === null || !observedAt || !Number.isFinite(Date.parse(observedAt))) return null;
    const historyCurrency = text(entry?.currency || observed?.currency || 'USD', 3).toUpperCase();
    return {
      price,
      currency: /^[A-Z]{3}$/.test(historyCurrency) ? historyCurrency : 'USD',
      source: text(entry?.source, 120),
      observedAt,
      quality: bounded(entry?.quality, 0, 1)
    };
  }).filter(Boolean).sort((left, right) => left.observedAt.localeCompare(right.observedAt)).slice(-180);

  const trendInput = input.trend || {};
  const trendStatus = TREND_STATUSES.has(trendInput.status) ? trendInput.status : 'insufficient';
  const trend = {
    return7d: finite(trendInput.return7d),
    return30d: finite(trendInput.return30d),
    return90d: finite(trendInput.return90d),
    return180d: finite(trendInput.return180d),
    return365d: finite(trendInput.return365d),
    status: trendStatus,
    volatility: nonNegative(trendInput.volatility),
    confidence: bounded(trendInput.confidence, 0, 100),
    historyDensity: bounded(trendInput.historyDensity, 0, 1)
  };

  const fairInput = input.fairValue || {};
  const fairPrices = orderedPrices(fairInput);
  const fairValue = fairPrices ? {
    ...fairPrices,
    position: ['below_range','within_range','above_range','insufficient'].includes(fairInput.position) ? fairInput.position : 'insufficient',
    confidence: bounded(fairInput.confidence, 0, 100)
  } : null;

  const forecasts = {};
  for (const [rawHorizon, value] of Object.entries(input.forecasts || {})) {
    const horizon = Number(rawHorizon);
    if (!HORIZONS.has(horizon) || !value || typeof value !== 'object') continue;
    const prices = orderedPrices(value);
    if (!prices) continue;
    forecasts[horizon] = {
      horizon,
      ...prices,
      probabilityUp: bounded(value.probabilityUp, 0, 1),
      confidence: bounded(value.confidence, 0, 100),
      forecastStatus: FORECAST_STATUSES.has(value.forecastStatus || value.status)
        ? (value.forecastStatus || value.status)
        : 'available',
      confidenceReason: text(value.confidenceReason, 360),
      coverageStatus: text(value.coverageStatus, 160),
      dataFreshness: text(value.dataFreshness, 160),
      whatChanged: text(value.whatChanged, 360),
      origin: text(value.origin, 40),
      maturesAt: text(value.maturesAt, 40),
      modelVersion: text(value.modelVersion, 120),
      modelUpdatedAt: text(value.modelUpdatedAt, 40),
      maturedAt: text(value.maturedAt, 40),
      actualValueAtMaturity: nonNegative(value.actualValueAtMaturity),
      absoluteError: nonNegative(value.absoluteError),
      directionResult: DIRECTION_RESULTS.has(value.directionResult) ? value.directionResult : ''
    };
  }

  const scorecards = Array.isArray(input.scorecards)
    ? input.scorecards.map(normalizeModelScorecard).filter(Boolean).slice(0, 5)
    : [];

  const drivers = input.drivers && typeof input.drivers === 'object' ? {
    supporting: Array.isArray(input.drivers.supporting) ? input.drivers.supporting.slice(0, 5).map((entry) => text(entry, 240)).filter(Boolean) : [],
    limiting: Array.isArray(input.drivers.limiting) ? input.drivers.limiting.slice(0, 5).map((entry) => text(entry, 240)).filter(Boolean) : []
  } : { supporting: [], limiting: [] };

  return {
    variantId: publication.variantId || '',
    seriesIdentity,
    supportTier,
    observed: supportTier >= 1 ? observed : null,
    history: supportTier >= 2 ? history : [],
    trend: supportTier >= 2 ? trend : { return7d: null, return30d: null, return90d: null, return180d: null, return365d: null, status: 'insufficient', volatility: null, confidence: null, historyDensity: null },
    fairValue: supportTier >= 3 ? fairValue : null,
    forecasts: supportTier >= 4 ? forecasts : {},
    // Tier 5 is "Fully evaluated" (PRD Sec 12): scorecards require matured,
    // held-out prediction history and never appear below that tier.
    scorecards: supportTier >= 5 ? scorecards : [],
    drivers,
    reasonCodes: Array.isArray(publication.reasonCodes) ? publication.reasonCodes.map((entry) => text(entry, 80)).filter(Boolean) : [],
    sourceAttributions: Array.isArray(publication.sourceAttributions) ? publication.sourceAttributions.slice(0, 10).map((entry) => ({
      name: text(entry?.name || entry?.code, 120),
      observedAt: text(entry?.observedAt, 40),
      attribution: text(entry?.attribution, 240)
    })).filter((entry) => entry.name) : [],
    publishedAt: publication.publishedAt || '',
    expiresAt: publication.expiresAt || ''
  };
}

/** Validates one PRD Sec 14.6 model scorecard entry. Returns null rather
 * than a partially trusted object when any required field is missing or out
 * of range — public model claims must come from complete held-out results,
 * never a reconstructed fragment. */
export function normalizeModelScorecard(input = {}) {
  if (!input || typeof input !== 'object') return null;
  const modelVersion = text(input.modelVersion, 120);
  const cohort = text(input.cohort, 160);
  const horizon = Number(input.horizonDays);
  const matured = Number(input.maturedForecasts);
  const medianAbsoluteErrorPct = nonNegative(input.medianAbsoluteErrorPct);
  const directionAccuracy = bounded(input.directionAccuracy, 0, 1);
  const interval80Coverage = bounded(input.interval80Coverage, 0, 1);
  const baselineErrorPct = nonNegative(input.baselineErrorPct);
  if (!modelVersion || !cohort || !HORIZONS.has(horizon)) return null;
  if (!Number.isInteger(matured) || matured < 1) return null;
  if (medianAbsoluteErrorPct === null || directionAccuracy === null || interval80Coverage === null || baselineErrorPct === null) return null;
  return {
    modelVersion,
    cohort,
    horizonDays: horizon,
    maturedForecasts: matured,
    medianAbsoluteErrorPct,
    directionAccuracy,
    interval80Coverage,
    baselineErrorPct,
    lastTrained: text(input.lastTrained, 40)
  };
}

export function trendLabel(status) {
  return ({ strong_rise: 'Strong rise', rise: 'Rise', stable: 'Stable', fall: 'Fall', strong_fall: 'Strong fall', insufficient: 'Insufficient data' })[status] || 'Insufficient data';
}
