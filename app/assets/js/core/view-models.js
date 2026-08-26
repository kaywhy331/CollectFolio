import { catalogReferenceForItem } from './catalog-identity.js';
import { holdingCostBasis, holdingMarketValue, unitMarketValue } from './calculations.js';
import { normalizeIntelligencePayload } from './intelligence-contract.js';
import { catalogPriceDisclosure, catalogPriceForValuation } from './pricing-policy.js';
import { selectPublicationForCatalogItem, selectPublicationForHolding } from './market-series.js';

export const MATCH_BUCKETS = Object.freeze(['exact', 'likely', 'possible', 'unmatched']);
export const PRICING_STATUSES = Object.freeze(['verified', 'delayed', 'manual', 'pending', 'unsupported', 'unavailable', 'error']);
export const SYNC_STATUSES = Object.freeze(['local', 'pending', 'syncing', 'synced', 'offline', 'error']);

const finite = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value)
  : null;
const nonNegative = (value) => {
  const number = finite(value);
  return number === null ? null : Math.max(0, number);
};
const text = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function matchBucketFor(item = {}) {
  const reference = catalogReferenceForItem(item);
  const requested = text(item.matchBucket, 20).toLowerCase();
  if (MATCH_BUCKETS.includes(requested)) {
    if (requested !== 'exact') return requested;
    return ['mapped', 'source_exact'].includes(reference.mappingStatus) ? 'exact' : 'likely';
  }
  const score = finite(item.matchScore);
  if (score === null || score <= 0) return 'unmatched';
  return score >= 0.72 ? 'likely' : 'possible';
}

export function pricingStatusFor(item = {}, manualValue = null) {
  if (finite(manualValue) !== null) return 'manual';
  if (item.pricingStatus === 'error' || item.pricingError) return 'error';
  if (catalogPriceDisclosure(item)) return 'unsupported';
  const price = catalogPriceForValuation(item);
  if (price !== null) {
    if (item.pricingStatus === 'delayed') return 'delayed';
    return item.priceSource && item.priceUpdatedAt ? 'verified' : 'pending';
  }
  return item.pricingStatus === 'pending' ? 'pending' : 'unavailable';
}

export function forecastViewModels(publication = {}, { holdingId = '' } = {}) {
  const normalized = normalizeIntelligencePayload(publication);
  if (normalized.supportTier < 4) return [];
  return Object.values(normalized.forecasts).map((forecast) => ({
    forecastId: [normalized.variantId, forecast.horizon, publication.publishedAt, forecast.modelVersion].filter(Boolean).join(':'),
    canonicalId: normalized.variantId,
    holdingId: text(holdingId, 160),
    horizon: forecast.horizon,
    asOfDate: text(publication.publishedAt, 40),
    maturityDate: forecast.maturesAt,
    lowerBound: forecast.q10,
    expectedValue: forecast.q50,
    upperBound: forecast.q90,
    currency: normalized.observed?.currency || 'USD',
    confidenceLabel: forecast.confidence === null ? '' : `${Math.round(forecast.confidence)} / 100`,
    confidenceReason: forecast.confidenceReason || normalized.reasonCodes.join(', '),
    coverageStatus: forecast.coverageStatus || forecast.forecastStatus,
    drivers: [...normalized.drivers.supporting],
    risks: [...normalized.drivers.limiting],
    modelVersion: forecast.modelVersion,
    forecastStatus: forecast.forecastStatus,
    createdAt: text(publication.publishedAt, 40),
    maturedAt: forecast.maturedAt,
    actualValueAtMaturity: forecast.actualValueAtMaturity,
    absoluteError: forecast.absoluteError,
    directionResult: forecast.directionResult
  }));
}

// `trajectoryEstimates` is the plain {30/60/90: estimate|undefined}
// estimate|undefined} shape produced by
// services/forecast-trajectory.js's trajectoryForecastEstimates(packet).
// It is passed in already computed (rather than fetched in here) so this
// module stays synchronous and doesn't reach up into services/ -- core/
// is depended on by services/, never the other way around. Cloud-published
// published intelligence, where present for a horizon, always wins over a
// trajectory-v1.1 estimate for the same horizon; trajectory only fills a
// horizon the cloud-published forecast doesn't cover, and it never
// produces 180d/365d, so those horizons are untouched by this fallback.
export function searchResultViewModel(item = {}, { publication = null, currency = 'USD', trajectoryEstimates = null } = {}) {
  const reference = catalogReferenceForItem(item);
  const price = catalogPriceForValuation(item);
  const selected = selectPublicationForCatalogItem(publication, item, currency);
  const intelligence = selected ? normalizeIntelligencePayload(selected) : null;
  const forecastBasis = intelligence?.observed?.price ?? null;
  const currentMarketValue = price ?? forecastBasis;
  const pricingStatus = price === null && forecastBasis !== null
    ? 'verified'
    : pricingStatusFor(item);
  const forecastFor = (horizon) => {
    const forecast = intelligence?.forecasts?.[horizon];
    if (forecast) {
      return {
        horizon,
        estimatedValue: forecast.q50,
        lowerBound: forecast.q10,
        upperBound: forecast.q90,
        estimatedChange: forecastBasis > 0 ? forecast.q50 / forecastBasis - 1 : null,
        baselineValue: forecastBasis > 0 ? forecastBasis : null,
        baselineDate: intelligence?.observed?.observedAt?.slice(0, 10) || '',
        probabilityUp: forecast.probabilityUp,
        confidence: forecast.confidence,
        status: forecast.forecastStatus,
        maturesAt: forecast.maturesAt,
        modelVersion: forecast.modelVersion
      };
    }
    const trajectory = trajectoryEstimates?.[horizon];
    if (!trajectory) return null;
    return {
      horizon,
      estimatedValue: trajectory.estimatedValue,
      lowerBound: trajectory.lowerBound,
      upperBound: trajectory.upperBound,
      estimatedChange: trajectory.estimatedChange,
      baselineValue: trajectory.baselineValue,
      baselineDate: trajectory.baselineDate,
      probabilityUp: null,
      confidence: trajectory.confidence,
      evidenceTier: trajectory.evidenceTier,
      horizonDaysActual: trajectory.horizonDaysActual,
      status: trajectory.evidenceTier === 'attribute-reference'
        ? 'reference-range'
        : trajectory.evidenceTier === 'range-only'
          ? 'range-only'
          : 'trajectory',
      maturesAt: null,
      modelVersion: trajectory.modelVersion
    };
  };
  const forecast30d = forecastFor(30);
  const forecast60d = forecastFor(60);
  const forecast90d = forecastFor(90);
  const forecast180d = forecastFor(180);
  const forecast365d = forecastFor(365);
  const type = Array.isArray(item.types)
    ? item.types.map((entry) => text(entry, 80)).filter(Boolean).join(' · ')
    : text(item.type || item.supertype || item.cardType, 160);
  return {
    id: reference.watchKey,
    canonicalId: reference.canonicalVariantId,
    sourceId: reference.externalId,
    category: reference.category,
    game: reference.game,
    type,
    name: reference.name,
    setName: reference.setName,
    setCode: text(item.setCode, 80),
    cardNumber: reference.number,
    variant: reference.finish,
    language: reference.language,
    rarity: reference.rarity,
    year: text(item.year, 20),
    imageUrl: reference.imageSmall || reference.image,
    matchBucket: matchBucketFor(item),
    pricingStatus,
    currentMarketValue,
    currency: reference.currency || currency,
    change7d: intelligence?.trend.return7d ?? null,
    change30d: intelligence?.trend.return30d ?? null,
    priceUpdatedAt: price === null && forecastBasis !== null
      ? intelligence.observed.observedAt
      : reference.priceUpdatedAt,
    priceSource: price === null && forecastBasis !== null
      ? intelligence.observed.source
      : reference.priceSource,
    forecastStatus: (intelligence && Object.keys(intelligence.forecasts).length) || forecast30d || forecast60d || forecast90d ? 'available' : 'unavailable',
    forecast30d,
    forecast60d,
    forecast90d,
    forecast180d,
    forecast365d,
    forecastEstimates: {
      30: forecast30d,
      60: forecast60d,
      90: forecast90d,
      180: forecast180d,
      365: forecast365d
    }
  };
}

export function holdingViewModel(holding = {}, { publication = null } = {}) {
  const item = holding.item || {};
  const reference = catalogReferenceForItem(item, {
    canonicalVariantId: holding.canonicalVariantId,
    conditionClass: holding.grade ? 'graded' : 'raw',
    marketCondition: holding.grade
      ? `${holding.gradeCompany || 'unknown'}-${holding.grade || 'ungraded'}`
      : holding.marketCondition || ''
  });
  const manualValue = nonNegative(holding.manualMarketPrice);
  const selected = selectPublicationForHolding(
    publication,
    holding,
    holding.manualMarketCurrency || item.currency || 'USD'
  );
  const forecasts = selected ? forecastViewModels(selected, { holdingId: holding.id }) : [];
  return {
    holdingId: text(holding.id, 160),
    canonicalId: reference.canonicalVariantId,
    portfolioId: text(holding.portfolioId, 160),
    quantity: nonNegative(holding.quantity) ?? 0,
    condition: text(holding.condition, 80),
    grade: text(holding.grade, 40),
    gradingCompany: text(holding.gradeCompany, 80),
    purchasePrice: nonNegative(holding.purchasePrice),
    fees: nonNegative(holding.fees) ?? 0,
    purchaseDate: text(holding.purchaseDate, 40),
    seller: text(holding.seller, 160),
    storageLocation: text(holding.folder || holding.storageLocation, 160),
    notes: text(holding.notes, 2000),
    manualValue,
    manualValueDate: text(holding.manualValueDate || holding.updatedAt, 40),
    valueSource: pricingStatusFor(item, manualValue),
    unitValue: unitMarketValue(holding),
    marketValue: holdingMarketValue(holding),
    costBasis: holdingCostBasis(holding),
    createdAt: text(holding.createdAt, 40),
    updatedAt: text(holding.updatedAt, 40),
    syncStatus: SYNC_STATUSES.includes(holding.syncStatus) ? holding.syncStatus : 'local',
    forecasts
  };
}

export function shellViewModel(state = {}) {
  const session = state.auth?.session;
  const online = state.auth?.online !== false;
  const pending = Math.max(0, Number(state.auth?.pendingChanges) || 0);
  const syncStatus = !online
    ? 'offline'
    : state.auth?.syncing
      ? 'syncing'
      : state.auth?.error
        ? 'error'
        : !session
          ? 'local'
          : pending > 0 || !state.settings?.lastSyncedAt
            ? 'pending'
            : 'synced';
  const labels = {
    local: 'Saved on this device',
    pending: pending ? `${pending} change${pending === 1 ? '' : 's'} waiting to sync` : 'Ready to sync',
    syncing: 'Syncing…',
    synced: 'Synced',
    offline: session && pending ? `Offline · ${pending} change${pending === 1 ? '' : 's'} waiting` : 'Offline · local access available',
    error: 'Sync needs attention'
  };
  return {
    portfolioLabel: text(state.settings?.collectionName, 80) || 'Personal Collection',
    syncStatus,
    syncLabel: labels[syncStatus],
    accountLabel: session?.user?.email || 'Settings',
    searchQuery: text(state.search?.query),
    hasUnreadAlerts: (state.alerts || []).some((alert) => !alert.readAt && !alert.mutedAt)
  };
}
