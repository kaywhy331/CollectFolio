import { catalogReferenceForItem } from '../core/catalog-identity.js';
import { deleteRecordWithTombstone, getAll, putRecordClearingTombstone } from '../core/db.js';
import { canonicalMarketIdentity, canonicalRawMarketCondition } from '../core/market-series.js';
import { normalizeQuery } from '../core/utils.js';

// catalog-v2 B3: search now returns TCGCSV identities for the flagship
// games (services/catalog.js's FLAGSHIP_GAMES), so a card watched via the
// OLD provider-scoped search (pokemon/scryfall/ygoprodeck externalId) has a
// watchKey the new TCGCSV-identified result can never reproduce -- the
// `provider`/`externalId` segments differ even though it's the same
// physical card. This is a deliberate last-resort hop (after the exact and
// legacy-market-condition lookups both miss): a name+set+number+condition
// match against an existing watch that still carries one of the old
// secondary provider identities, so re-watching (or a background sync) of
// the same card via the new search doesn't create a duplicate/orphaned
// entry. Requires both name AND number to agree -- loose enough to bridge
// the provider swap, tight enough not to cross two different cards.
const LEGACY_SEARCH_PROVIDERS = Object.freeze(['pokemon', 'scryfall', 'ygoprodeck']);
const loose = (value) => normalizeQuery(String(value ?? ''));

export function legacyProviderWatchMatch(items = [], item = {}, options = {}) {
  if (item?.provider !== 'tcgcsv') return null;
  const name = loose(item.name);
  const number = loose(item.number);
  if (!name || !number) return null;
  const setName = loose(item.setName);
  const conditionClass = loose(options.conditionClass || item.rawConditionClass || item.conditionClass || 'raw');
  return items.find((entry) => {
    const ref = entry?.catalogRef || {};
    return LEGACY_SEARCH_PROVIDERS.includes(ref.provider)
      && loose(ref.conditionClass || 'raw') === conditionClass
      && loose(ref.name) === name
      && loose(ref.number) === number
      && loose(ref.setName) === setName;
  }) || null;
}

const nonNegativeOrBlank = (value) => value === '' || value === null || value === undefined
  ? ''
  : Math.max(0, Number(value) || 0);
const currency = (value, fallback = 'USD') => {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
};

export function createWatchlistItem(item, options = {}, existing = null, now = new Date().toISOString()) {
  const provisionalRef = catalogReferenceForItem(item, options);
  const conditionClass = canonicalMarketIdentity(options.conditionClass || provisionalRef.conditionClass || 'raw');
  const requestedMarketCondition = Object.prototype.hasOwnProperty.call(options, 'marketCondition')
    ? options.marketCondition
    : existing?.marketCondition || provisionalRef.marketCondition;
  const marketCondition = conditionClass === 'graded'
    ? canonicalMarketIdentity(requestedMarketCondition)
    : canonicalRawMarketCondition(requestedMarketCondition);
  const catalogRef = catalogReferenceForItem(item, {
    ...options,
    conditionClass,
    marketCondition
  });
  const previousCondition = canonicalMarketIdentity(existing?.marketCondition);
  return {
    id: catalogRef.watchKey,
    watchKey: catalogRef.watchKey,
    canonicalVariantId: catalogRef.canonicalVariantId,
    catalogRef,
    marketCondition,
    targetPrice: nonNegativeOrBlank(options.targetPrice ?? existing?.targetPrice),
    targetCurrency: currency(options.targetCurrency || existing?.targetCurrency || catalogRef.currency),
    alertPercentChange: nonNegativeOrBlank(options.alertPercentChange ?? existing?.alertPercentChange),
    alertTrendChange: Boolean(options.alertTrendChange ?? existing?.alertTrendChange),
    alertRangeChange: Boolean(options.alertRangeChange ?? existing?.alertRangeChange),
    alertForecastChange: Boolean(options.alertForecastChange ?? existing?.alertForecastChange),
    intelligenceBaseline: previousCondition === marketCondition
      ? existing?.intelligenceBaseline || null
      : null,
    notes: String(options.notes ?? existing?.notes ?? '').slice(0, 2000),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    dirty: true
  };
}

export async function watchItem(item, options = {}) {
  const items = await getAll('watchlistItems');
  const replacementKey = String(options.replacesWatchKey || '');
  const replacement = items.find((entry) => replacementKey && entry.watchKey === replacementKey) || null;
  const provisional = createWatchlistItem(item, options, replacement);
  const existing = items.find((entry) => entry.watchKey === provisional.watchKey) || replacement;
  const value = createWatchlistItem(item, options, existing);
  const superseded = new Map([replacement, existing]
    .filter((entry) => entry?.id && entry.id !== value.id)
    .map((entry) => [entry.id, entry]));
  for (const entry of superseded.values()) {
    await deleteRecordWithTombstone(
      'watchlistItems', 'watchlistDeletions', entry.id,
      value.updatedAt, entry.watchKey
    );
  }
  await putRecordClearingTombstone('watchlistItems', 'watchlistDeletions', value);
  return value;
}

export async function unwatchItem(watchKey) {
  const existing = (await getAll('watchlistItems')).find((entry) => entry.watchKey === watchKey || entry.id === watchKey);
  await deleteRecordWithTombstone('watchlistItems', 'watchlistDeletions', existing?.id || watchKey, new Date().toISOString(), watchKey);
}

export function findWatchedItem(items = [], item, options) {
  const reference = catalogReferenceForItem(item, options);
  const exact = items.find((entry) => entry.watchKey === reference.watchKey);
  if (exact) return exact;

  const legacyReference = catalogReferenceForItem(item, {
    ...options,
    canonicalVariantId: reference.canonicalVariantId,
    conditionClass: reference.conditionClass,
    marketCondition: ''
  });
  const legacy = items.find((entry) => entry.watchKey === legacyReference.watchKey);
  if (legacy || reference.marketCondition) return legacy || legacyProviderWatchMatch(items, item, options);

  return items
    .filter((entry) => catalogReferenceForItem(entry.catalogRef || {}, {
      canonicalVariantId: entry.canonicalVariantId || entry.catalogRef?.canonicalVariantId,
      conditionClass: entry.catalogRef?.conditionClass || 'raw',
      marketCondition: ''
    }).watchKey === legacyReference.watchKey)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
      || String(left.watchKey || '').localeCompare(String(right.watchKey || '')))[0]
    || legacyProviderWatchMatch(items, item, options);
}

export function mergeWatchlistTombstones(...sets) {
  const merged = new Map();
  for (const tombstone of sets.flat()) {
    if (!tombstone?.id) continue;
    const current = merged.get(tombstone.id);
    if (!current || String(tombstone.deletedAt || '') > String(current.deletedAt || '')) {
      merged.set(tombstone.id, { ...tombstone });
    }
  }
  return [...merged.values()];
}

export function mergeWatchlistItems(local = [], remote = [], deletedKeys = new Set()) {
  const merged = new Map();
  for (const entry of [...local, ...remote]) {
    const key = entry?.watchKey || entry?.id;
    if (!key || deletedKeys.has(key)) continue;
    const current = merged.get(key);
    if (!current || String(entry.updatedAt || '') > String(current.updatedAt || '')) {
      merged.set(key, { ...entry, id: key, watchKey: key });
    }
  }
  return [...merged.values()];
}
