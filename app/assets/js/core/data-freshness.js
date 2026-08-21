const DAY_MS = 86_400_000;

export const PROVIDER_FRESHNESS_DAYS = Object.freeze({
  scryfall: 2,
  pokemon: 3,
  pokemontcg: 3,
  ygoprodeck: 7,
  tcgcsv: 7,
  custom: 30,
  default: 7
});

function validDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function providerFreshnessThresholdDays(provider = '', overrides = {}) {
  const key = String(provider || '').trim().toLowerCase();
  const configured = Number(overrides[key] ?? PROVIDER_FRESHNESS_DAYS[key] ?? overrides.default ?? PROVIDER_FRESHNESS_DAYS.default);
  return Number.isFinite(configured) && configured > 0 ? configured : PROVIDER_FRESHNESS_DAYS.default;
}

export function priceFreshness(item = {}, now = new Date(), overrides = {}) {
  const updated = validDate(item.priceUpdatedAt || item.observedAt || item.updatedAt);
  const current = validDate(now) || new Date();
  if (!updated) return { state: 'unknown', label: 'Update time unavailable', ageDays: null, updatedAt: '' };
  const ageMs = Math.max(0, current.valueOf() - updated.valueOf());
  const ageDays = ageMs / DAY_MS;
  const threshold = providerFreshnessThresholdDays(item.provider, overrides);
  if (ageDays < 1) return { state: 'today', label: 'Updated today', ageDays, updatedAt: updated.toISOString() };
  if (ageDays <= threshold) {
    const days = Math.max(1, Math.floor(ageDays));
    return { state: 'recent', label: `Updated recently · ${days} day${days === 1 ? '' : 's'} ago`, ageDays, updatedAt: updated.toISOString() };
  }
  const date = updated.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: updated.getFullYear() === current.getFullYear() ? undefined : 'numeric' });
  return { state: 'stale', label: `Price may be stale · ${date}`, ageDays, updatedAt: updated.toISOString() };
}

export function collectionFreshness(holdings = [], now = new Date(), overrides = {}) {
  const priced = holdings
    .filter((holding) => holding?.manualMarketPrice === '' || holding?.manualMarketPrice === null || holding?.manualMarketPrice === undefined)
    .map((holding) => priceFreshness(holding.item || {}, now, overrides));
  const known = priced.filter((entry) => entry.updatedAt);
  const stale = known.filter((entry) => entry.state === 'stale').length;
  const latest = known.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    || { state: 'unknown', label: 'Update time unavailable', ageDays: null, updatedAt: '' };
  return { latest, stale, known: known.length };
}
