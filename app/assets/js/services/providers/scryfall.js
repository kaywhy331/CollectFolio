import { fetchJSON } from '../../core/utils.js';

const cardsEndpoint = 'https://api.scryfall.com/cards';
const endpoint = `${cardsEndpoint}/search`;
const setsEndpoint = 'https://api.scryfall.com/sets';
const PAGE_DELAY_MS = 100;

function pageDelay() {
  return new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
}

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

export function normalizeScryfallSet(set) {
  const externalId = String(set?.code || '').trim().toLowerCase();
  if (!externalId) return null;
  const cardCount = Number(set.card_count);
  const setType = String(set.set_type || '');
  return {
    id: `magic:${externalId}`,
    externalId,
    provider: 'scryfall',
    gameId: 'magic',
    game: 'Magic: The Gathering',
    name: set.name || externalId.toUpperCase(),
    code: externalId.toUpperCase(),
    series: '',
    releasedAt: set.released_at || '',
    year: String(set.released_at || '').slice(0, 4),
    productCount: Number.isFinite(cardCount) ? cardCount : null,
    cardCount: Number.isFinite(cardCount) ? cardCount : null,
    setType,
    supplemental: !['core', 'expansion'].includes(setType)
  };
}

export async function listScryfallSets() {
  const payload = await fetchJSON(setsEndpoint, { headers: { Accept: 'application/json' } });
  return (payload.data || [])
    .filter((set) => set?.digital !== true && Number(set?.card_count) > 0)
    .map(normalizeScryfallSet)
    .filter(Boolean);
}

export async function searchScryfall(query) {
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('unique', 'prints');
  url.searchParams.set('order', 'name');
  const cards = [];
  let nextPage = url.href;
  const requestedPages = new Set();
  while (nextPage && !requestedPages.has(nextPage)) {
    requestedPages.add(nextPage);
    let payload;
    try {
      payload = await fetchJSON(nextPage, { headers: { Accept: 'application/json' } });
    } catch (error) {
      if (isNoMatch(error)) break;
      throw error;
    }
    cards.push(...(payload.data || []));
    nextPage = payload.has_more ? payload.next_page : '';
    if (nextPage && !requestedPages.has(nextPage)) await pageDelay();
  }
  return cards.map(normalizeScryfallCard);
}

export async function getScryfallSetCards(setId) {
  const code = String(setId || '').trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(code)) throw new Error('This Magic set identifier is not supported.');
  return searchScryfall(`e:${code}`);
}

export async function getScryfallCard(externalId) {
  const payload = await fetchJSON(`${cardsEndpoint}/${encodeURIComponent(String(externalId))}`, { headers: { Accept: 'application/json' } });
  if (!payload?.id) throw new Error('Scryfall card detail was not found.');
  return normalizeScryfallCard(payload);
}
