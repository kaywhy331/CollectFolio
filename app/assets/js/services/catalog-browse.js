import { normalizeQuery, textSimilarity } from '../core/utils.js';
import { getPokemonSetCards, listPokemonSets } from './providers/pokemon.js';
import { getScryfallSetCards, listScryfallSets } from './providers/scryfall.js';
import { getYGOSetCards, listYGOSets } from './providers/ygoprodeck.js';

const CACHE_MS = 24 * 60 * 60 * 1000;
const memoryCache = new Map();
const numberCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const CATALOG_GAMES = Object.freeze([
  Object.freeze({ id: 'pokemon', name: 'Pokémon', shortName: 'Pokémon', provider: 'pokemon', description: 'Sets and card printings' }),
  Object.freeze({ id: 'magic', name: 'Magic: The Gathering', shortName: 'Magic', provider: 'scryfall', description: 'Paper sets and printings' }),
  Object.freeze({ id: 'yugioh', name: 'Yu-Gi-Oh!', shortName: 'Yu-Gi-Oh!', provider: 'ygoprodeck', description: 'Sets and card printings' })
]);

const adapters = Object.freeze({
  pokemon: { sets: listPokemonSets, products: getPokemonSetCards },
  magic: { sets: listScryfallSets, products: getScryfallSetCards },
  yugioh: { sets: listYGOSets, products: getYGOSetCards }
});

function cached(key, loader, bypassCache = false) {
  const found = memoryCache.get(key);
  if (!bypassCache && found?.expiresAt > Date.now()) return Promise.resolve(found.value);
  return Promise.resolve().then(loader).then((value) => {
    memoryCache.set(key, { expiresAt: Date.now() + CACHE_MS, value });
    return value;
  });
}

export function clearBrowseCatalogCache() {
  memoryCache.clear();
}

export function catalogGame(gameId) {
  return CATALOG_GAMES.find((game) => game.id === String(gameId || '')) || null;
}

function setSearchScore(set, query) {
  const needle = normalizeQuery(query);
  if (!needle) return 0;
  const name = normalizeQuery(set.name);
  const code = normalizeQuery(set.code);
  if (needle === name || needle === code) return 4;
  if (name.startsWith(needle) || code.startsWith(needle)) return 3;
  if (needle.split(' ').every((token) => `${name} ${code} ${normalizeQuery(set.series)}`.includes(token))) return 2;
  return textSimilarity(needle, `${set.name} ${set.code} ${set.series}`);
}

export function filterCatalogSets(sets = [], { query = '', sort = 'newest', scope = 'all' } = {}) {
  const needle = normalizeQuery(query);
  const filtered = sets.filter((set) => {
    if (scope === 'main' && set.supplemental) return false;
    if (scope === 'supplemental' && !set.supplemental) return false;
    return !needle || setSearchScore(set, needle) >= 0.35;
  });
  return filtered.sort((left, right) => {
    if (needle) {
      const relevance = setSearchScore(right, needle) - setSearchScore(left, needle);
      if (relevance) return relevance;
    }
    if (sort === 'alpha') return String(left.name).localeCompare(String(right.name));
    if (sort === 'largest') return (Number(right.cardCount) || 0) - (Number(left.cardCount) || 0)
      || String(left.name).localeCompare(String(right.name));
    return String(right.releasedAt || '').localeCompare(String(left.releasedAt || ''))
      || String(left.name).localeCompare(String(right.name));
  });
}

export function filterCatalogProducts(products = [], { query = '', sort = 'number' } = {}) {
  const needle = normalizeQuery(query);
  const filtered = products.filter((product) => !needle
    || normalizeQuery([product.name, product.number, product.rarity, product.variant].filter(Boolean).join(' ')).includes(needle));
  return filtered.sort((left, right) => {
    if (sort === 'name') return String(left.name).localeCompare(String(right.name))
      || numberCollator.compare(String(left.number || ''), String(right.number || ''));
    if (sort === 'price-desc') return (Number(right.price) || -1) - (Number(left.price) || -1)
      || String(left.name).localeCompare(String(right.name));
    return numberCollator.compare(String(left.number || ''), String(right.number || ''))
      || String(left.name).localeCompare(String(right.name));
  });
}

export async function loadCatalogSets({ gameId = 'all', bypassCache = false } = {}) {
  const selected = gameId === 'all' ? CATALOG_GAMES : CATALOG_GAMES.filter((game) => game.id === gameId);
  if (!selected.length) throw new Error('This card game does not have an approved browse catalog yet.');
  const settled = await Promise.allSettled(selected.map((game) => cached(`sets:${game.id}`, adapters[game.id].sets, bypassCache)));
  const sets = [];
  const warnings = [];
  settled.forEach((result, index) => {
    const game = selected[index];
    if (result.status === 'fulfilled') sets.push(...result.value.map((set) => ({ ...set, gameId: game.id, game: game.name })));
    else warnings.push(`${game.shortName} sets were unavailable: ${result.reason?.message || 'request failed'}`);
  });
  if (!sets.length && warnings.length) throw new Error(warnings.join(' '));
  return { sets: filterCatalogSets(sets), warnings };
}

export async function loadCatalogSetProducts({ gameId, setId, bypassCache = false } = {}) {
  const game = catalogGame(gameId);
  const externalId = String(setId || '').trim();
  if (!game || !externalId) throw new Error('Choose a supported game and set.');
  const products = await cached(`products:${game.id}:${externalId}`, () => adapters[game.id].products(externalId), bypassCache);
  return filterCatalogProducts(products.map((product) => ({ ...product, gameId: game.id, productKind: 'card' })));
}
