import { FORECAST_HORIZONS, normalizeIntelligencePayload } from './intelligence-contract.js';
import { holdingMarketValue, portfolioSummary } from './calculations.js';

export const INSIGHTS_VIEWS = Object.freeze(['performance', 'forecasts', 'alerts', 'track-record']);
export const INSIGHTS_HORIZONS = FORECAST_HORIZONS;

const finite = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value)
  : null;
const hasManualValue = (holding = {}) => finite(holding.manualMarketPrice) !== null;
const quantity = (holding = {}) => Math.max(0, finite(holding.quantity) ?? 0);
const normalizedCurrency = (value, fallback = 'USD') => /^[A-Z]{3}$/.test(String(value || '').toUpperCase())
  ? String(value).toUpperCase()
  : fallback;

function rawPublicationFor(byVariant = {}, variantId = '') {
  if (!variantId) return null;
  return byVariant[variantId] || byVariant[String(variantId).toLowerCase()] || null;
}

const REASON_COPY = Object.freeze({
  insufficient_history: 'Pricing history is too limited for this forecast.',
  insufficient_sales: 'Recent verified sales are insufficient.',
  mapping_pending: 'The exact variant is awaiting verification.',
  exact_mapping_required: 'The exact variant is awaiting verification.',
  unsupported_category: 'This category is not supported yet.',
  manual_value: 'This holding uses a manual value.',
  rights_restricted: 'The required market evidence is not approved for public display.',
  model_not_approved: 'The model has not passed the publication review for this horizon.',
  forecast_unavailable: 'No approved forecast is available for this item.'
});

export function customerReason(code = '') {
  const normalized = String(code || '').trim().toLowerCase();
  if (!normalized) return '';
  return REASON_COPY[normalized]
    || `${normalized.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase())}.`;
}

function publishedReason(publication, fallback) {
  return publication.reasonCodes.map(customerReason).find(Boolean) || fallback;
}

export function forecastAvailabilityForHolding(holding = {}, rawPublication = null, horizon = 90, {
  publicEnabled = true,
  currency = 'USD'
} = {}) {
  const selectedHorizon = INSIGHTS_HORIZONS.includes(Number(horizon)) ? Number(horizon) : 90;
  if (!publicEnabled) return {
    status: 'unavailable', reason: 'Public forecasting is disabled until every publication gate passes.',
    nextAction: 'You can still track the holding and use a manual value.', selectedHorizon,
    publication: null, forecast: null, availableHorizons: []
  };
  if (!holding.canonicalVariantId) return {
    status: 'unavailable', reason: 'The exact variant is awaiting verification.',
    nextAction: 'Review the card identity before using market intelligence.', selectedHorizon,
    publication: null, forecast: null, availableHorizons: []
  };
  if (hasManualValue(holding)) return {
    status: 'unavailable', reason: 'This holding uses a manual value.',
    nextAction: 'The manual value remains in current portfolio totals but is excluded from forecasts.', selectedHorizon,
    publication: rawPublication ? normalizeIntelligencePayload(rawPublication) : null,
    forecast: null, availableHorizons: []
  };
  if (!rawPublication) return {
    status: 'unavailable', reason: 'No approved intelligence publication exists for this exact variant.',
    nextAction: 'Keep the holding mapped and check again after a reviewed publication is released.', selectedHorizon,
    publication: null, forecast: null, availableHorizons: []
  };

  const publication = normalizeIntelligencePayload(rawPublication);
  const availableHorizons = Object.keys(publication.forecasts).map(Number).sort((left, right) => left - right);
  if (publication.observed && normalizedCurrency(publication.observed.currency) !== normalizedCurrency(currency)) return {
    status: 'unavailable', reason: `${publication.observed.currency} cannot be combined with ${normalizedCurrency(currency)} without an approved conversion rate.`,
    nextAction: 'View this product separately; portfolio forecast totals never guess currency conversion.', selectedHorizon,
    publication, forecast: null, availableHorizons
  };
  if (publication.supportTier < 4 || !availableHorizons.length) return {
    status: 'unavailable',
    reason: publishedReason(publication, publication.supportTier < 2
      ? 'Pricing history is too limited for a forecast.'
      : 'Recent evidence is insufficient for an approved forecast.'),
    nextAction: 'Current approved values and historical movement remain separate and usable when available.',
    selectedHorizon, publication, forecast: null, availableHorizons
  };
  const forecast = publication.forecasts[selectedHorizon] || null;
  if (!forecast) return {
    status: 'unavailable', reason: `No approved ${selectedHorizon}-day forecast has been published for this exact variant.`,
    nextAction: availableHorizons.length
      ? `Choose an available horizon: ${availableHorizons.map((value) => `${value} days`).join(', ')}.`
      : 'Check again after a horizon-specific model passes review.',
    selectedHorizon, publication, forecast: null, availableHorizons
  };
  return {
    status: forecast.forecastStatus === 'limited' ? 'limited' : 'available',
    reason: forecast.forecastStatus === 'limited'
      ? forecast.confidenceReason || 'The approved publication labels this forecast as limited.'
      : '',
    nextAction: '', selectedHorizon, publication, forecast, availableHorizons
  };
}

export function confidencePresentation(forecast = null, publication = null) {
  if (!forecast) return { label: 'Unavailable', reason: 'No approved confidence was published.' };
  const score = finite(forecast.confidence);
  const status = forecast.forecastStatus === 'limited' ? 'Limited' : 'Published';
  const reason = forecast.confidenceReason
    || publication?.reasonCodes?.map(customerReason).find(Boolean)
    || 'No additional confidence explanation was included in the approved publication.';
  return { label: score === null ? `${status} · score not disclosed` : `${status} · ${Math.round(score)}/100`, reason };
}

export function portfolioForecastSummary(holdings = [], byVariant = {}, horizon = 90, {
  publicEnabled = true,
  currency = 'USD'
} = {}) {
  const local = portfolioSummary(holdings, { currency });
  const result = {
    horizon: INSIGHTS_HORIZONS.includes(Number(horizon)) ? Number(horizon) : 90,
    currentPortfolioValue: local.marketValue,
    approvedCurrentValue: 0,
    lowerBound: 0,
    expectedValue: 0,
    upperBound: 0,
    coveredHoldings: 0,
    limitedHoldings: 0,
    totalHoldings: holdings.length,
    asOfDate: '',
    modelUpdateDate: '',
    confidenceLabel: 'Unavailable',
    confidenceReason: 'No approved forecast contributes to this summary.',
    rows: []
  };
  const dates = [];
  const modelDates = [];
  const confidenceScores = [];
  let undisclosedConfidence = false;

  for (const holding of holdings) {
    const raw = rawPublicationFor(byVariant, holding.canonicalVariantId);
    const availability = forecastAvailabilityForHolding(holding, raw, result.horizon, { publicEnabled, currency });
    result.rows.push({ holding, ...availability });
    if (!['available', 'limited'].includes(availability.status)) continue;
    const count = quantity(holding);
    const { publication, forecast } = availability;
    if (!publication.observed || !count) continue;
    result.approvedCurrentValue += publication.observed.price * count;
    result.lowerBound += forecast.q25 * count;
    result.expectedValue += forecast.q50 * count;
    result.upperBound += forecast.q75 * count;
    result.coveredHoldings += 1;
    if (availability.status === 'limited') result.limitedHoldings += 1;
    if (publication.publishedAt) dates.push(publication.publishedAt);
    if (forecast.modelUpdatedAt || publication.publishedAt) modelDates.push(forecast.modelUpdatedAt || publication.publishedAt);
    if (forecast.confidence === null) undisclosedConfidence = true;
    else confidenceScores.push(forecast.confidence);
  }

  if (dates.length) result.asOfDate = [...dates].sort()[0];
  if (modelDates.length) result.modelUpdateDate = [...modelDates].sort().at(-1);
  if (result.coveredHoldings) {
    if (undisclosedConfidence) result.confidenceLabel = 'Varies · some scores undisclosed';
    else {
      const low = Math.round(Math.min(...confidenceScores));
      const high = Math.round(Math.max(...confidenceScores));
      result.confidenceLabel = low === high ? `Published ${low}/100` : `Published range ${low}–${high}/100`;
    }
    result.confidenceReason = result.limitedHoldings
      ? `${result.limitedHoldings} covered holding${result.limitedHoldings === 1 ? '' : 's'} uses an explicitly limited forecast.`
      : 'Portfolio confidence is not averaged; the displayed span preserves the published item-level scores.';
  }
  return result;
}

export function forecastAssets(holdings = [], watchlistItems = [], byVariant = {}, horizon = 90, options = {}) {
  const assets = holdings.map((holding) => {
    const raw = rawPublicationFor(byVariant, holding.canonicalVariantId);
    return {
      key: `holding:${holding.id}`,
      item: holding.item || {},
      holding,
      holdingId: holding.id,
      watchKey: '',
      quantity: quantity(holding),
      context: 'Owned holding',
      ...forecastAvailabilityForHolding(holding, raw, horizon, options)
    };
  });
  const represented = new Set(holdings.map((holding) => String(holding.canonicalVariantId || '').toLowerCase()).filter(Boolean));
  for (const entry of watchlistItems) {
    const variantId = String(entry.canonicalVariantId || '').toLowerCase();
    if (variantId && represented.has(variantId)) continue;
    const syntheticHolding = { canonicalVariantId: entry.canonicalVariantId, item: entry.catalogRef || {}, quantity: 1, manualMarketPrice: '' };
    const raw = rawPublicationFor(byVariant, entry.canonicalVariantId);
    assets.push({
      key: `watch:${entry.watchKey}`,
      item: entry.catalogRef || {},
      holding: null,
      holdingId: '',
      watchKey: entry.watchKey,
      quantity: 1,
      context: 'Watchlist item',
      ...forecastAvailabilityForHolding(syntheticHolding, raw, horizon, options)
    });
  }
  return assets.sort((left, right) => {
    const rank = { available: 0, limited: 1, unavailable: 2 };
    return rank[left.status] - rank[right.status]
      || String(left.item?.name || '').localeCompare(String(right.item?.name || ''));
  });
}

function historyPublicationList(records = [], currentByVariant = {}) {
  const publications = [
    ...records.map((record) => record?.value || record).filter(Boolean),
    ...Object.values(currentByVariant || {})
  ];
  const unique = new Map();
  for (const publication of publications) {
    if (!publication?.variantId || !publication?.publishedAt) continue;
    const normalized = normalizeIntelligencePayload(publication);
    for (const forecast of Object.values(normalized.forecasts)) {
      const forecastId = [normalized.variantId, forecast.horizon, publication.publishedAt, forecast.modelVersion].join(':');
      if (!unique.has(forecastId)) unique.set(forecastId, { forecastId, raw: publication, publication: normalized, forecast });
    }
  }
  return [...unique.values()];
}

export function predictionHistoryModels(records = [], currentByVariant = {}, now = new Date()) {
  const currentTime = new Date(now).valueOf();
  const values = historyPublicationList(records, currentByVariant);
  const groups = new Map();
  for (const value of values) {
    const key = `${value.publication.variantId}:${value.forecast.horizon}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  const result = [];
  for (const group of groups.values()) {
    group.sort((left, right) => String(left.raw.publishedAt).localeCompare(String(right.raw.publishedAt)));
    group.forEach((value, index) => {
      const previous = group[index - 1] || null;
      const forecast = value.forecast;
      const evaluationComplete = Boolean(
        forecast.maturedAt && forecast.actualValueAtMaturity !== null
        && forecast.absoluteError !== null && forecast.directionResult
      );
      const maturityTime = Date.parse(forecast.maturesAt);
      const status = evaluationComplete
        ? 'matured'
        : Number.isFinite(maturityTime) && maturityTime <= currentTime ? 'awaiting-evaluation' : 'open';
      const derivedChange = !previous
        ? 'First archived forecast for this item and horizon.'
        : previous.forecast.q50 === forecast.q50 && previous.forecast.q25 === forecast.q25 && previous.forecast.q75 === forecast.q75
          ? 'No likely-range change from the previous archived forecast.'
          : 'Published midpoint or likely range changed from the previous archived forecast.';
      result.push({
        forecastId: value.forecastId,
        canonicalId: value.publication.variantId,
        horizon: forecast.horizon,
        asOfDate: value.raw.publishedAt,
        maturityDate: forecast.maturesAt,
        lowerBound: forecast.q25,
        expectedValue: forecast.q50,
        upperBound: forecast.q75,
        currency: value.publication.observed?.currency || 'USD',
        confidence: forecast.confidence,
        modelVersion: forecast.modelVersion,
        previousForecastId: previous?.forecastId || '',
        whatChanged: forecast.whatChanged || derivedChange,
        status,
        maturedAt: forecast.maturedAt,
        actualValueAtMaturity: forecast.actualValueAtMaturity,
        absoluteError: forecast.absoluteError,
        directionResult: forecast.directionResult
      });
    });
  }
  return result.sort((left, right) => String(right.asOfDate).localeCompare(String(left.asOfDate)) || left.horizon - right.horizon);
}

export function publishedScorecards(byVariant = {}) {
  const unique = new Map();
  for (const raw of Object.values(byVariant || {})) {
    const publication = normalizeIntelligencePayload(raw);
    if (publication.supportTier < 5) continue;
    for (const scorecard of publication.scorecards) {
      const key = [scorecard.modelVersion, scorecard.cohort, scorecard.horizonDays].join(':');
      if (!unique.has(key)) unique.set(key, { ...scorecard, publishedAt: publication.publishedAt });
    }
  }
  return [...unique.values()].sort((left, right) => left.horizonDays - right.horizonDays || left.cohort.localeCompare(right.cohort));
}

export function alertHistoryModels(alerts = [], watchlistItems = [], filter = 'all') {
  const watchlist = new Map(watchlistItems.map((entry) => [entry.watchKey, entry]));
  return alerts.map((alert) => {
    const watched = watchlist.get(alert.watchKey) || null;
    return {
      ...alert,
      watched,
      item: watched?.catalogRef || {},
      unread: !alert.readAt,
      muted: Boolean(alert.mutedAt),
      system: String(alert.kind || '').startsWith('sync_') || String(alert.kind || '').startsWith('system_')
    };
  }).filter((alert) => {
    if (filter === 'unread') return alert.unread && !alert.muted;
    if (filter === 'muted') return alert.muted;
    return true;
  }).sort((left, right) => String(right.triggeredAt || '').localeCompare(String(left.triggeredAt || '')));
}

export function performanceValueBreakdown(holdings = [], currency = 'USD') {
  return holdings.reduce((result, holding) => {
    const value = holdingMarketValue(holding, currency);
    const rawValue = holdingMarketValue(holding);
    if (rawValue > 0 && value === 0) {
      result.excludedHoldings += 1;
      return result;
    }
    if (hasManualValue(holding)) {
      result.manualHoldings += 1;
      result.manualValue += value;
    } else if (value > 0) {
      result.marketHoldings += 1;
      result.marketValue += value;
    } else result.unpricedHoldings += 1;
    return result;
  }, { marketHoldings: 0, manualHoldings: 0, unpricedHoldings: 0, excludedHoldings: 0, marketValue: 0, manualValue: 0 });
}
