export const PRICING_POLICY_VERSION = 'rights-aware-v1';

const RESTRICTED_PROVIDERS = new Set([
  'pokemon', 'pokemontcg', 'pokemon-tcg-api', 'pokemon tcg api',
  'tcgplayer', 'cardmarket'
]);
const RESTRICTED_SOURCE_MARKERS = [
  'tcgplayer', 'cardmarket', 'pokemon tcg api', 'pokémon tcg api'
];

const finitePrice = (value) => {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Math.max(0, Number(value));
};
const catalogItem = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function isRestrictedCatalogPrice(item = {}) {
  const value = catalogItem(item);
  const options = Array.isArray(value.priceOptions) ? value.priceOptions : [];
  const hasPrice = finitePrice(value.price) !== null || options.some((entry) => finitePrice(entry?.price) !== null);
  if (!hasPrice) return false;
  const provider = String(value.provider || '').trim().toLowerCase();
  const sources = [value.priceSource, ...options.map((entry) => entry?.source)]
    .map((value) => String(value || '').trim().toLowerCase());
  return RESTRICTED_PROVIDERS.has(provider) || sources.some((source) =>
    RESTRICTED_SOURCE_MARKERS.some((marker) => source.includes(marker))
  );
}

export function catalogPriceOptionsForDisplay(item = {}) {
  const value = catalogItem(item);
  return isRestrictedCatalogPrice(value) || !Array.isArray(value.priceOptions)
    ? []
    : value.priceOptions;
}

export function catalogPriceForValuation(item = {}) {
  const value = catalogItem(item);
  const price = finitePrice(value.price);
  return price === null || isRestrictedCatalogPrice(value) ? null : price;
}

export function catalogPriceDisclosure(item = {}) {
  if (!isRestrictedCatalogPrice(item)) return '';
  return 'Stored provider reference excluded pending licensed source rights';
}

export function currentPricingSnapshots(snapshots = []) {
  if (!Array.isArray(snapshots)) return [];
  return snapshots.filter((snapshot) =>
    snapshot?.pricingPolicyVersion === PRICING_POLICY_VERSION
  );
}
