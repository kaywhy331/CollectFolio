import { catalogReferenceForItem, watchKeyForItem } from '../core/catalog-identity.js';
import { deleteRecordWithTombstone, getAll, putRecordClearingTombstone } from '../core/db.js';

const nonNegativeOrBlank = (value) => value === '' || value === null || value === undefined
  ? ''
  : Math.max(0, Number(value) || 0);

export function createWatchlistItem(item, options = {}, existing = null, now = new Date().toISOString()) {
  const catalogRef = catalogReferenceForItem(item, options);
  return {
    id: catalogRef.watchKey,
    watchKey: catalogRef.watchKey,
    canonicalVariantId: catalogRef.canonicalVariantId,
    catalogRef,
    targetPrice: nonNegativeOrBlank(options.targetPrice ?? existing?.targetPrice),
    alertPercentChange: nonNegativeOrBlank(options.alertPercentChange ?? existing?.alertPercentChange),
    alertTrendChange: Boolean(options.alertTrendChange ?? existing?.alertTrendChange),
    alertRangeChange: Boolean(options.alertRangeChange ?? existing?.alertRangeChange),
    alertForecastChange: Boolean(options.alertForecastChange ?? existing?.alertForecastChange),
    intelligenceBaseline: existing?.intelligenceBaseline || null,
    notes: String(options.notes ?? existing?.notes ?? '').slice(0, 2000),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    dirty: true
  };
}

export async function watchItem(item, options = {}) {
  const watchKey = watchKeyForItem(item, options);
  const existing = (await getAll('watchlistItems')).find((entry) => entry.watchKey === watchKey);
  const value = createWatchlistItem(item, options, existing);
  await putRecordClearingTombstone('watchlistItems', 'watchlistDeletions', value);
  return value;
}

export async function unwatchItem(watchKey) {
  await deleteRecordWithTombstone('watchlistItems', 'watchlistDeletions', watchKey);
}

export function findWatchedItem(items = [], item, options) {
  const key = watchKeyForItem(item, options);
  return items.find((entry) => entry.watchKey === key) || null;
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
