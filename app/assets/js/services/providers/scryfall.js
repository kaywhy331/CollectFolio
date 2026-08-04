import { fetchJSON } from '../../core/utils.js';

const cardsEndpoint = 'https://api.scryfall.com/cards';
const endpoint = `${cardsEndpoint}/search`;
const MAX_RESULTS = 500;

function isNoMatch(error) {
  return error?.status === 404 && error?.payload?.object === 'error' && error?.payload?.code === 'not_found';
}

export function normalizeScryfallCard(card) {
  const images = card.image_uris || card.card_faces?.find((face) => face.image_uris)?.image_uris || {};
  const rawOptions = [['regular', card.prices?.usd], ['foil', card.prices?.usd_foil], ['etched', card.prices?.usd_etched]];
  const priceOptions = rawOptions.flatMap(([finish, price]) => price !== null && price !== undefined && price !== '' && Number.isFinite(Number(price))
    ? [{ finish, price: Number(price), source: 'Scryfall daily price' }]
    : []);
  const preferred = priceOptions[0];
  return {
    id: `scryfall:${card.id}`,
    externalId: String(card.id),
    provider: 'scryfall',
    category: 'magic',
    game: 'Magic: The Gathering',
    name: card.name || 'Unnamed Magic card',
    setName: card.set_name || '',
    number: card.collector_number || '',
    variant: preferred?.finish || '',
    rarity: card.rarity || '',
    year: card.released_at?.slice(0, 4) || '',
    image: images.large || images.normal || images.small || '',
    imageSmall: images.small || images.normal || '',
    price: preferred?.price ?? null,
    priceOptions,
    currency: 'USD',
    priceSource: preferred ? 'Scryfall daily price' : '',
    priceUrl: card.scryfall_uri || '',
    priceUpdatedAt: card.prices?.usd || card.prices?.usd_foil || card.prices?.usd_etched ? new Date().toISOString().slice(0, 10) : ''
  };
}

export async function searchScryfall(query) {
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('unique', 'prints');
  url.searchParams.set('order', 'name');
  const cards = [];
  let nextPage = url.href;
  while (nextPage && cards.length < MAX_RESULTS) {
    let payload;
    try {
      payload = await fetchJSON(nextPage, { headers: { Accept: 'application/json' } });
    } catch (error) {
      if (isNoMatch(error)) break;
      throw error;
    }
    cards.push(...(payload.data || []));
    nextPage = payload.has_more ? payload.next_page : '';
  }
  return cards.slice(0, MAX_RESULTS).map(normalizeScryfallCard);
}

export async function getScryfallCard(externalId) {
  const payload = await fetchJSON(`${cardsEndpoint}/${encodeURIComponent(String(externalId))}`, { headers: { Accept: 'application/json' } });
  if (!payload?.id) throw new Error('Scryfall card detail was not found.');
  return normalizeScryfallCard(payload);
}
