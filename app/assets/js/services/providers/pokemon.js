import { fetchJSON, normalizeQuery } from '../../core/utils.js';

const endpoint = 'https://api.pokemontcg.io/v2/cards';

export function normalizePokemonCard(card) {
  const priceOptions = Object.entries(card?.tcgplayer?.prices || {}).flatMap(([finish, fields]) => {
    const price = fields?.market ?? fields?.mid ?? fields?.low ?? fields?.high;
    return Number.isFinite(Number(price)) ? [{ finish, price: Number(price), source: 'TCGplayer market' }] : [];
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

export async function searchPokemon(query) {
  const normalized = normalizeQuery(query);
  const number = normalized.split(' ').find((token) => /\d/.test(token));
  const words = normalized.split(' ').filter((token) => token !== number).join(' ');
  const clauses = [];
  // The public API currently returns 500 for otherwise valid combined number
  // clauses, so retrieve by name and let the shared ranker favor exact numbers.
  if (words) clauses.push(`name:${words.replace(/[^a-z0-9 ]/g, '')}`);
  else if (number) clauses.push(`name:${number.replace(/[^a-z0-9]/g, '')}`);
  const url = new URL(endpoint);
  url.searchParams.set('q', clauses.join(' ') || `name:${normalized.replace(/[^a-z0-9 ]/g, '')}`);
  url.searchParams.set('pageSize', '24');
  url.searchParams.set('orderBy', 'name,number');
  const payload = await fetchJSON(url);
  return (payload.data || []).map(normalizePokemonCard);
}
