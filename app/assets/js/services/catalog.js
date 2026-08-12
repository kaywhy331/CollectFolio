import { deleteRecords, getAll, getRecord, putRecord } from '../core/db.js';
import { normalizeQuery, textSimilarity } from '../core/utils.js';
import { clearPokemonSetCache, getPokemonCard, searchPokemon } from './providers/pokemon.js';
import { getScryfallCard, searchScryfall } from './providers/scryfall.js';
import { getYGOCard, searchYGOPRODeck } from './providers/ygoprodeck.js';

const CACHE_MS = 30 * 60 * 1000;
const CACHE_VERSION = 'v6';
export const CATALOG_CACHE_MAX_ENTRIES = 250;
let initialCacheMaintenance;
const providers = {
  pokemon: { category: 'pokemon', label: 'Pokémon TCG API', search: searchPokemon, detail: getPokemonCard },
  scryfall: { category: 'magic', label: 'Scryfall', search: searchScryfall, detail: getScryfallCard },
  ygoprodeck: { category: 'yugioh', label: 'YGOPRODeck', search: searchYGOPRODeck, detail: getYGOCard }
};

export function clearCatalogProviderCaches() {
  clearPokemonSetCache();
}

export function catalogCacheKeysToPrune(records = [], now = Date.now(), maximumEntries = CATALOG_CACHE_MAX_ENTRIES) {
  const maximum = Math.max(0, Math.trunc(Number(maximumEntries) || 0));
  const expired = [];
  const active = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.key) continue;
    if (!Number.isFinite(Number(record.expiresAt)) || Number(record.expiresAt) <= now) expired.push(record.key);
    else active.push(record);
  }
  active.sort((left, right) => Number(right.expiresAt) - Number(left.expiresAt)
    || String(left.key).localeCompare(String(right.key)));
  return [...new Set([...expired, ...active.slice(maximum).map((record) => record.key)])];
}

export async function pruneCatalogCache(now = Date.now(), maximumEntries = CATALOG_CACHE_MAX_ENTRIES) {
  const records = await getAll('catalogCache');
  const keys = catalogCacheKeysToPrune(records, now, maximumEntries);
  await deleteRecords('catalogCache', keys);
  return keys.length;
}

async function maintainCatalogCache({ afterWrite = false } = {}) {
  if (afterWrite) return pruneCatalogCache().catch(() => 0);
  initialCacheMaintenance ||= pruneCatalogCache().catch(() => 0);
  return initialCacheMaintenance;
}

async function cacheCatalogRecord(record) {
  await putRecord('catalogCache', record);
  await maintainCatalogCache({ afterWrite: true });
}

export function catalogRouteId(item = {}) {
  const provider = String(item.provider || '').trim().toLowerCase();
  const externalId = String(item.externalId || '').trim();
  return providers[provider] && externalId ? `${provider}:${externalId}` : '';
}

export async function getCatalogRouteItem(routeId, { bypassCache = false } = {}) {
  await maintainCatalogCache();
  const value = String(routeId || '').trim();
  const separator = value.indexOf(':');
  const provider = separator > 0 ? value.slice(0, separator).toLowerCase() : '';
  const externalId = separator > 0 ? value.slice(separator + 1) : '';
  const config = providers[provider];
  if (!config || !externalId) throw new Error('This card link does not contain a supported provider identity.');
  const key = `catalog:${CACHE_VERSION}:detail:${provider}:${externalId}`;
  if (!bypassCache) {
    const cached = await getRecord('catalogCache', key).catch(() => null);
    if (cached?.expiresAt > Date.now() && cached.value) return cached.value;
  }
  const item = await config.detail(externalId);
  if (!item) throw new Error('The linked card could not be found at its catalog provider.');
  await cacheCatalogRecord({ key, expiresAt: Date.now() + CACHE_MS, value: item }).catch(() => {});
  return item;
}

export function prepareCatalogQuery(query = '') {
  const raw = String(query).trim();
  return { raw, normalized: normalizeQuery(raw) };
}

export function rankCatalogItems(items, query) {
  const needle = normalizeQuery(query);
  return [...new Map(items.map((item) => [item.id, item])).values()].map((item) => {
    const nameScore = textSimilarity(needle, item.name);
    const detailScore = textSimilarity(needle, [item.name, item.setName, item.number, item.variant, item.rarity].join(' '));
    const exactNumber = item.number && needle.split(' ').includes(normalizeQuery(item.number)) ? 0.12 : 0;
    return { ...item, matchScore: Math.min(1, Math.max(nameScore, detailScore * 0.92) + exactNumber) };
  }).sort((a, b) => b.matchScore - a.matchScore || String(a.name).localeCompare(String(b.name)));
}

export function collectSettledProviders(settled, selected) {
  const results = [];
  const warnings = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') results.push(...result.value);
    else warnings.push(`${selected[index][1].label} was unavailable: ${result.reason?.message || 'request failed'}`);
  });
  return { results, warnings };
}

export async function searchCatalog({ query, category = 'all', provider = 'all', bypassCache = false } = {}) {
  await maintainCatalogCache();
  const { raw, normalized } = prepareCatalogQuery(query);
  if (!normalized) throw new Error('Enter a name, set, number, character, or player.');
  if (['sports', 'comics', 'slab', 'other'].includes(category)) return { results: [], warnings: [], manual: true, cached: false };
  const selected = Object.entries(providers).filter(([key, config]) =>
    (provider === 'all' || provider === key) && (category === 'all' || category === config.category)
  );
  const key = `catalog:${CACHE_VERSION}:${category}:${provider}:${normalized}`;
  if (!bypassCache) {
    const cached = await getRecord('catalogCache', key).catch(() => null);
    if (cached?.expiresAt > Date.now()) return { ...cached.value, cached: true };
  }
  // Provider syntax can depend on punctuation (for example, "Blue-Eyes").
  // Keep the normalized form for cache/ranking, but search with the user's text.
  const settled = await Promise.allSettled(selected.map(([, config]) => config.search(raw)));
  const { results, warnings } = collectSettledProviders(settled, selected);
  const value = { results: rankCatalogItems(results, normalized), warnings, manual: false };
  await cacheCatalogRecord({ key, expiresAt: Date.now() + CACHE_MS, value }).catch(() => {});
  return { ...value, cached: false };
}

export async function refreshCatalogItem(item) {
  const provider = item?.provider;
  if (!providers[provider]) return item;
  if (!item.externalId) throw new Error('This holding has no provider detail identifier.');
  const refreshed = await providers[provider].detail(item.externalId);
  const selected = refreshed.priceOptions?.find((option) => option.finish === item.variant);
  return selected
    ? { ...refreshed, variant: selected.finish, price: selected.price, priceSource: selected.source || refreshed.priceSource }
    : refreshed;
}
