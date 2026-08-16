import { getAll, getRecord, putRecord } from '../core/db.js';
import { isUUID } from '../core/catalog-identity.js';
import { marketSeriesIdentity } from '../core/market-series.js';
import { fetchPublishedIntelligence } from './supabase.js';

const CACHE_PREFIX = 'intelligence:v1:';
const HISTORY_PREFIX = 'intelligence-history:v1:';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const seriesKey = (publication = {}) => {
  const identity = marketSeriesIdentity(publication.seriesIdentity || publication.payload?.seriesIdentity || {});
  return [
  publication.variantId,
  identity.sourceId,
  identity.currency,
  identity.language,
  identity.finish,
  identity.conditionClass,
  identity.marketCondition,
  identity.priceSemantics
].map((value) => encodeURIComponent(String(value || '').toLowerCase())).join(':');
};
const cacheKey = (publication) => `${CACHE_PREFIX}${seriesKey(publication)}`;

function hashText(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function publicationHistoryRecord(publication, archivedAt = new Date().toISOString()) {
  if (!isUUID(publication?.variantId) || !publication?.publishedAt) return null;
  const signature = publication.payloadHash || hashText(JSON.stringify({
    supportTier: publication.supportTier,
    payload: publication.payload,
    reasonCodes: publication.reasonCodes,
    publishedAt: publication.publishedAt
  }));
  return {
    key: `${HISTORY_PREFIX}${seriesKey(publication)}:${encodeURIComponent(publication.publishedAt)}:${signature}`,
    variantId: publication.variantId.toLowerCase(),
    value: publication,
    archivedAt,
    immutable: true
  };
}

export function mergePublicationHistory(records = [], publications = [], archivedAt = new Date().toISOString()) {
  const result = new Map(records.filter((record) => record?.key).map((record) => [record.key, record]));
  for (const publication of publications) {
    const record = publicationHistoryRecord(publication, archivedAt);
    if (record && !result.has(record.key)) result.set(record.key, record);
  }
  return [...result.values()].sort((left, right) => String(right.value?.publishedAt || '').localeCompare(String(left.value?.publishedAt || '')));
}

async function archivePublication(publication) {
  const record = publicationHistoryRecord(publication);
  if (!record) return null;
  const existing = await getRecord('intelligenceCache', record.key).catch(() => null);
  if (existing) return existing;
  await putRecord('intelligenceCache', record);
  return record;
}

export function intelligenceVariantIds(holdings = [], watchlistItems = [], catalogItems = []) {
  return [...new Set([
    ...holdings.map((entry) => entry.canonicalVariantId),
    ...watchlistItems.map((entry) => entry.canonicalVariantId),
    ...catalogItems.map((entry) => entry.canonicalVariantId)
  ].filter(isUUID).map((id) => id.toLowerCase()))];
}

export function publicationCacheRecord(publication, now = Date.now()) {
  const sourceExpiry = publication.expiresAt ? new Date(publication.expiresAt).valueOf() : Infinity;
  return {
    key: cacheKey(publication),
    variantId: publication.variantId,
    value: publication,
    cachedAt: now,
    expiresAt: Math.min(now + CACHE_TTL_MS, Number.isFinite(sourceExpiry) ? sourceExpiry : Infinity)
  };
}

export function indexPublications(publications = []) {
  const grouped = {};
  for (const entry of publications.filter((value) => isUUID(value?.variantId))) {
    const key = entry.variantId.toLowerCase();
    (grouped[key] ||= []).push(entry);
  }
  return Object.fromEntries(Object.entries(grouped).map(([key, values]) => [
    key,
    values.length === 1 ? values[0] : values.sort((left, right) => seriesKey(left).localeCompare(seriesKey(right)))
  ]));
}

export async function loadCachedIntelligence(variantIds = [], now = Date.now()) {
  const requested = new Set(variantIds.filter(isUUID).map((id) => id.toLowerCase()));
  const records = await getAll('intelligenceCache').catch(() => []);
  return indexPublications(records.filter((record) => record?.expiresAt > now
    && requested.has(String(record.variantId || '').toLowerCase())).map((record) => record.value));
}

export async function loadIntelligenceHistory(variantIds = []) {
  const requested = new Set(variantIds.filter(isUUID).map((id) => id.toLowerCase()));
  if (!requested.size) return [];
  const records = await getAll('intelligenceCache').catch(() => []);
  return records.filter((record) => String(record?.key || '').startsWith(HISTORY_PREFIX)
    && requested.has(String(record.variantId || '').toLowerCase()))
    .sort((left, right) => String(right.value?.publishedAt || '').localeCompare(String(left.value?.publishedAt || '')));
}

export async function refreshPublishedIntelligence(variantIds = []) {
  const publications = await fetchPublishedIntelligence(variantIds);
  await Promise.all(publications.flatMap((publication) => [
    putRecord('intelligenceCache', publicationCacheRecord(publication)).catch(() => {}),
    archivePublication(publication).catch(() => null)
  ]));
  return indexPublications(publications);
}
