import { getRecord, putRecord } from '../core/db.js';
import { normalizeQuery, textSimilarity } from '../core/utils.js';
import { searchPokemon } from './providers/pokemon.js';
import { searchScryfall } from './providers/scryfall.js';
import { searchYGOPRODeck } from './providers/ygoprodeck.js';

const CACHE_MS = 30 * 60 * 1000;
const providers = {
  pokemon: { category: 'pokemon', label: 'Pokémon TCG API', search: searchPokemon },
  scryfall: { category: 'magic', label: 'Scryfall', search: searchScryfall },
  ygoprodeck: { category: 'yugioh', label: 'YGOPRODeck', search: searchYGOPRODeck }
};

export function rankCatalogItems(items, query) {
  const needle = normalizeQuery(query);
  return [...new Map(items.map((item) => [item.id, item])).values()].map((item) => {
    const nameScore = textSimilarity(needle, item.name);
    const detailScore = textSimilarity(needle, [item.name, item.setName, item.number, item.variant, item.rarity].join(' '));
    const exactNumber = item.number && needle.split(' ').includes(normalizeQuery(item.number)) ? 0.12 : 0;
    return { ...item, matchScore: Math.min(1, Math.max(nameScore, detailScore * 0.92) + exactNumber) };
  }).sort((a, b) => b.matchScore - a.matchScore || String(a.name).localeCompare(String(b.name)));
}

export async function searchCatalog({ query, category = 'all', provider = 'all', bypassCache = false } = {}) {
  const normalized = normalizeQuery(query);
  if (!normalized) throw new Error('Enter a name, set, number, character, or player.');
  if (['sports', 'comics', 'slab', 'other'].includes(category)) return { results: [], warnings: [], manual: true, cached: false };
  const selected = Object.entries(providers).filter(([key, config]) =>
    (provider === 'all' || provider === key) && (category === 'all' || category === config.category)
  );
  const key = `catalog:${category}:${provider}:${normalized}`;
  if (!bypassCache) {
    const cached = await getRecord('catalogCache', key).catch(() => null);
    if (cached?.expiresAt > Date.now()) return { ...cached.value, cached: true };
  }
  const settled = await Promise.allSettled(selected.map(([, config]) => config.search(normalized)));
  const results = [];
  const warnings = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') results.push(...result.value);
    else warnings.push(`${selected[index][1].label} was unavailable: ${result.reason?.message || 'request failed'}`);
  });
  const value = { results: rankCatalogItems(results, normalized), warnings, manual: false };
  await putRecord('catalogCache', { key, expiresAt: Date.now() + CACHE_MS, value }).catch(() => {});
  return { ...value, cached: false };
}

export async function refreshCatalogItem(item) {
  const provider = item?.provider;
  if (!providers[provider]) return item;
  const results = await providers[provider].search([item.name, item.number].filter(Boolean).join(' '));
  return results.find((candidate) => candidate.id === item.id || candidate.externalId === item.externalId) || item;
}
