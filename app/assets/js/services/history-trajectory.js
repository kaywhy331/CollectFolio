// 0.8.17: TCGCSV weekly price-history hydration.
//
// Reads the publication artifacts the analytics publish-history CLI
// slices onto the worker (`GET /catalog/history/<categoryId>/<groupId>
// [.partN]` and `GET /catalog/history/manifest`) -- observed data, not a
// model prediction, so unlike trajectory-v1 forecasts there is no
// eligibility gate: a group simply absent from R2 (never uploaded, or an
// unrecognized category/group) is the only "no history" state.
//
// Same TCGCSV identity as forecast-trajectory.js: (categoryId, groupId,
// productId, subTypeName), not the app's canonical variant UUID.
import { getRecord, putRecord } from '../core/db.js';
import { requestTCGCSVCatalog } from './providers/tcgcsv.js';

const CACHE_PREFIX = 'history:v1:';
const MANIFEST_CACHE_MS = 6 * 60 * 60 * 1000;
const GROUP_CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_PARTS = 64;
const requestsInFlight = new Map();

function manifestCacheKey() {
  return `${CACHE_PREFIX}manifest`;
}

function groupCacheKey(categoryId, groupId) {
  return `${CACHE_PREFIX}group:${categoryId}:${groupId}`;
}

async function cached(key, ttlMs, loader) {
  if (requestsInFlight.has(key)) return requestsInFlight.get(key);
  const request = (async () => {
    const record = await getRecord('catalogCache', key).catch(() => null);
    if (record?.expiresAt > Date.now() && record.value) return record.value;
    const value = await loader();
    await putRecord('catalogCache', { key, expiresAt: Date.now() + ttlMs, value }).catch(() => {});
    return value;
  })();
  requestsInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (requestsInFlight.get(key) === request) requestsInFlight.delete(key);
  }
}

export async function fetchHistoryManifest({ session, fetchImpl, bypassCache = false } = {}) {
  const load = () => requestTCGCSVCatalog('/catalog/history/manifest', { session, fetchImpl });
  if (bypassCache) {
    const value = await load();
    await putRecord('catalogCache', { key: manifestCacheKey(), expiresAt: Date.now() + MANIFEST_CACHE_MS, value }).catch(() => {});
    return value;
  }
  return cached(manifestCacheKey(), MANIFEST_CACHE_MS, load);
}

// Fail-closed: any manifest shape we don't recognize is "unknown" --
// history only counts as available when the manifest explicitly says
// status === 'published' with at least one part.
export function manifestHistoryGroupEntry(manifest, categoryId, groupId) {
  const category = manifest?.categories?.[String(categoryId)];
  if (!category) return { available: false, entry: null };
  const entry = category.groups?.[String(groupId)];
  if (!entry || entry.status !== 'published' || !Array.isArray(entry.parts) || !entry.parts.length) {
    return { available: false, entry: null };
  }
  return { available: true, entry };
}

function partSuffix(objectKey) {
  const match = /\.(part\d+)\.json\.gz$/.exec(String(objectKey || ''));
  return match ? `.${match[1]}` : '';
}

async function fetchGroupParts(categoryId, groupId, parts, { session, fetchImpl } = {}) {
  const ordered = [...parts].sort((left, right) => Number(left.part) - Number(right.part)).slice(0, MAX_PARTS);
  const partsTotal = ordered[0]?.partsTotal ?? ordered.length;
  const fetched = await Promise.all(ordered.map((part) => requestTCGCSVCatalog(
    `/catalog/history/${categoryId}/${groupId}${partSuffix(part.objectKey)}`,
    { session, fetchImpl }
  )));
  const variants = [];
  fetched.forEach((payload, index) => {
    const expected = ordered[index];
    if (Number(payload?.part) !== Number(expected.part) || Number(payload?.partsTotal) !== Number(partsTotal)) {
      throw new Error('A price-history part is out of sequence with its manifest entry.');
    }
    variants.push(...(Array.isArray(payload.variants) ? payload.variants : []));
  });
  return { categoryId: Number(categoryId), groupId: Number(groupId), variants };
}

export async function fetchHistoryGroup(categoryId, groupId, manifestEntry, { session, fetchImpl, bypassCache = false } = {}) {
  const key = groupCacheKey(categoryId, groupId);
  const load = () => fetchGroupParts(categoryId, groupId, manifestEntry.parts, { session, fetchImpl });
  if (bypassCache) {
    const value = await load();
    await putRecord('catalogCache', { key, expiresAt: Date.now() + GROUP_CACHE_MS, value }).catch(() => {});
    return value;
  }
  return cached(key, GROUP_CACHE_MS, load);
}

// Top-level lookup: manifest -> (published | unknown), then the merged
// group object -> the single matching variant's weekly points. Never
// fabricates a series -- absent is absent.
export async function getPriceHistory(categoryId, groupId, productId, subTypeName, opts = {}) {
  if (![categoryId, groupId, productId].every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0)) {
    return { available: false, points: null };
  }
  const manifest = await fetchHistoryManifest(opts);
  const { available, entry } = manifestHistoryGroupEntry(manifest, categoryId, groupId);
  if (!available) return { available: false, points: null, manifest };
  const group = await fetchHistoryGroup(categoryId, groupId, entry, opts);
  const variant = group.variants.find((item) => Number(item.productId) === Number(productId)
    && String(item.subTypeName || '') === String(subTypeName || ''));
  if (!variant || !Array.isArray(variant.points) || !variant.points.length) {
    return { available: false, points: null, manifest };
  }
  return { available: true, points: variant.points, manifest };
}

// Mirrors forecast-trajectory.js's trajectoryKeyForItem: only TCGCSV-
// identified items are in scope for a published price-history series.
export function historyKeyForItem(item = {}) {
  if (item?.provider !== 'tcgcsv') return '';
  const { categoryId, groupId, productId } = item;
  if (![categoryId, groupId, productId].every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0)) return '';
  return `${Number(categoryId)}:${Number(groupId)}:${Number(productId)}:${String(item.variant || '')}`;
}

export function getPriceHistoryForItem(item = {}, opts = {}) {
  if (item?.provider !== 'tcgcsv') return Promise.resolve({ available: false, points: null });
  return getPriceHistory(item.categoryId, item.groupId, item.productId, item.variant, opts);
}
