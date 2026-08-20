import { catalogPriceForValuation } from './pricing-policy.js';

export const LOCAL_SCENARIO_HORIZONS = Object.freeze([7, 30, 90, 180, 365]);
export const LOCAL_SCENARIO_MODEL_VERSION = 'local-scenario-v1';

const DAY_MS = 86_400_000;
const T_Z = Object.freeze({ q10: -1.533, q25: -0.741, q50: 0, q75: 0.741, q90: 1.533 });
const MAX_UNIT_PRICE = 1_000_000_000_000;
const MAX_HORIZON_VOLATILITY = Math.log(6) / (2 * Math.abs(T_Z.q90));
const finite = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value)
  : null;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const currencyCode = (value, fallback = 'USD') => /^[A-Z]{3}$/.test(String(value || '').toUpperCase())
  ? String(value).toUpperCase()
  : fallback;

function timestamp(value) {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function utcDay(value) {
  const time = timestamp(value);
  return time === null ? '' : new Date(time).toISOString().slice(0, 10);
}

function sourceKind(value) {
  return value === 'catalog' ? 'catalog' : value === 'manual' ? 'manual' : '';
}

function weightedMean(values, weights) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return 0;
  return values.reduce((sum, value, index) => sum + value * weights[index], 0) / total;
}

function elapsedWeight(asOfTime, observedTime, halfLifeDays) {
  return 0.5 ** (Math.max(0, (asOfTime - observedTime) / DAY_MS) / halfLifeDays);
}

export function localScenarioSubject(holding = {}) {
  return String(holding.id || holding.catalogKey || holding.canonicalVariantId || holding.catalogId || '').trim();
}

// Kevin's explicit rejection of +/-% bands demotes local-scenario-v1 to
// manual/custom items only (T6, PRD Sec4): it must never present as a
// price forecast for a catalog-linked item, which now has a real
// published trajectory-v1 outlook to defer to instead. "Manual/custom"
// mirrors views/holding-form.js's own isCatalogItem check -- a holding
// counts as catalog-linked once it carries a non-'custom' provider.
export function isManualScenarioSubject(holding = {}) {
  const provider = String(holding?.item?.provider || '').trim().toLowerCase();
  return !provider || provider === 'custom';
}

export function normalizeLocalObservations(records = [], { asOf = new Date() } = {}) {
  const asOfTime = new Date(asOf).valueOf();
  if (!Number.isFinite(asOfTime)) return [];
  const normalized = (Array.isArray(records) ? records : []).map((record) => {
    const observedTime = timestamp(record?.observedAt);
    const unitPrice = finite(record?.unitPrice);
    const source = sourceKind(record?.source);
    if (!record?.id || !record?.subjectId || observedTime === null || observedTime > asOfTime
        || unitPrice === null || unitPrice <= 0 || unitPrice > MAX_UNIT_PRICE || !source) return null;
    return {
      id: String(record.id), subjectId: String(record.subjectId), observedAt: new Date(observedTime).toISOString(),
      observedTime, day: utcDay(record.observedAt), unitPrice, currency: currencyCode(record.currency), source,
      sourceLabel: String(record.sourceLabel || (source === 'manual' ? 'Your estimate' : 'Catalog price')).slice(0, 120),
      sourceUpdatedAt: timestamp(record.sourceUpdatedAt) === null ? '' : new Date(timestamp(record.sourceUpdatedAt)).toISOString(),
      supersedes: String(record.supersedes || ''), createdAt: String(record.createdAt || record.observedAt),
      createdTime: timestamp(record.createdAt || record.observedAt) ?? observedTime
    };
  }).filter(Boolean);

  const superseded = new Set(normalized.map((record) => record.supersedes).filter(Boolean));
  const active = normalized.filter((record) => !superseded.has(record.id));
  const byDay = new Map();
  for (const record of active.sort((left, right) => left.observedTime - right.observedTime
    || left.createdTime - right.createdTime || left.id.localeCompare(right.id))) {
    byDay.set(`${record.subjectId}:${record.source}:${record.day}`, record);
  }
  return [...byDay.values()].sort((left, right) => left.observedTime - right.observedTime
    || left.createdTime - right.createdTime || left.id.localeCompare(right.id));
}

export function localObservationForHolding(holding = {}, observedAt = new Date().toISOString()) {
  const subjectId = localScenarioSubject(holding);
  if (!subjectId) return null;
  const manual = finite(holding.manualMarketPrice);
  const catalog = finite(holding.item?.price);
  const source = manual !== null ? 'manual' : catalog !== null ? 'catalog' : '';
  const unitPrice = source === 'manual' ? manual : catalog;
  if (!source || unitPrice === null || unitPrice <= 0) return null;
  const sourceLabel = source === 'manual'
    ? 'Your estimate'
    : String(holding.item?.priceSource || 'Catalog price').slice(0, 120);
  const day = utcDay(observedAt);
  if (!day) return null;
  const sourceUpdatedTime = source === 'catalog' ? timestamp(holding.item?.priceUpdatedAt) : null;
  return {
    id: `local-value:v1:${encodeURIComponent(subjectId)}:${source}:${day}`,
    subjectId, observedAt: new Date(observedAt).toISOString(), unitPrice,
    currency: currencyCode(source === 'manual'
      ? holding.manualMarketCurrency || holding.item?.currency
      : holding.item?.currency),
    source, sourceLabel,
    sourceUpdatedAt: sourceUpdatedTime === null ? '' : new Date(sourceUpdatedTime).toISOString(),
    supersedes: '', createdAt: new Date(observedAt).toISOString()
  };
}

export function appendOnlyLocalObservation(records = [], observation, revisionId) {
  if (!observation?.id || !revisionId) return null;
  const activeForDay = normalizeLocalObservations(records, { asOf: new Date(observation.observedAt) })
    .filter((record) => record.subjectId === observation.subjectId
      && record.source === observation.source
      && record.day === utcDay(observation.observedAt))
    .at(-1) || null;
  if (activeForDay
      && activeForDay.unitPrice === observation.unitPrice
      && activeForDay.currency === observation.currency
      && activeForDay.sourceLabel === observation.sourceLabel
      && activeForDay.sourceUpdatedAt === observation.sourceUpdatedAt) return null;
  return {
    ...observation,
    id: String(revisionId),
    supersedes: activeForDay?.id || ''
  };
}

function confidenceFor(count, stalenessDays, source) {
  const score = Math.min(0.75, (count / (count + 20)) * Math.exp(-stalenessDays / 90) * (source === 'catalog' ? 1 : 0.6));
  if (count < 3 || score < 0.15) return { score, label: 'Early', detail: 'A broad prior drives most of this range.' };
  if (count < 8 || score < 0.35) return { score, label: 'Low', detail: 'Limited local history keeps this range intentionally wide.' };
  if (count < 21 || score < 0.55) return { score, label: 'Developing', detail: 'Local volatility contributes, while drift remains strongly constrained.' };
  return { score, label: 'Moderate', detail: 'A longer local series informs volatility; this remains a scenario, not an appraisal.' };
}

export function buildLocalScenario(records = [], horizon = 90, {
  asOf = new Date(),
  priorDailyVolatility = 0.025,
  priorDailyDrift = 0
} = {}) {
  const selectedHorizon = LOCAL_SCENARIO_HORIZONS.includes(Number(horizon)) ? Number(horizon) : 90;
  const allObservations = normalizeLocalObservations(records, { asOf });
  const latestRecord = allObservations.at(-1) || null;
  const observations = latestRecord
    ? allObservations.filter((entry) => entry.subjectId === latestRecord.subjectId)
    : [];
  const latest = observations.at(-1) || null;
  if (!latest) return {
    kind: 'local-scenario', status: 'unavailable', horizon: selectedHorizon, observationCount: 0,
    reason: 'Add a current value to start your scenario.', nextAction: 'Save a catalog or manual unit value for this item.'
  };
  const asOfTime = new Date(asOf).valueOf();
  const sourceUpdatedTime = latest.source === 'catalog' ? timestamp(latest.sourceUpdatedAt) : null;
  const valueAsOfTime = sourceUpdatedTime !== null && sourceUpdatedTime <= asOfTime
    ? Math.min(latest.observedTime, sourceUpdatedTime)
    : latest.observedTime;
  const valueAsOf = new Date(valueAsOfTime).toISOString();
  const stalenessDays = Math.max(0, (asOfTime - valueAsOfTime) / DAY_MS);
  const modelObservations = observations.filter((entry) => entry.source === latest.source && entry.currency === latest.currency);
  const confidence = confidenceFor(modelObservations.length, stalenessDays, latest.source);
  const base = {
    kind: 'local-scenario', modelVersion: LOCAL_SCENARIO_MODEL_VERSION, horizon: selectedHorizon,
    observationCount: modelObservations.length, totalObservationCount: observations.length,
    observed: latest.unitPrice, currency: latest.currency,
    observedAt: latest.observedAt, valueAsOf, sourceUpdatedAt: latest.sourceUpdatedAt,
    source: latest.source, sourceLabel: latest.sourceLabel,
    stalenessDays, confidence, history: observations.map((entry) => ({
      price: entry.unitPrice, observedAt: entry.observedAt, sourceUpdatedAt: entry.sourceUpdatedAt,
      source: entry.source, currency: entry.currency
    }))
  };
  if (stalenessDays > 180) return {
    ...base, status: 'stale', reason: 'The latest value is more than 180 days old.',
    nextAction: 'Update the card value before using a scenario range.'
  };

  const pairs = [];
  let excludedChangeCount = 0;
  for (let index = 1; index < modelObservations.length; index += 1) {
    const previous = modelObservations[index - 1];
    const current = modelObservations[index];
    const days = (current.observedTime - previous.observedTime) / DAY_MS;
    if (!(days > 0)) continue;
    const change = Math.log(current.unitPrice / previous.unitPrice);
    if (!Number.isFinite(change) || Math.abs(change) / Math.sqrt(days) > 4 * Math.max(priorDailyVolatility, 0.06)) {
      excludedChangeCount += 1;
      continue;
    }
    pairs.push({ drift: change / days, standardized: change / Math.sqrt(days), observedTime: current.observedTime });
  }

  const driftWeights = pairs.map((entry) => elapsedWeight(asOfTime, entry.observedTime, 180));
  const volatilityWeights = pairs.map((entry) => elapsedWeight(asOfTime, entry.observedTime, 60));
  const cardDrift = pairs.length ? weightedMean(pairs.map((entry) => entry.drift), driftWeights) : 0;
  const centered = pairs.map((entry) => entry.standardized - weightedMean(pairs.map((value) => value.standardized), volatilityWeights));
  const cardVariance = pairs.length > 1 ? weightedMean(centered.map((entry) => entry ** 2), volatilityWeights) : priorDailyVolatility ** 2;
  const spanDays = modelObservations.length > 1
    ? (latest.observedTime - modelObservations[0].observedTime) / DAY_MS
    : 0;
  const driftWeight = spanDays / (spanDays + 730);
  const dailyDrift = driftWeight * cardDrift + (1 - driftWeight) * priorDailyDrift;
  const volatilityWeight = pairs.length / (pairs.length + 10);
  const dailyVolatility = clamp(Math.sqrt(volatilityWeight * cardVariance + (1 - volatilityWeight) * priorDailyVolatility ** 2), 0.015, 0.06);
  const horizonDrift = clamp(dailyDrift * selectedHorizon, -0.69 * selectedHorizon / 365, 0.69 * selectedHorizon / 365);
  const horizonVolatility = Math.min(
    dailyVolatility * Math.sqrt(selectedHorizon),
    MAX_HORIZON_VOLATILITY * Math.sqrt(selectedHorizon / 365)
  );
  const values = Object.fromEntries(Object.entries(T_Z).map(([key, z]) => [key, latest.unitPrice * Math.exp(horizonDrift + z * horizonVolatility)]));
  return {
    ...base, status: modelObservations.length < 3 ? 'early' : modelObservations.length < 8 ? 'limited' : 'available',
    ...values, dailyDrift, dailyVolatility, excludedChangeCount,
    reason: modelObservations.length < 3
      ? 'The range is mostly a broad volatility prior until more checks accumulate.'
      : modelObservations.length < 8
        ? 'Limited local history informs this deliberately wide scenario.'
        : 'Local unit-value changes inform volatility; long-run drift stays strongly constrained.',
    nextAction: modelObservations.length < 8 ? 'Record occasional value checks to make the range more card-specific.' : ''
  };
}

export function buildHoldingLocalScenario(holding = {}, observations = [], horizon = 90, options = {}) {
  if (!isManualScenarioSubject(holding)) {
    return {
      kind: 'local-scenario', status: 'unavailable',
      horizon: LOCAL_SCENARIO_HORIZONS.includes(Number(horizon)) ? Number(horizon) : 90,
      observationCount: 0,
      reason: 'Scenarios are available for custom items; this catalog item uses published outlooks when enough evidence is available.',
      nextAction: 'Check this item’s published outlook instead.'
    };
  }
  const subjectId = localScenarioSubject(holding);
  const records = (Array.isArray(observations) ? observations : []).filter((entry) => entry?.subjectId === subjectId);
  if (!records.length) {
    const asOf = new Date(options.asOf || new Date());
    const fallback = localObservationForHolding(holding, Number.isFinite(asOf.valueOf()) ? asOf.toISOString() : new Date().toISOString());
    if (fallback) records.push(fallback);
  }
  return buildLocalScenario(records, horizon, options);
}

export function localPortfolioScenario(holdings = [], observations = [], horizon = 90, options = {}) {
  const targetCurrency = currencyCode(options.currency || 'USD');
  const result = {
    kind: 'local-portfolio-scenario', horizon: LOCAL_SCENARIO_HORIZONS.includes(Number(horizon)) ? Number(horizon) : 90,
    currentValue: 0, q10: 0, q25: 0, q50: 0, q75: 0, q90: 0,
    coveredHoldings: 0, excludedCurrencyHoldings: 0, totalHoldings: holdings.length,
    currency: targetCurrency, rows: []
  };
  for (const holding of holdings) {
    const scenario = buildHoldingLocalScenario(holding, observations, result.horizon, options);
    result.rows.push({ holding, scenario });
    if (!['early', 'limited', 'available'].includes(scenario.status)) continue;
    if (scenario.currency !== targetCurrency) {
      result.excludedCurrencyHoldings += 1;
      continue;
    }
    const count = Math.max(0, finite(holding.quantity) ?? 0);
    if (!count) continue;
    result.currentValue += scenario.observed * count;
    for (const key of ['q10', 'q25', 'q50', 'q75', 'q90']) result[key] += scenario[key] * count;
    result.coveredHoldings += 1;
  }
  return result;
}

export function localPortfolioInsights(holdings = [], currency = 'USD') {
  const rows = holdings.map((holding) => {
    const quantity = Math.max(0, finite(holding.quantity) ?? 0);
    const manual = finite(holding.manualMarketPrice);
    const catalog = catalogPriceForValuation(holding.item);
    const unit = manual ?? catalog ?? 0;
    const valueCurrency = currencyCode(manual !== null ? holding.manualMarketCurrency : holding.item?.currency);
    const value = valueCurrency === currencyCode(currency) ? unit * quantity : 0;
    const costCurrency = currencyCode(holding.purchaseCurrency || holding.item?.currency);
    const cost = costCurrency === currencyCode(currency)
      ? ((finite(holding.purchasePrice) ?? 0) * quantity + (finite(holding.fees) ?? 0)) : 0;
    return { holding, value, cost, gain: value - cost, category: holding.item?.category || 'other' };
  });
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const sorted = rows.filter((row) => row.value > 0).sort((left, right) => right.value - left.value);
  const top = sorted[0] || null;
  const hhi = totalValue > 0 ? sorted.reduce((sum, row) => sum + (row.value / totalValue) ** 2, 0) : 0;
  const topFiveShare = totalValue > 0 ? sorted.slice(0, 5).reduce((sum, row) => sum + row.value, 0) / totalValue : 0;
  return {
    totalValue, totalCost, gain: totalValue - totalCost, hhi, topFiveShare,
    concentration: hhi >= 0.35 || (top && top.value / totalValue >= 0.50) ? 'high' : hhi >= 0.20 ? 'moderate' : 'spread',
    topHolding: top ? { name: top.holding.item?.name || 'Unnamed item', share: top.value / totalValue, value: top.value } : null
  };
}
