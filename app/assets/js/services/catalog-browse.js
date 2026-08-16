import { normalizeQuery, textSimilarity } from '../core/utils.js';
import { getPokemonSetCards, listPokemonSets } from './providers/pokemon.js';
import { getScryfallSetCards, listScryfallSets } from './providers/scryfall.js';
import { getYGOSetCards, listYGOSets } from './providers/ygoprodeck.js';
import { TCGCSV_CATEGORY_DIRECTORY } from './providers/tcgcsv-categories.js';
import {
  getTCGCSVGroupProducts,
  getTCGCSVGroupProductsSample,
  listTCGCSVCategories,
  listTCGCSVGroups,
  tcgcsvCategoryId,
  tcgcsvGameId
} from './providers/tcgcsv.js';

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
  scryfall: { sets: listScryfallSets, products: getScryfallSetCards },
  ygoprodeck: { sets: listYGOSets, products: getYGOSetCards },
  tcgcsv: { sets: listTCGCSVGroups, products: getTCGCSVGroupProducts }
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

export function catalogGamesFromTCGCSVCategories(categories = []) {
  return (Array.isArray(categories) ? categories : []).map((category) => {
    const categoryId = Number(category?.categoryId);
    const name = String(category?.displayName || category?.name || '').trim();
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0 || !name) return null;
    return Object.freeze({
      id: tcgcsvGameId(categoryId),
      name,
      shortName: name,
      provider: 'tcgcsv',
      categoryId,
      isCardCategory: category?.isCardCategory !== false,
      description: `Free community catalog · TCGCSV category ${categoryId}`
    });
  }).filter(Boolean).sort((left, right) => left.categoryId - right.categoryId);
}

export const TCGCSV_CATALOG_GAMES = Object.freeze(catalogGamesFromTCGCSVCategories(TCGCSV_CATEGORY_DIRECTORY));

export function mergeCatalogGames(...collections) {
  const games = new Map([...CATALOG_GAMES, ...TCGCSV_CATALOG_GAMES].map((game) => [game.id, game]));
  const fixedIds = new Set(CATALOG_GAMES.map((game) => game.id));
  collections.flat().forEach((game) => {
    if (!game?.id || fixedIds.has(game.id)) return;
    games.set(game.id, { ...games.get(game.id), ...game });
  });
  return [
    ...CATALOG_GAMES,
    ...[...games.values()].filter((game) => !fixedIds.has(game.id)).sort((left, right) =>
      (Number(left.categoryId) || Number.MAX_SAFE_INTEGER) - (Number(right.categoryId) || Number.MAX_SAFE_INTEGER)
      || String(left.name).localeCompare(String(right.name)))
  ];
}

export function catalogGame(gameId, games = []) {
  const id = String(gameId || '');
  const found = mergeCatalogGames(games).find((game) => game.id === id);
  if (found) return found;
  const categoryId = tcgcsvCategoryId(id);
  return categoryId === null ? null : {
    id,
    name: `TCGCSV category ${categoryId}`,
    shortName: `TCGCSV category ${categoryId}`,
    provider: 'tcgcsv',
    categoryId,
    description: 'Free community catalog'
  };
}

// All catalog games are free to browse — the TCGCSV catalog no longer gates
// behind a signed-in session (community free access).
export function catalogGameRequiresSession() {
  return false;
}

export function scopedTCGCSVGroups(groups = [], gameId) {
  const categoryId = tcgcsvCategoryId(gameId);
  if (categoryId === null) return [];
  return (Array.isArray(groups) ? groups : []).filter((group) =>
    group?.gameId === gameId && Number(group?.categoryId) === categoryId);
}

export async function loadCatalogGames({ bypassCache = false } = {}) {
  const categories = await cached('games:tcgcsv', listTCGCSVCategories, bypassCache);
  return mergeCatalogGames(catalogGamesFromTCGCSVCategories(categories));
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

export function filterCatalogSets(sets = [], { query = '', sort = 'newest', scope = 'all', years = [] } = {}) {
  const needle = normalizeQuery(query);
  const selectedYears = new Set((Array.isArray(years) ? years : []).map((year) => String(year)).filter(Boolean));
  const filtered = sets.filter((set) => {
    if (scope === 'main' && set.supplemental) return false;
    if (scope === 'supplemental' && !set.supplemental) return false;
    if (selectedYears.size && !selectedYears.has(String(set.year || ''))) return false;
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

// Cover-image rule for TCGCSV set tiles: prefer a product whose name has
// both "display" and "box"; otherwise the first name containing "display",
// then "box", then "case", then "booster"; otherwise any product at random.
const SET_COVER_KEYWORD_TIERS = Object.freeze([
  Object.freeze(['display', 'box']),
  Object.freeze(['display']),
  Object.freeze(['box']),
  Object.freeze(['case']),
  Object.freeze(['booster'])
]);

export function pickTCGCSVSetCover(products = [], random = Math.random) {
  const rows = (Array.isArray(products) ? products : [])
    .filter((product) => product && (product.imageSmall || product.image));
  if (!rows.length) return '';
  const named = rows.map((product) => ({ product, name: String(product.name || '').toLowerCase() }));
  for (const keywords of SET_COVER_KEYWORD_TIERS) {
    const match = named.find(({ name }) => keywords.every((keyword) => name.includes(keyword)));
    if (match) return match.product.imageSmall || match.product.image;
  }
  const chosen = rows[Math.min(rows.length - 1, Math.floor(random() * rows.length))];
  return chosen.imageSmall || chosen.image;
}

export async function loadTCGCSVSetCoverImage(set, { bypassCache = false, random } = {}) {
  if (set?.provider !== 'tcgcsv' || !set.externalId) return '';
  return cached(`cover:${set.id}`, async () => {
    const products = await getTCGCSVGroupProductsSample(set.externalId, { limit: 100 });
    return pickTCGCSVSetCover(products, random);
  }, bypassCache);
}

export function catalogSetYears(sets = []) {
  const years = new Set((Array.isArray(sets) ? sets : [])
    .map((set) => String(set?.year || '').trim())
    .filter((year) => /^\d{4}$/.test(year)));
  return [...years].sort((left, right) => right.localeCompare(left));
}

// Name-derived set families shared across TCGs. Ordered — the first matching
// rule wins; unmatched sets fall back to "Main expansions" or, when the source
// flags them supplemental, "Other supplemental".
const SET_FAMILY_RULES = Object.freeze([
  Object.freeze({ id: 'commander', name: 'Commander', pattern: /\bcommander\b/ }),
  Object.freeze({ id: 'secret-lair', name: 'Secret Lair', pattern: /secret lair/ }),
  Object.freeze({ id: 'universes-beyond', name: 'Universes Beyond', pattern: /universes beyond/ }),
  Object.freeze({ id: 'jumpstart', name: 'Jumpstart', pattern: /jumpstart/ }),
  Object.freeze({ id: 'masters-reprints', name: 'Masters & reprints', pattern: /\bmasters\b|remastered|anthology|chronicles/ }),
  Object.freeze({ id: 'preconstructed', name: 'Preconstructed decks', pattern: /duel deck|starter|structure deck|theme deck|intro pack|event deck|planeswalker deck|challenger deck|trainer kit|battle deck|league battle/ }),
  Object.freeze({ id: 'promos', name: 'Promos & prerelease', pattern: /\bpromos?\b|prerelease|black star|championship|judge/ }),
  Object.freeze({ id: 'collections', name: 'Collections & box sets', pattern: /collection|box set|premium|treasure chest|gift set|bundle/ })
]);

function setFamily(set) {
  const haystack = `${set?.name || ''} ${set?.setType || ''}`.toLowerCase();
  const rule = SET_FAMILY_RULES.find((entry) => entry.pattern.test(haystack));
  if (rule) return { id: rule.id, name: rule.name };
  return set?.supplemental
    ? { id: 'other-supplemental', name: 'Other supplemental' }
    : { id: 'main', name: 'Main expansions' };
}

export function groupCatalogSets(sets = [], mode = 'family') {
  const rows = Array.isArray(sets) ? sets : [];
  if (mode === 'none' || !rows.length) return rows.length ? [{ id: 'all', name: '', sets: rows }] : [];
  const buckets = new Map();
  const push = (id, name, set) => {
    if (!buckets.has(id)) buckets.set(id, { id, name, sets: [] });
    buckets.get(id).sets.push(set);
  };
  if (mode === 'year') {
    rows.forEach((set) => {
      const year = String(set?.year || '').trim();
      push(year || 'undated', year || 'Undated', set);
    });
    return [...buckets.values()].sort((left, right) => {
      if (left.id === 'undated') return 1;
      if (right.id === 'undated') return -1;
      return right.id.localeCompare(left.id);
    });
  }
  if (mode === 'game') {
    rows.forEach((set) => push(String(set?.gameId || 'unknown'), String(set?.game || set?.gameId || 'Unknown game'), set));
    return [...buckets.values()].sort((left, right) => left.name.localeCompare(right.name));
  }
  rows.forEach((set) => {
    const family = setFamily(set);
    push(family.id, family.name, set);
  });
  const order = ['main', ...SET_FAMILY_RULES.map((rule) => rule.id), 'other-supplemental'];
  return [...buckets.values()].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
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
  const requestedGameId = String(gameId || 'all');
  const categoryId = tcgcsvCategoryId(requestedGameId);
  const selectedPublicGames = requestedGameId === 'all'
    ? CATALOG_GAMES
    : CATALOG_GAMES.filter((game) => game.id === requestedGameId);
  if (requestedGameId !== 'all' && !selectedPublicGames.length && categoryId === null) {
    throw new Error('This card game does not have an approved browse catalog yet.');
  }
  const tasks = selectedPublicGames.map((game) => ({
    game,
    kind: 'public',
    load: () => cached(`sets:${game.id}`, adapters[game.provider].sets, bypassCache)
  }));
  if (requestedGameId === 'all' || categoryId !== null) {
    const dynamicGame = categoryId === null ? null : catalogGame(requestedGameId);
    tasks.push({
      game: dynamicGame,
      kind: 'tcgcsv',
      load: () => cached(`sets:${categoryId === null ? 'tcgcsv:all' : requestedGameId}`,
        () => listTCGCSVGroups({ categoryId }), bypassCache)
    });
  }
  const settled = await Promise.allSettled(tasks.map((task) => task.load()));
  const sets = [];
  const warnings = [];
  let games = mergeCatalogGames();
  settled.forEach((result, index) => {
    const task = tasks[index];
    if (result.status === 'rejected') {
      const label = task.game?.shortName || 'TCGCSV game categories';
      warnings.push(`${label} sets were unavailable: ${result.reason?.message || 'request failed'}`);
      return;
    }
    if (task.kind === 'public') {
      sets.push(...result.value.map((set) => ({ ...set, gameId: task.game.id, game: task.game.name })));
      return;
    }
    const dynamicGames = catalogGamesFromTCGCSVCategories(result.value.categories);
    games = mergeCatalogGames(games, dynamicGames);
    const tcgcsvSets = categoryId === null
      ? result.value.groups
      : scopedTCGCSVGroups(result.value.groups, requestedGameId);
    sets.push(...tcgcsvSets);
  });
  if (!sets.length && warnings.length) throw new Error(warnings.join(' '));
  return { sets: filterCatalogSets(sets), warnings, games };
}

export async function loadCatalogSetProducts({ gameId, setId, bypassCache = false } = {}) {
  const game = catalogGame(gameId);
  const externalId = String(setId || '').trim();
  if (!game || !externalId) throw new Error('Choose a supported game and set.');
  const adapter = adapters[game.provider];
  if (!adapter) throw new Error('This card game does not have an approved browse catalog yet.');
  if (game.provider === 'tcgcsv' && Number.parseInt(externalId.split(':', 1)[0], 10) !== game.categoryId) {
    throw new Error('This TCGCSV group does not belong to the selected game.');
  }
  const products = await cached(`products:${game.id}:${externalId}`, () => adapter.products(externalId), bypassCache);
  if (game.provider === 'tcgcsv' && products.some((product) => Number(product?.categoryId) !== game.categoryId)) {
    throw new Error('The TCGCSV response crossed game-category boundaries.');
  }
  return filterCatalogProducts(products.map((product) => ({ ...product, gameId: game.id, productKind: 'card' })));
}
