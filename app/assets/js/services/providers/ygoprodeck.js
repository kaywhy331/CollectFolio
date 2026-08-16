import { fetchJSON } from '../../core/utils.js';

const endpoint = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const setsEndpoint = 'https://db.ygoprodeck.com/api/v7/cardsets.php';

function isNoMatch(error) {
  return error?.status === 400 && /^No card matching your query was found/i.test(error?.payload?.error || '');
}

export function normalizeYGOCard(card) {
  const image = card.card_images?.[0] || {};
  const sets = card.card_sets?.length ? card.card_sets : [{ set_code: '', set_name: '', set_rarity: '', set_price: null }];
  return sets.map((printing) => {
    const price = printing.set_price !== null && printing.set_price !== undefined && printing.set_price !== '' && Number.isFinite(Number(printing.set_price))
      ? Number(printing.set_price)
      : null;
    const setCode = printing.set_code || 'unlisted';
    return {
      id: `ygoprodeck:${card.id}:${setCode}`,
      externalId: `${card.id}:${setCode}`,
      provider: 'ygoprodeck',
      category: 'yugioh',
      game: 'Yu-Gi-Oh!',
      name: card.name || 'Unnamed Yu-Gi-Oh! card',
      setName: printing.set_name || '',
      number: printing.set_code || '',
      variant: printing.set_rarity || '',
      rarity: printing.set_rarity || '',
      year: '',
      image: image.image_url || image.image_url_small || '',
      imageSmall: image.image_url_small || image.image_url || '',
      price,
      priceOptions: price == null ? [] : [{ finish: printing.set_rarity || 'listed set price', price, source: 'YGOPRODeck listed set price' }],
      currency: 'USD',
      priceSource: price == null ? '' : 'YGOPRODeck listed set price',
      priceUrl: `https://ygoprodeck.com/card/?search=${encodeURIComponent(card.name || '')}`,
      priceUpdatedAt: price == null ? '' : new Date().toISOString().slice(0, 10)
    };
  });
}

export function normalizeYGOSet(set) {
  const externalId = String(set?.set_code || '').trim();
  if (!externalId) return null;
  const cardCount = Number(set.num_of_cards);
  return {
    id: `yugioh:${externalId}`,
    externalId,
    provider: 'ygoprodeck',
    gameId: 'yugioh',
    game: 'Yu-Gi-Oh!',
    name: set.set_name || externalId,
    code: externalId,
    series: '',
    releasedAt: set.tcg_date || '',
    year: String(set.tcg_date || '').slice(0, 4),
    image: set.set_image || '',
    productCount: Number.isFinite(cardCount) ? cardCount : null,
    cardCount: Number.isFinite(cardCount) ? cardCount : null,
    setType: 'expansion',
    supplemental: false
  };
}

export async function listYGOSets() {
  const payload = await fetchJSON(setsEndpoint);
  return (Array.isArray(payload) ? payload : []).map(normalizeYGOSet).filter(Boolean);
}

export async function searchYGOPRODeck(query) {
  const url = new URL(endpoint);
  url.searchParams.set('fname', String(query).trim());
  let payload;
  try {
    payload = await fetchJSON(url);
  } catch (error) {
    if (isNoMatch(error)) return [];
    throw error;
  }
  return (payload.data || []).flatMap(normalizeYGOCard);
}

export async function getYGOSetCards(setId) {
  const externalId = String(setId || '').trim();
  const set = (await listYGOSets()).find((candidate) => candidate.externalId === externalId);
  if (!set) throw new Error('This Yu-Gi-Oh! set could not be found.');
  const url = new URL(endpoint);
  url.searchParams.set('cardset', set.name);
  let payload;
  try {
    payload = await fetchJSON(url);
  } catch (error) {
    if (isNoMatch(error)) return [];
    throw error;
  }
  const expectedName = set.name.toLocaleLowerCase();
  return (payload.data || []).flatMap(normalizeYGOCard)
    .filter((card) => String(card.setName || '').toLocaleLowerCase() === expectedName);
}

export async function getYGOCard(externalId) {
  const [cardId] = String(externalId).split(':');
  const url = new URL(endpoint);
  url.searchParams.set('id', cardId);
  const payload = await fetchJSON(url);
  const candidates = (payload.data || []).flatMap(normalizeYGOCard);
  const exact = candidates.find((candidate) => candidate.externalId === String(externalId));
  if (!exact) throw new Error('YGOPRODeck printing detail was not found.');
  return exact;
}
