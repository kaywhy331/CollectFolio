import { getRecord, putRecord } from '../core/db.js';
import { isUUID } from '../core/catalog-identity.js';
import { fetchPublishedIntelligence } from './supabase.js';

const CACHE_PREFIX = 'intelligence:v1:';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cacheKey = (variantId) => `${CACHE_PREFIX}${String(variantId).toLowerCase()}`;

export function intelligenceVariantIds(holdings = [], watchlistItems = []) {
  return [...new Set([
    ...holdings.map((entry) => entry.canonicalVariantId),
    ...watchlistItems.map((entry) => entry.canonicalVariantId)
  ].filter(isUUID).map((id) => id.toLowerCase()))];
}

export function publicationCacheRecord(publication, now = Date.now()) {
  const sourceExpiry = publication.expiresAt ? new Date(publication.expiresAt).valueOf() : Infinity;
  return {
    key: cacheKey(publication.variantId),
    variantId: publication.variantId,
    value: publication,
    cachedAt: now,
    expiresAt: Math.min(now + CACHE_TTL_MS, Number.isFinite(sourceExpiry) ? sourceExpiry : Infinity)
  };
}

export function indexPublications(publications = []) {
  return Object.fromEntries(publications.filter((entry) => isUUID(entry?.variantId)).map((entry) => [entry.variantId.toLowerCase(), entry]));
}

export async function loadCachedIntelligence(variantIds = [], now = Date.now()) {
  const records = await Promise.all(variantIds.filter(isUUID).map((id) => getRecord('intelligenceCache', cacheKey(id)).catch(() => null)));
  return indexPublications(records.filter((record) => record?.expiresAt > now).map((record) => record.value));
}

export async function refreshPublishedIntelligence(variantIds = []) {
  const publications = await fetchPublishedIntelligence(variantIds);
  await Promise.all(publications.map((publication) => putRecord('intelligenceCache', publicationCacheRecord(publication)).catch(() => {})));
  return indexPublications(publications);
}
