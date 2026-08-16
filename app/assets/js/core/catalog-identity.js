import { normalizeQuery } from './utils.js';
import { canonicalMarketIdentity, canonicalRawMarketCondition } from './market-series.js';

const clean = (value, fallback = '') => normalizeQuery(String(value ?? '').normalize('NFKC')) || fallback;
const segment = (value, fallback = '-') => encodeURIComponent(clean(value, fallback));

export function isUUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

export function catalogReferenceForItem(item = {}, options = {}) {
  const canonicalVariantId = isUUID(options.canonicalVariantId || item.canonicalVariantId)
    ? String(options.canonicalVariantId || item.canonicalVariantId).toLowerCase()
    : '';
  const provider = clean(item.provider || item.category, 'custom');
  const externalId = String(item.externalId || '').trim();
  const language = clean(options.language || item.language, 'en');
  const edition = clean(options.edition || item.edition, 'standard');
  const finish = clean(options.finish || item.finish || item.variant, 'unspecified');
  const conditionClass = clean(options.conditionClass || item.rawConditionClass || item.conditionClass, 'raw');
  const requestedMarketCondition = Object.prototype.hasOwnProperty.call(options, 'marketCondition')
    ? options.marketCondition
    : item.marketCondition;
  const marketCondition = conditionClass === 'raw'
    ? canonicalRawMarketCondition(requestedMarketCondition)
    : canonicalMarketIdentity(requestedMarketCondition);
  const game = clean(item.game || item.category, 'other');

  let watchKey;
  let mappingStatus;
  if (canonicalVariantId) {
    watchKey = marketCondition
      ? `variant:v2:${canonicalVariantId}:${canonicalMarketIdentity(conditionClass)}:${marketCondition}`
      : `variant:${canonicalVariantId}`;
    mappingStatus = 'mapped';
  } else if (externalId) {
    const identity = `${segment(provider)}:${segment(externalId)}:${segment(language)}:${segment(edition)}:${segment(finish)}:${segment(conditionClass)}`;
    watchKey = marketCondition
      ? `source:v2:${identity}:${marketCondition}`
      : `source:v1:${identity}`;
    mappingStatus = 'source_exact';
  } else {
    const identity = `${segment(game)}:${segment(item.setName)}:${segment(item.number)}:${segment(item.name)}:${segment(language)}:${segment(edition)}:${segment(finish)}:${segment(conditionClass)}`;
    watchKey = marketCondition
      ? `catalog:v2:${identity}:${marketCondition}`
      : `catalog:v1:${identity}`;
    mappingStatus = 'identity_only';
  }

  return {
    watchKey,
    canonicalVariantId,
    mappingStatus,
    provider,
    externalId,
    game: item.game || item.category || '',
    category: item.category || 'other',
    name: item.name || 'Unnamed collectible',
    setName: item.setName || '',
    number: item.number || '',
    rarity: item.rarity || '',
    language,
    edition,
    finish,
    conditionClass,
    marketCondition,
    image: item.image || '',
    imageSmall: item.imageSmall || item.image || '',
    currency: item.currency || 'USD',
    price: item.price === '' || item.price === null || item.price === undefined || !Number.isFinite(Number(item.price)) ? null : Number(item.price),
    pricingEntitlement: item.pricingEntitlement || '',
    priceSource: item.priceSource || '',
    priceUpdatedAt: item.priceUpdatedAt || ''
  };
}

export function watchKeyForItem(item, options) {
  return catalogReferenceForItem(item, options).watchKey;
}
