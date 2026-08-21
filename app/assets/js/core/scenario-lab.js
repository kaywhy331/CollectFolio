import {
  holdingMarketCurrency,
  holdingPricingStatus,
  unitMarketValue
} from './calculations.js';
import { localScenarioSubject, normalizeLocalObservations } from './local-scenarios.js';

export const SCENARIO_LAB_VERSION = 'assumption-scenario-v1';
export const SCENARIO_DIRECTIONS = Object.freeze(['down', 'unchanged', 'up']);
export const SCENARIO_VOLATILITY = Object.freeze(['low', 'typical', 'high']);
export const SCENARIO_SORTS = Object.freeze(['upside', 'downside', 'uncertainty', 'evidence', 'value']);

const DIRECTION_RATE = Object.freeze({ down: -0.08, unchanged: 0, up: 0.08 });
const ITEM_DIRECTION_RATE = Object.freeze({ down: -0.12, unchanged: 0, up: 0.12 });
const VOLATILITY_WIDTH = Object.freeze({ low: 0.08, typical: 0.16, high: 0.28 });

function normalizedCurrency(value, fallback = 'USD') {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : fallback;
}

function normalizeChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function normalizeScenarioAssumptions(value = {}) {
  return {
    marketDirection: normalizeChoice(value.marketDirection, SCENARIO_DIRECTIONS, 'unchanged'),
    category: String(value.category || ''),
    categoryDirection: normalizeChoice(value.categoryDirection, SCENARIO_DIRECTIONS, 'unchanged'),
    itemId: String(value.itemId || ''),
    itemDirection: normalizeChoice(value.itemDirection, SCENARIO_DIRECTIONS, 'unchanged'),
    volatility: normalizeChoice(value.volatility, SCENARIO_VOLATILITY, 'typical'),
    manualValues: value.manualValues === 'follow' ? 'follow' : 'steady'
  };
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function evidenceFor(observationCount, sourceCount) {
  const level = observationCount >= 8 && sourceCount >= 2
    ? 'Strong evidence'
    : observationCount >= 3 && sourceCount >= 2 ? 'Moderate evidence' : 'Limited evidence';
  const rank = level === 'Strong evidence' ? 3 : level === 'Moderate evidence' ? 2 : 1;
  return {
    level,
    rank,
    detail: `Based on ${observationCount} ${plural(observationCount, 'observation')} from ${sourceCount} ${plural(sourceCount, 'source')}.`
  };
}

function acceptedHoldingRows(holdings, observations, currency, assumptions, horizon) {
  const normalizedObservations = normalizeLocalObservations(observations);
  const horizonScale = Math.min(2, Math.sqrt(horizon / 90));
  const width = Math.min(0.65, VOLATILITY_WIDTH[assumptions.volatility] * horizonScale);
  return holdings.flatMap((holding) => {
    if (holdingPricingStatus(holding) === 'unpriced' || holdingMarketCurrency(holding) !== currency) return [];
    const quantity = Math.max(0, Number(holding.quantity) || 0);
    const unitValue = unitMarketValue(holding);
    if (!(quantity > 0) || !(unitValue >= 0)) return [];
    const currentValue = unitValue * quantity;
    const manual = holdingPricingStatus(holding) === 'manual';
    const categoryApplies = assumptions.category && String(holding.item?.category || '') === assumptions.category;
    const itemApplies = assumptions.itemId && String(holding.id) === assumptions.itemId;
    const followsAssumptions = !manual || assumptions.manualValues === 'follow';
    const direction = followsAssumptions
      ? (DIRECTION_RATE[assumptions.marketDirection]
        + (categoryApplies ? DIRECTION_RATE[assumptions.categoryDirection] : 0)
        + (itemApplies ? ITEM_DIRECTION_RATE[assumptions.itemDirection] : 0)) * horizonScale
      : 0;
    const boundedDirection = Math.max(-0.75, Math.min(1.5, direction));
    const median = Math.max(0, currentValue * (1 + boundedDirection));
    const q25 = Math.max(0, median * (1 - width * 0.5));
    const q75 = median * (1 + width * 0.5);
    const q10 = Math.max(0, median * (1 - width));
    const q90 = median * (1 + width);
    const subject = localScenarioSubject(holding);
    const history = normalizedObservations.filter((entry) => entry.subjectId === subject && entry.currency === currency);
    const sourceNames = new Set(history.map((entry) => entry.sourceLabel || entry.source).filter(Boolean));
    sourceNames.add(manual ? 'Your manual value' : holding.item?.priceSource || holding.item?.provider || 'Catalog value');
    const observationCount = Math.max(1, history.length);
    const evidence = evidenceFor(observationCount, Math.max(1, sourceNames.size));
    return [{
      holding,
      currency,
      currentValue,
      median,
      q10,
      q25,
      q75,
      q90,
      difference: median - currentValue,
      differencePercent: currentValue > 0 ? ((median / currentValue) - 1) * 100 : null,
      uncertainty: q90 - q10,
      evidence,
      observationCount,
      sourceCount: Math.max(1, sourceNames.size),
      sources: [...sourceNames],
      manual,
      applied: {
        market: followsAssumptions ? assumptions.marketDirection : 'unchanged',
        category: categoryApplies && followsAssumptions ? assumptions.categoryDirection : 'unchanged',
        item: itemApplies && followsAssumptions ? assumptions.itemDirection : 'unchanged',
        manualValues: assumptions.manualValues
      }
    }];
  });
}

export function sortScenarioRows(rows = [], sort = 'upside') {
  const selected = SCENARIO_SORTS.includes(sort) ? sort : 'upside';
  const compare = {
    upside: (a, b) => b.difference - a.difference,
    downside: (a, b) => a.difference - b.difference,
    uncertainty: (a, b) => b.uncertainty - a.uncertainty,
    evidence: (a, b) => b.evidence.rank - a.evidence.rank,
    value: (a, b) => b.currentValue - a.currentValue
  }[selected];
  return [...rows].sort((left, right) => compare(left, right)
    || String(left.holding.item?.name || '').localeCompare(String(right.holding.item?.name || '')));
}

export function buildCollectionScenario(holdings = [], observations = [], horizon = 90, options = {}) {
  const selectedHorizon = [7, 30, 90, 180, 365].includes(Number(horizon)) ? Number(horizon) : 90;
  const currency = normalizedCurrency(options.currency);
  const assumptions = normalizeScenarioAssumptions(options.assumptions);
  const rows = acceptedHoldingRows(holdings, observations, currency, assumptions, selectedHorizon);
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  const currentValue = sum('currentValue');
  const median = sum('median');
  const difference = median - currentValue;
  const observationCount = rows.reduce((total, row) => total + row.observationCount, 0);
  const sourceCount = new Set(rows.flatMap((row) => row.sources || [])).size;
  const evidence = evidenceFor(Math.max(0, observationCount), Math.max(1, sourceCount));
  const neutral = Math.abs(difference) < 0.005;
  return {
    kind: 'assumption-scenario',
    modelVersion: SCENARIO_LAB_VERSION,
    calculatedAt: new Date(options.now || Date.now()).toISOString(),
    horizon: selectedHorizon,
    currency,
    assumptions,
    currentValue,
    median,
    q10: sum('q10'),
    q25: sum('q25'),
    q75: sum('q75'),
    q90: sum('q90'),
    difference,
    differencePercent: currentValue > 0 ? (difference / currentValue) * 100 : null,
    differenceLabel: neutral ? 'Unchanged scenario' : '',
    neutral,
    coveredHoldings: rows.length,
    totalHoldings: holdings.length,
    observationCount,
    sourceCount,
    evidence,
    rows
  };
}
