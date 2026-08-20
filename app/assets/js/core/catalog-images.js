import { safeImageUrl } from './utils.js';

const TCGPLAYER_IMAGE_CDN = 'https://tcgplayer-cdn.tcgplayer.com/product';
const TCGPLAYER_IMAGE_SIZES = Object.freeze([200, 400, 600, 800, 1000]);
const IMAGE_ATTRIBUTE_NAMES = new Set(['image', 'image url', 'imageurl', 'photo', 'front image']);

function firstSafeImage(values = []) {
  for (const value of values) {
    const url = safeImageUrl(value);
    if (url) return url;
  }
  return '';
}

function extendedImage(item = {}) {
  const entries = [
    ...(Array.isArray(item.extendedData) ? item.extendedData : []),
    ...(Array.isArray(item.attributes) ? item.attributes : [])
  ];
  const match = entries.find((entry) => IMAGE_ATTRIBUTE_NAMES.has(
    String(entry?.name || entry?.displayName || '').trim().toLowerCase()
  ));
  return match?.value || match?.displayValue || '';
}

export function tcgcsvProductImageUrl(productId, size = 400) {
  const id = Number(productId);
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  const scale = TCGPLAYER_IMAGE_SIZES.includes(Number(size)) ? Number(size) : 400;
  return `${TCGPLAYER_IMAGE_CDN}/${id}_in_${scale}x${scale}.jpg`;
}

export function tcgcsvProductIdForItem(item = {}) {
  const provider = String(item.provider || item.source || item.category || '').trim().toLowerCase();
  const identifiers = [item.externalId, item.id, item.catalogId]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const hasPrefixedIdentity = identifiers.some((value) => value.toLowerCase().startsWith('tcgcsv:'));
  if (provider !== 'tcgcsv' && !hasPrefixedIdentity) return null;

  const direct = Number(item.productId ?? item.tcgplayerProductId);
  if (Number.isSafeInteger(direct) && direct > 0) return direct;

  for (const identifier of identifiers) {
    const match = /^(?:tcgcsv:)?\d+:\d+:(\d+)$/i.exec(identifier);
    const productId = Number(match?.[1]);
    if (Number.isSafeInteger(productId) && productId > 0) return productId;
  }
  return null;
}

export function catalogImageSources(item = {}) {
  const userImage = firstSafeImage([item.userImage]);
  const modern = [item.imageAvif, item.imageWebp].map(safeImageUrl).filter(Boolean);
  const explicitSmall = firstSafeImage([
    item.imageSmall,
    item.image_small,
    item.thumbnailUrl,
    item.thumbnail,
    item.images?.small,
    item.images?.thumbnail
  ]);
  const explicitLarge = firstSafeImage([
    item.image,
    item.imageUrl,
    item.image_url,
    item.imageURL,
    extendedImage(item),
    item.images?.large,
    item.images?.full,
    item.images?.original
  ]);
  const productId = tcgcsvProductIdForItem(item);
  const derivedSmall = tcgcsvProductImageUrl(productId, 400);
  const derivedLarge = tcgcsvProductImageUrl(productId, 1000);
  const sources = [...new Set([
    userImage,
    ...modern,
    explicitSmall,
    explicitLarge,
    derivedSmall,
    derivedLarge
  ].filter(Boolean))];

  return {
    sources,
    small: explicitSmall || derivedSmall || explicitLarge || derivedLarge,
    large: explicitLarge || derivedLarge || explicitSmall || derivedSmall,
    zoom: userImage || modern[0] || explicitLarge || derivedLarge || explicitSmall || derivedSmall
  };
}
