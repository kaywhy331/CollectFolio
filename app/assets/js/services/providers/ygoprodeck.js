import { fetchJSON } from '../../core/utils.js';

const endpoint = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

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

export async function searchYGOPRODeck(query) {
  const url = new URL(endpoint);
  url.searchParams.set('fname', String(query).trim());
  const payload = await fetchJSON(url);
  return (payload.data || []).flatMap(normalizeYGOCard);
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
