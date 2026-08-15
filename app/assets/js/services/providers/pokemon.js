import { fetchJSON, normalizeQuery } from '../../core/utils.js';

const endpoint = 'https://api.pokemontcg.io/v2/cards';
const setEndpoint = 'https://api.pokemontcg.io/v2/sets';
const fallbackEndpoint = 'https://api.tcgdex.net/v2/en/cards';
const fallbackSetEndpoint = 'https://api.tcgdex.net/v2/en/sets';
// Request only fields CollectFolio uses. The full card payload is large enough
// to make otherwise valid broad searches intermittently fail at the provider.
// Pricing embedded by this catalog API is TCGplayer/Cardmarket-derived and is
// not part of CollectFolio's approved publication plane. Keep catalog discovery
// metadata-only; licensed values arrive through rights-gated publications.
const SELECT_FIELDS = 'id,name,number,rarity,set,images';
const PAGE_SIZE = 250;
const FETCH_OPTIONS = { retries: 3, retryDelay: 250 };
const FETCH_TIMEOUT_MS = 8_000;
const SET_FETCH_TIMEOUT_MS = 4_000;
const PRIMARY_SET_LOOKUP_TIMEOUT_MS = 1_000;
const PRIMARY_SET_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const SET_CACHE_MS = 24 * 60 * 60 * 1000;
const SET_CACHE_VERSION = 'v1';
const setMemory = new Map();
const setRequests = new Map();
const primarySetMatches = new Map();

function numberParts(query) {
  return String(query).match(/(?:^|\s|#)([a-z]*\d+[a-z]*)(?:\/([a-z]*\d+[a-z]*))?(?=$|\s)/i);
}

function findSetMatch(tokens, sets) {
  const matches = [];
  sets.forEach((set) => {
    const name = normalizeQuery(set?.name);
    const setTokens = name.split(' ').filter(Boolean);
    if (!setTokens.length || setTokens.length > tokens.length) return;
    for (let start = 0; start <= tokens.length - setTokens.length; start++) {
      if (setTokens.every((token, index) => tokens[start + index] === token)) {
        matches.push({ set, start, length: setTokens.length, normalizedName: name });
      }
    }
  });
  return matches.sort((left, right) =>
    right.length - left.length ||
    right.normalizedName.length - left.normalizedName.length ||
    right.start - left.start
  )[0] || null;
}

export function parsePokemonQuery(query, sets = []) {
  const raw = String(query).trim();
  const tokens = normalizeQuery(raw).split(' ').filter(Boolean);
  const setMatch = findSetMatch(tokens, sets);
  const words = tokens.filter((_, index) => !setMatch || index < setMatch.start || index >= setMatch.start + setMatch.length);
  const match = numberParts(raw);
  let number = '';
  if (match) {
    const numerator = normalizeQuery(match[1]);
    const denominator = normalizeQuery(match[2]);
    const numberIndex = words.indexOf(numerator);
    if (numberIndex >= 0) {
      number = match[1].toLowerCase();
      words.splice(numberIndex, 1);
      if (denominator && words[numberIndex] === denominator) words.splice(numberIndex, 1);
    }
  }
  return {
    raw,
    name: words.join(' '),
    number,
    set: setMatch?.set || null
  };
}

function buildPokemonIntentQuery(intent) {
  const clauses = [];
  if (intent.name) clauses.push(`name:${intent.name.includes(' ') ? `"${intent.name}"` : intent.name}`);
  if (intent.number) clauses.push(`number:${intent.number}`);
  const setId = String(intent.set?.pokemonId || intent.set?.id || '');
  if (/^[a-z0-9._-]+$/i.test(setId)) clauses.push(`set.id:${setId}`);
  else if (intent.set?.name) clauses.push(`set.name:"${normalizeQuery(intent.set.name)}"`);
  return clauses.join(' ');
}

export function buildPokemonQuery(query, sets = []) {
  return buildPokemonIntentQuery(parsePokemonQuery(query, sets));
}

function setCacheKey(source) {
  return `collectfolio:pokemon-sets:${SET_CACHE_VERSION}:${source}`;
}

function readStoredSets(source) {
  try {
    const cached = JSON.parse(globalThis.localStorage?.getItem(setCacheKey(source)) || 'null');
    return cached?.expiresAt > Date.now() && Array.isArray(cached.sets) && cached.sets.length ? cached.sets : null;
  } catch {
    return null;
  }
}

function storeSets(source, sets) {
  try {
    globalThis.localStorage?.setItem(setCacheKey(source), JSON.stringify({ expiresAt: Date.now() + SET_CACHE_MS, sets }));
  } catch { /* Set discovery still works when browser storage is unavailable. */ }
}

async function cachedSets(source, loader) {
  if (setMemory.has(source)) return setMemory.get(source);
  const stored = readStoredSets(source);
  if (stored) {
    setMemory.set(source, stored);
    return stored;
  }
  if (setRequests.has(source)) return setRequests.get(source);
  const request = loader().then((sets) => {
    if (!sets.length) throw new Error(`${source} returned no Pokémon sets.`);
    setMemory.set(source, sets);
    storeSets(source, sets);
    return sets;
  }).finally(() => setRequests.delete(source));
  setRequests.set(source, request);
  return request;
}

async function loadPokemonSets() {
  return cachedSets('pokemon', async () => {
    const url = new URL(setEndpoint);
    url.searchParams.set('select', 'id,name');
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    const sets = [];
    for (let page = 1; ; page++) {
      url.searchParams.set('page', String(page));
      const payload = await fetchJSON(url, { retries: 1, retryDelay: 250 }, SET_FETCH_TIMEOUT_MS);
      const batch = Array.isArray(payload?.data) ? payload.data : [];
      sets.push(...batch.map((set) => ({ pokemonId: String(set.id), name: String(set.name || '') })).filter((set) => set.pokemonId && set.name));
      const total = Number(payload?.totalCount ?? sets.length);
      if (!batch.length || sets.length >= total || batch.length < PAGE_SIZE) break;
    }
    return sets;
  });
}

async function loadTCGDexSets() {
  return cachedSets('tcgdex', async () => {
    const payload = await fetchJSON(fallbackSetEndpoint, { retries: 2, retryDelay: 250 }, SET_FETCH_TIMEOUT_MS);
    return (Array.isArray(payload) ? payload : [])
      .map((set) => ({ tcgdexId: String(set.id), name: String(set.name || '') }))
      .filter((set) => set.tcgdexId && set.name);
  });
}

async function findPrimarySet(name) {
  const normalizedName = normalizeQuery(name);
  const known = setMemory.get('pokemon')?.find((set) => normalizeQuery(set.name) === normalizedName);
  if (known) return known;
  const cached = primarySetMatches.get(normalizedName);
  if (cached?.expiresAt > Date.now()) return cached.set;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRIMARY_SET_LOOKUP_TIMEOUT_MS);
  try {
    const url = new URL(setEndpoint);
    url.searchParams.set('q', `name:"${normalizedName}"`);
    url.searchParams.set('select', 'id,name');
    url.searchParams.set('pageSize', '20');
    const payload = await fetchJSON(url, { signal: controller.signal, retries: 0 }, PRIMARY_SET_LOOKUP_TIMEOUT_MS);
    const match = (Array.isArray(payload?.data) ? payload.data : [])
      .map((set) => ({ pokemonId: String(set.id), name: String(set.name || '') }))
      .find((set) => set.pokemonId && normalizeQuery(set.name) === normalizedName) || null;
    primarySetMatches.set(normalizedName, { set: match, expiresAt: Date.now() + SET_CACHE_MS });
    return match;
  } catch (error) {
    primarySetMatches.set(normalizedName, { set: null, expiresAt: Date.now() + PRIMARY_SET_FAILURE_BACKOFF_MS });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePokemonQuery(query) {
  try {
    const fallbackIntent = parsePokemonQuery(query, await loadTCGDexSets());
    if (fallbackIntent.set) {
      try {
        const primarySet = await findPrimarySet(fallbackIntent.set.name);
        return primarySet ? { ...fallbackIntent, set: { ...fallbackIntent.set, ...primarySet } } : fallbackIntent;
      } catch {
        return fallbackIntent;
      }
    }
    return fallbackIntent;
  } catch {
    try {
      return parsePokemonQuery(query, await loadPokemonSets());
    } catch {
      return parsePokemonQuery(query);
    }
  }
}

export function clearPokemonSetCache() {
  setMemory.clear();
  setRequests.clear();
  primarySetMatches.clear();
  try {
    globalThis.localStorage?.removeItem(setCacheKey('pokemon'));
    globalThis.localStorage?.removeItem(setCacheKey('tcgdex'));
  } catch { /* Tests and privacy-restricted browsers may not expose localStorage. */ }
}

export function normalizePokemonCard(card) {
  return {
    id: `pokemon:${card.id}`,
    externalId: String(card.id),
    provider: 'pokemon',
    category: 'pokemon',
    game: 'Pokémon',
    name: card.name || 'Unnamed Pokémon card',
    setName: card.set?.name || '',
    number: card.number || '',
    variant: '',
    rarity: card.rarity || '',
    year: card.set?.releaseDate?.slice(0, 4) || '',
    image: card.images?.large || card.images?.small || '',
    imageSmall: card.images?.small || card.images?.large || '',
    price: null,
    priceOptions: [],
    currency: 'USD',
    priceSource: '',
    priceUrl: '',
    priceUpdatedAt: ''
  };
}

export function normalizeTCGDexCard(card, set = {}) {
  const image = String(card?.image || '').replace(/\/$/, '');
  return {
    id: `pokemon:${card.id}`,
    externalId: String(card.id),
    provider: 'pokemon',
    category: 'pokemon',
    game: 'Pokémon',
    name: card.name || 'Unnamed Pokémon card',
    setName: card?.set?.name || set.name || '',
    number: card.localId || card.number || '',
    variant: '',
    rarity: '',
    year: String(card?.set?.releaseDate || set.releaseDate || '').slice(0, 4),
    image: image ? `${image}/high.webp` : '',
    imageSmall: image ? `${image}/low.webp` : '',
    price: null,
    priceOptions: [],
    currency: 'USD',
    priceSource: '',
    priceUrl: '',
    priceUpdatedAt: ''
  };
}

async function searchPokemonPrimary(intent) {
  const url = new URL(endpoint);
  url.searchParams.set('q', buildPokemonIntentQuery(intent));
  url.searchParams.set('select', SELECT_FIELDS);
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  const cards = [];
  const cardIds = new Set();
  for (let page = 1; ; page++) {
    url.searchParams.set('page', String(page));
    const payload = await fetchJSON(url, FETCH_OPTIONS, FETCH_TIMEOUT_MS);
    const batch = payload.data || [];
    let added = 0;
    batch.forEach((card) => {
      const id = String(card?.id || '');
      if (id && cardIds.has(id)) return;
      if (id) cardIds.add(id);
      cards.push(card);
      added++;
    });
    const total = payload.totalCount === null || payload.totalCount === undefined ? null : Number(payload.totalCount);
    if (!batch.length || !added || (Number.isFinite(total) && cards.length >= total) || batch.length < PAGE_SIZE) break;
  }
  return cards.map(normalizePokemonCard);
}

function fallbackCardMatches(card, intent) {
  const name = normalizeQuery(card?.name);
  const requestedName = normalizeQuery(intent.name);
  const nameMatches = !requestedName || requestedName.split(' ').every((token) => name.includes(token));
  const requestedNumber = normalizeQuery(intent.number).replace(/^0+(?=\d)/, '');
  const cardNumber = normalizeQuery(card?.localId || card?.number).replace(/^0+(?=\d)/, '');
  return nameMatches && (!requestedNumber || requestedNumber === cardNumber);
}

async function searchPokemonFallback(query) {
  let intent;
  try {
    intent = parsePokemonQuery(query, await loadTCGDexSets());
  } catch {
    intent = parsePokemonQuery(query);
  }
  if (intent.set?.tcgdexId) {
    const payload = await fetchJSON(`${fallbackSetEndpoint}/${encodeURIComponent(intent.set.tcgdexId)}`, { retries: 2, retryDelay: 250 }, FETCH_TIMEOUT_MS);
    const cards = payload?.cards;
    const expectedTotal = Number(payload?.cardCount?.total);
    if (!Array.isArray(cards) || !Number.isFinite(expectedTotal) || cards.length < expectedTotal || normalizeQuery(payload?.name) !== normalizeQuery(intent.set.name)) {
      throw new Error('TCGdex returned incomplete Pokémon set details.');
    }
    const set = { name: payload?.name || intent.set.name, releaseDate: payload?.releaseDate || '' };
    const results = cards
      .filter((card) => fallbackCardMatches(card, intent))
      .map((card) => normalizeTCGDexCard(card, set));
    return { results, authoritative: true };
  }
  const name = intent.name || String(query).trim();
  const url = new URL(fallbackEndpoint);
  url.searchParams.set('name', name);
  const payload = await fetchJSON(url, { retries: 2, retryDelay: 250 }, FETCH_TIMEOUT_MS);
  const results = (Array.isArray(payload) ? payload : [])
    .filter((card) => fallbackCardMatches(card, intent))
    .map((card) => normalizeTCGDexCard(card));
  return { results, authoritative: false };
}

export async function searchPokemon(query) {
  const intent = await resolvePokemonQuery(query);
  try {
    const primary = await searchPokemonPrimary(intent);
    if (primary.length || !intent.set) return primary;
    try {
      const fallback = await searchPokemonFallback(query);
      return fallback.authoritative ? fallback.results : primary;
    } catch {
      return primary;
    }
  } catch (primaryError) {
    try {
      const fallback = await searchPokemonFallback(query);
      if (fallback.authoritative || fallback.results.length) return fallback.results;
    } catch { /* Preserve the authoritative provider failure below. */ }
    throw primaryError;
  }
}

export async function getPokemonCard(externalId) {
  const payload = await fetchJSON(`${endpoint}/${encodeURIComponent(String(externalId))}`);
  if (!payload.data) throw new Error('Pokémon card detail was not found.');
  return normalizePokemonCard(payload.data);
}
