import { fetchJSON, normalizeQuery } from '../../core/utils.js';

const endpoint = 'https://api.pokemontcg.io/v2/cards';

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

export async function searchPokemon(query) {
  const url = new URL(endpoint);
  url.searchParams.set('q', buildPokemonQuery(query));
  url.searchParams.set('pageSize', '24');
  url.searchParams.set('orderBy', 'name,number');
  const payload = await fetchJSON(url);
  return (payload.data || []).map(normalizePokemonCard);
}

export async function getPokemonCard(externalId) {
  const payload = await fetchJSON(`${endpoint}/${encodeURIComponent(String(externalId))}`);
  if (!payload.data) throw new Error('Pokémon card detail was not found.');
  return normalizePokemonCard(payload.data);
}
