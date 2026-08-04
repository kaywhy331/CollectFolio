import { fetchJSON, normalizeQuery } from '../../core/utils.js';

const endpoint = 'https://api.pokemontcg.io/v2/cards';
const fallbackEndpoint = 'https://api.tcgdex.net/v2/en/cards';
// Request only fields CollectFolio uses. The full card payload is large enough
// to make otherwise valid broad searches intermittently fail at the provider.
const SELECT_FIELDS = 'id,name,number,rarity,set,images,tcgplayer';
const PAGE_SIZE = 250;
const MAX_RESULTS = 500;
const FETCH_OPTIONS = { retries: 3, retryDelay: 250 };
const FETCH_TIMEOUT_MS = 8_000;

export function buildPokemonQuery(query) {
  const raw = String(query).trim();
  const numberMatch = raw.match(/(?:^|\s|#)([a-z]*\d+[a-z]*)(?:\/[a-z]*\d+[a-z]*)?(?=$|\s)/i);
  const number = numberMatch?.[1] || '';
  const words = normalizeQuery(numberMatch ? raw.replace(numberMatch[0], ' ') : raw);
  const clauses = [];
  if (words) clauses.push(`name:${words.includes(' ') ? `"${words}"` : words}`);
  if (number) clauses.push(`number:${number.toLowerCase()}`);
  return clauses.join(' ');
}

export function normalizePokemonCard(card) {
  const priceOptions = Object.entries(card?.tcgplayer?.prices || {}).flatMap(([finish, fields]) => {
    const price = fields?.market ?? fields?.mid ?? fields?.low ?? fields?.high;
    return price !== null && price !== undefined && price !== '' && Number.isFinite(Number(price))
      ? [{ finish, price: Number(price), source: 'TCGplayer market' }]
      : [];
  });
  const preferred = priceOptions.find((option) => option.finish === 'normal') || priceOptions[0];
  return {
    id: `pokemon:${card.id}`,
    externalId: String(card.id),
    provider: 'pokemon',
    category: 'pokemon',
    game: 'Pokémon',
    name: card.name || 'Unnamed Pokémon card',
    setName: card.set?.name || '',
    number: card.number || '',
    variant: preferred?.finish || '',
    rarity: card.rarity || '',
    year: card.set?.releaseDate?.slice(0, 4) || '',
    image: card.images?.large || card.images?.small || '',
    imageSmall: card.images?.small || card.images?.large || '',
    price: preferred?.price ?? null,
    priceOptions,
    currency: 'USD',
    priceSource: preferred ? 'Pokémon TCG API · TCGplayer market' : '',
    priceUrl: card.tcgplayer?.url || '',
    priceUpdatedAt: card.tcgplayer?.updatedAt || ''
  };
}

export function normalizeTCGDexCard(card) {
  const image = String(card?.image || '').replace(/\/$/, '');
  return {
    id: `pokemon:${card.id}`,
    externalId: String(card.id),
    provider: 'pokemon',
    category: 'pokemon',
    game: 'Pokémon',
    name: card.name || 'Unnamed Pokémon card',
    setName: '',
    number: card.localId || '',
    variant: '',
    rarity: '',
    year: '',
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

async function searchPokemonPrimary(query) {
  const url = new URL(endpoint);
  url.searchParams.set('q', buildPokemonQuery(query));
  url.searchParams.set('select', SELECT_FIELDS);
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  const cards = [];
  for (let page = 1; cards.length < MAX_RESULTS; page++) {
    url.searchParams.set('page', String(page));
    const payload = await fetchJSON(url, FETCH_OPTIONS, FETCH_TIMEOUT_MS);
    const batch = payload.data || [];
    cards.push(...batch);
    const total = Number(payload.totalCount ?? cards.length);
    if (!batch.length || cards.length >= total || batch.length < PAGE_SIZE) break;
  }
  return cards.slice(0, MAX_RESULTS).map(normalizePokemonCard);
}

async function searchPokemonFallback(query) {
  const name = normalizeQuery(query).split(' ').filter((token) => !/\d/.test(token)).join(' ') || String(query).trim();
  const url = new URL(fallbackEndpoint);
  url.searchParams.set('name', name);
  const payload = await fetchJSON(url, { retries: 2, retryDelay: 250 }, FETCH_TIMEOUT_MS);
  return (Array.isArray(payload) ? payload : []).slice(0, MAX_RESULTS).map(normalizeTCGDexCard);
}

export async function searchPokemon(query) {
  try {
    return await searchPokemonPrimary(query);
  } catch (primaryError) {
    try {
      const fallback = await searchPokemonFallback(query);
      if (fallback.length) return fallback;
    } catch { /* Preserve the authoritative provider failure below. */ }
    throw primaryError;
  }
}

export async function getPokemonCard(externalId) {
  const payload = await fetchJSON(`${endpoint}/${encodeURIComponent(String(externalId))}`);
  if (!payload.data) throw new Error('Pokémon card detail was not found.');
  return normalizePokemonCard(payload.data);
}
