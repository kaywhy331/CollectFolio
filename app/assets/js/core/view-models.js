import { catalogReferenceForItem } from './catalog-identity.js';
import { holdingCostBasis, holdingMarketValue, unitMarketValue } from './calculations.js';
import { normalizeIntelligencePayload } from './intelligence-contract.js';
import { catalogPriceDisclosure, catalogPriceForValuation } from './pricing-policy.js';

export const MATCH_BUCKETS = Object.freeze(['exact', 'likely', 'possible', 'unmatched']);
export const PRICING_STATUSES = Object.freeze(['verified', 'delayed', 'manual', 'pending', 'unsupported', 'unavailable', 'error']);
export const SYNC_STATUSES = Object.freeze(['local', 'syncing', 'synced', 'error']);

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
    confidenceReason: normalized.reasonCodes.join(', '),
    coverageStatus: 'available',
    drivers: [...normalized.drivers.supporting],
    risks: [...normalized.drivers.limiting],
    modelVersion: forecast.modelVersion,
    forecastStatus: 'available',
    createdAt: text(publication.publishedAt, 40),
    maturedAt: '',
    actualValueAtMaturity: null,
    absoluteError: null,
    directionResult: ''
  }));
}

export function searchResultViewModel(item = {}, { publication = null, currency = 'USD' } = {}) {
  const reference = catalogReferenceForItem(item);
  const pricingStatus = pricingStatusFor(item);
  const price = catalogPriceForValuation(item);
  const intelligence = publication ? normalizeIntelligencePayload(publication) : null;
  return {
    id: reference.watchKey,
    canonicalId: reference.canonicalVariantId,
    sourceId: reference.externalId,
    category: reference.category,
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
    currentMarketValue: price,
    currency: reference.currency || currency,
    change7d: intelligence?.trend.return7d ?? null,
    change30d: intelligence?.trend.return30d ?? null,
    priceUpdatedAt: reference.priceUpdatedAt,
    forecastStatus: intelligence && Object.keys(intelligence.forecasts).length ? 'available' : 'unavailable'
  };
}

export function holdingViewModel(holding = {}, { publication = null } = {}) {
  const item = holding.item || {};
  const reference = catalogReferenceForItem(item, {
    canonicalVariantId: holding.canonicalVariantId,
    conditionClass: holding.grade ? 'graded' : 'raw'
  });
  const manualValue = nonNegative(holding.manualMarketPrice);
  const forecasts = publication ? forecastViewModels(publication, { holdingId: holding.id }) : [];
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
  const syncStatus = state.auth?.syncing ? 'syncing' : session ? 'synced' : 'local';
  return {
    portfolioLabel: 'Local portfolio',
    syncStatus,
    syncLabel: syncStatus === 'syncing' ? 'Syncing…' : syncStatus === 'synced' ? 'Cloud sync available' : 'Saved on this device',
    accountLabel: session?.user?.email || 'Settings',
    searchQuery: text(state.search?.query),
    hasUnreadAlerts: false
  };
}
