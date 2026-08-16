export const PRICING_POLICY_VERSION = 'rights-aware-v2-private-test';
export const TCGCSV_PRIVATE_TEST_ENTITLEMENT = 'authenticated-private-test';

const SUPPORTED_PRICING_POLICY_VERSIONS = new Set([
  'rights-aware-v1',
  PRICING_POLICY_VERSION
]);

const RESTRICTED_PROVIDERS = new Set([
  'pokemon', 'pokemontcg', 'pokemon-tcg-api', 'pokemon tcg api',
  'tcgplayer', 'cardmarket', 'tcgcsv'
]);
const RESTRICTED_SOURCE_MARKERS = [
  'tcgplayer', 'cardmarket', 'pokemon tcg api', 'pokémon tcg api', 'tcgcsv'
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
  if (provider === 'tcgcsv' && value.pricingEntitlement === TCGCSV_PRIVATE_TEST_ENTITLEMENT) return false;
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

export function isSupportedPricingPolicyVersion(value) {
  return SUPPORTED_PRICING_POLICY_VERSIONS.has(value);
}

export function currentPricingSnapshots(snapshots = [], currency = 'USD') {
  if (!Array.isArray(snapshots)) return [];
  const selectedCurrency = String(currency || 'USD').toUpperCase();
  const eligible = snapshots.filter((snapshot) =>
    isSupportedPricingPolicyVersion(snapshot?.pricingPolicyVersion)
    && String(snapshot.currency || 'USD').toUpperCase() === selectedCurrency
  );
  const points = new Map();
  eligible.forEach((snapshot, index) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.date || '')) ? snapshot.date : '';
    const key = date || `id:${snapshot.id || index}`;
    const current = points.get(key);
    if (!current) {
      points.set(key, snapshot);
      return;
    }
    const timestampOrder = String(snapshot.updatedAt || '').localeCompare(String(current.updatedAt || ''));
    const canonicalId = date ? `portfolio:${selectedCurrency}:${date}` : '';
    if (timestampOrder > 0 || (timestampOrder === 0 && snapshot.id === canonicalId && current.id !== canonicalId)) {
      points.set(key, snapshot);
    }
  });
  return [...points.values()];
}
