// catalog-v2 B2: enrichment bridge hydration (PRD Sec "B2 -- Enrichment
// bridge"). Reads the bridge table T5-equivalent worker publishes
// (`GET /catalog/bridge/<categoryId>`, built by
// analytics/src/collectfolio_analytics/catalog_bridge.py) and, for a
// TCGCSV catalog item with a mapped provider card, fetches that provider's
// own card detail to surface as *additive display data only* -- a
// higher-resolution image and a couple of provider-native fields on the
// detail view. TCGCSV stays the identity source of truth; nothing here
// ever substitutes for it.
//
// Fail-closed at every step, matching forecast-trajectory.js's contract:
// no published bridge table, no mapped product, or a failed provider
// fetch all collapse to "no enrichment" -- the item renders exactly as it
// does today, never a partially-wrong join.
//
// Deliberately lazy: callers invoke this from detail-view hydration only
// (see app.js's hydrateCardRoute), never from browse/search list
// hydration -- provider APIs get one request per opened detail view, not
// one per list row (API etiquette, PRD B2 "APP" note).
import { getRecord, putRecord } from '../core/db.js';
import { getTCGCSVProduct, requestTCGCSVCatalog, tcgcsvGameId } from './providers/tcgcsv.js';
import { getPokemonCard } from './providers/pokemon.js';
import { getScryfallCard } from './providers/scryfall.js';
import { getYGOCard } from './providers/ygoprodeck.js';

const CACHE_PREFIX = 'bridge:v1:';
const BRIDGE_CACHE_MS = 6 * 60 * 60 * 1000;
const CARD_CACHE_MS = 24 * 60 * 60 * 1000;

// Mirrors catalog_bridge.FLAGSHIP_PROVIDERS (analytics side) -- the set of
// providers a bridge table's `provider` field can legitimately name.
const PROVIDER_CARD_FETCHERS = Object.freeze({
  pokemon: getPokemonCard,
  scryfall: getScryfallCard,
  ygoprodeck: getYGOCard
});

const BRIDGE_CATEGORY_IDS = Object.freeze({
  scryfall: Object.freeze([1]),
  ygoprodeck: Object.freeze([2]),
  pokemon: Object.freeze([3, 85])
});

function bridgeCacheKey(categoryId) {
  return `${CACHE_PREFIX}${categoryId}`;
}

function cardCacheKey(provider, externalId) {
  return `${CACHE_PREFIX}card:${provider}:${externalId}`;
}

async function cached(key, ttlMs, loader) {
  const record = await getRecord('catalogCache', key).catch(() => null);
  if (record?.expiresAt > Date.now() && record.value !== undefined) return record.value;
  const value = await loader();
  await putRecord('catalogCache', { key, expiresAt: Date.now() + ttlMs, value }).catch(() => {});
  return value;
}

export async function fetchBridgeTable(categoryId, { session, fetchImpl, bypassCache = false } = {}) {
  const load = async () => {
    try {
      const payload = await requestTCGCSVCatalog(`/catalog/bridge/${categoryId}`, { session, fetchImpl });
      if (!payload || !PROVIDER_CARD_FETCHERS[payload.provider] || !Array.isArray(payload.products)) return null;
      return payload;
    } catch {
      // No published bridge table for this category (404) or a transient
      // request failure -- both are "nothing is mapped yet", never a
      // surfaced error.
      return null;
    }
  };
  if (bypassCache) {
    const value = await load();
    await putRecord('catalogCache', { key: bridgeCacheKey(categoryId), expiresAt: Date.now() + BRIDGE_CACHE_MS, value }).catch(() => {});
    return value;
  }
  return cached(bridgeCacheKey(categoryId), BRIDGE_CACHE_MS, load);
}

export function bridgeProductMatch(bridgeTable, groupId, productId) {
  if (!bridgeTable || !Array.isArray(bridgeTable.products)) return null;
  return bridgeTable.products.find((row) => Number(row.groupId) === Number(groupId) && Number(row.productId) === Number(productId)) || null;
}

export function bridgeProviderMatches(bridgeTable, provider, externalId) {
  if (!bridgeTable || bridgeTable.provider !== provider || !Array.isArray(bridgeTable.products) || !externalId) return [];
  return bridgeTable.products.filter((row) => String(row.providerCardId || '') === String(externalId));
}

function uniqueBridgeIdentity(categoryId, row) {
  const groupId = Number(row?.groupId);
  const productId = Number(row?.productId);
  if (![categoryId, groupId, productId].every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  return { categoryId, groupId, productId, externalId: `${categoryId}:${groupId}:${productId}` };
}

// Reverse the approved bridge for image-only provider candidates. The bridge,
// rather than image similarity, supplies the exact TCGCSV identity. Ambiguous
// or unpublished mappings remain provider candidates and therefore cannot be
// approved as exact by the intake service.
export async function mapProviderCandidatesToTCGCSV(candidates = [], opts = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const fetchTable = opts.fetchTable || fetchBridgeTable;
  const fetchOpts = { ...opts };
  delete fetchOpts.fetchTable;
  const providers = [...new Set(rows.map((item) => String(item?.provider || '')).filter((provider) => BRIDGE_CATEGORY_IDS[provider]))];
  const tables = new Map();
  await Promise.all(providers.flatMap((provider) => BRIDGE_CATEGORY_IDS[provider].map(async (categoryId) => {
    const table = await fetchTable(categoryId, fetchOpts);
    if (table?.provider === provider) tables.set(`${provider}:${categoryId}`, table);
  })));

  return rows.map((item) => {
    const provider = String(item?.provider || '');
    const identities = (BRIDGE_CATEGORY_IDS[provider] || []).flatMap((categoryId) =>
      bridgeProviderMatches(tables.get(`${provider}:${categoryId}`), provider, item.externalId)
        .map((row) => ({ identity: uniqueBridgeIdentity(categoryId, row), row }))
        .filter((entry) => entry.identity));
    const unique = [...new Map(identities.map((entry) => [entry.identity.externalId, entry])).values()];
    if (unique.length !== 1) {
      return { ...item, matchBucket: 'likely', tcgcsvMappingStatus: unique.length ? 'ambiguous' : 'unmapped' };
    }
    const { identity, row } = unique[0];
    const visualSource = {
      provider,
      externalId: String(item.externalId || ''),
      matchMethod: String(row.matchMethod || ''),
      image: String(item.image || ''),
      imageSmall: String(item.imageSmall || '')
    };
    return {
      ...item,
      id: `tcgcsv:${identity.externalId}`,
      externalId: identity.externalId,
      provider: 'tcgcsv',
      category: tcgcsvGameId(identity.categoryId),
      categoryId: identity.categoryId,
      groupId: identity.groupId,
      productId: identity.productId,
      matchBucket: 'exact',
      tcgcsvMappingStatus: 'mapped',
      visualSource,
      enrichment: { ...visualSource, name: item.name || '', rarity: item.rarity || '' }
    };
  });
}

// Fetch the complete TCGCSV record only for the candidate the collector
// selects. This retains lazy catalog behavior while ensuring the saved holding
// carries TCGCSV prices, attributes, and trajectory keys.
export async function hydrateMappedVisualCandidate(candidate = {}, opts = {}) {
  if (candidate.provider !== 'tcgcsv' || candidate.tcgcsvMappingStatus !== 'mapped') return candidate;
  const getProduct = opts.getProduct || getTCGCSVProduct;
  const requestOpts = { ...opts };
  delete requestOpts.getProduct;
  try {
    const product = await getProduct(candidate.externalId, requestOpts);
    if (!product) return candidate;
    const source = candidate.visualSource || {};
    return {
      ...candidate,
      ...product,
      image: source.image || product.image,
      imageSmall: source.imageSmall || source.image || product.imageSmall,
      matchBucket: 'exact',
      matchScore: candidate.matchScore,
      visualScore: candidate.visualScore,
      tcgcsvMappingStatus: 'mapped',
      visualSource: source,
      enrichment: candidate.enrichment || null
    };
  } catch {
    // The approved bridge already supplies exact identity. A transient detail
    // request must not replace it with a guessed or legacy identity.
    return candidate;
  }
}

export async function fetchProviderCard(provider, externalId, opts = {}) {
  const fetcher = PROVIDER_CARD_FETCHERS[provider];
  if (!fetcher || !externalId) return null;
  const load = async () => {
    try {
      return await fetcher(externalId);
    } catch {
      return null;
    }
  };
  if (opts.bypassCache) {
    const value = await load();
    await putRecord('catalogCache', { key: cardCacheKey(provider, externalId), expiresAt: Date.now() + CARD_CACHE_MS, value }).catch(() => {});
    return value;
  }
  return cached(cardCacheKey(provider, externalId), CARD_CACHE_MS, load);
}

// Top-level lookup for a TCGCSV catalog item: bridge table -> mapped
// product -> provider card -> a small additive display-fields object, or
// null at any fail-closed branch.
export async function getEnrichmentForItem(item = {}, opts = {}) {
  if (item?.provider !== 'tcgcsv') return null;
  const { categoryId, groupId, productId } = item;
  if (![categoryId, groupId, productId].every((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0)) return null;
  const bridgeTable = await fetchBridgeTable(categoryId, opts);
  const match = bridgeProductMatch(bridgeTable, groupId, productId);
  if (!match) return null;
  const card = await fetchProviderCard(bridgeTable.provider, match.providerCardId, opts);
  if (!card) return null;
  return {
    provider: bridgeTable.provider,
    matchMethod: match.matchMethod,
    name: card.name || '',
    image: card.image || '',
    imageSmall: card.imageSmall || '',
    rarity: card.rarity || '',
    priceUrl: card.priceUrl || ''
  };
}

// Folds enrichment onto a TCGCSV item for display without mutating the
// original. `preferProviderImage` distinguishes the two PRD-specified
// contexts: detail view prefers the provider's high-res art when mapped
// (true); browse/list tiles keep the fast TCGCSV image and only fall back
// to the provider one when TCGCSV has none (false/default).
export function applyEnrichmentToItem(item, enrichment, { preferProviderImage = false } = {}) {
  if (!enrichment) return item;
  if (preferProviderImage && enrichment.image) {
    // externalImage() (core/components.js) renders whichever of
    // [userImage, imageSmall, image] resolves first as `src`, the next
    // as a `data-fallback-src` for on-error swap. Put the provider's
    // high-res art in the `imageSmall` slot so it wins that priority
    // race for the detail view, keeping TCGCSV's own image as the
    // fallback rather than discarding it.
    return { ...item, enrichment, imageSmall: enrichment.image, image: item.image || enrichment.image };
  }
  const useProviderImage = !item.image && Boolean(enrichment.image);
  return {
    ...item,
    enrichment,
    image: useProviderImage ? enrichment.image : item.image,
    imageSmall: item.imageSmall || enrichment.imageSmall || ''
  };
}
