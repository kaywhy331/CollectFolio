import { catalogPriceForValuation, PRICING_POLICY_VERSION } from './pricing-policy.js';

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const currencyCode = (value, fallback = 'USD') => {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
};
const hasManualValue = (holding) => holding?.manualMarketPrice !== ''
  && holding?.manualMarketPrice !== null
  && holding?.manualMarketPrice !== undefined
  && Number.isFinite(Number(holding.manualMarketPrice));

export function holdingMarketCurrency(holding = {}) {
  if (hasManualValue(holding)) {
    return currencyCode(holding.manualMarketCurrency || holding.valueCurrency || holding.currency || holding.item?.currency);
  }
  return currencyCode(holding.item?.currency || holding.currency);
}

export function holdingCostCurrency(holding = {}) {
  return currencyCode(holding.purchaseCurrency || holding.costCurrency || holding.currency || holding.item?.currency);
}

export function unitMarketValue(holding, currency = null) {
  if (currency && holdingMarketCurrency(holding) !== currencyCode(currency)) return 0;
  const manual = holding?.manualMarketPrice;
  if (hasManualValue(holding)) return Math.max(0, Number(manual));
  return catalogPriceForValuation(holding?.item) ?? 0;
}

export function holdingMarketValue(holding, currency = null) {
  return unitMarketValue(holding, currency) * Math.max(0, number(holding?.quantity));
}

export function holdingCostBasis(holding, currency = null) {
  if (currency && holdingCostCurrency(holding) !== currencyCode(currency)) return 0;
  return (Math.max(0, number(holding?.purchasePrice)) * Math.max(0, number(holding?.quantity))) + Math.max(0, number(holding?.fees));
}

export function holdingGain(holding, currency = null) {
  const marketCurrency = holdingMarketCurrency(holding);
  const costCurrency = holdingCostCurrency(holding);
  const requested = currency ? currencyCode(currency) : null;
  if (marketCurrency !== costCurrency || (requested && marketCurrency !== requested)) return null;
  return holdingMarketValue(holding) - holdingCostBasis(holding);
}

export function returnPercent(marketValue, costBasis) {
  const cost = number(costBasis);
  return cost > 0 ? ((number(marketValue) - cost) / cost) * 100 : null;
}

export function portfolioSummary(holdings = [], { currency = 'USD' } = {}) {
  const selectedCurrency = currencyCode(currency);
  const excludedCurrencies = new Set();
  const result = holdings.reduce((summary, holding) => {
    const marketCurrency = holdingMarketCurrency(holding);
    const costCurrency = holdingCostCurrency(holding);
    const marketMatches = marketCurrency === selectedCurrency;
    const costMatches = costCurrency === selectedCurrency;
    const marketValue = holdingMarketValue(holding);
    const costBasis = holdingCostBasis(holding);
    if (marketMatches) summary.marketValue += marketValue;
    else {
      summary.excludedMarketItems += 1;
      excludedCurrencies.add(marketCurrency);
    }
    if (costMatches) summary.costBasis += costBasis;
    else {
      summary.excludedCostItems += 1;
      excludedCurrencies.add(costCurrency);
    }
    if (marketMatches && costMatches) {
      summary.comparableMarketValue += marketValue;
      summary.comparableCostBasis += costBasis;
    } else summary.excludedGainItems += 1;
    summary.totalQuantity += Math.max(0, number(holding.quantity));
    return summary;
  }, {
    currency: selectedCurrency,
    marketValue: 0,
    costBasis: 0,
    comparableMarketValue: 0,
    comparableCostBasis: 0,
    gain: 0,
    returnPercent: null,
    uniqueItems: holdings.length,
    totalQuantity: 0,
    excludedMarketItems: 0,
    excludedCostItems: 0,
    excludedGainItems: 0,
    excludedCurrencies: []
  });
  result.gain = result.comparableMarketValue - result.comparableCostBasis;
  result.returnPercent = returnPercent(result.comparableMarketValue, result.comparableCostBasis);
  result.excludedCurrencies = [...excludedCurrencies].sort();
  return result;
}

export function portfolioAllocation(holdings = [], { currency = 'USD' } = {}) {
  return holdings.reduce((allocation, holding) => {
    const category = holding.item?.category || 'other';
    allocation[category] = (allocation[category] || 0) + holdingMarketValue(holding, currency);
    return allocation;
  }, {});
}

export function holdingPricingStatus(holding = {}) {
  const manual = holding.manualMarketPrice;
  if (manual !== '' && manual !== null && manual !== undefined && Number.isFinite(Number(manual))) return 'manual';
  return catalogPriceForValuation(holding.item) === null ? 'unpriced' : 'market';
}

function ownershipType(holding = {}) {
  const category = String(holding.item?.category || '').toLowerCase();
  const productType = String(holding.item?.productType || holding.item?.type || '').toLowerCase();
  if (category === 'sealed' || productType.includes('sealed')) return 'sealed';
  return holding.grade || holding.gradeCompany || String(holding.condition || '').toLowerCase() === 'graded' ? 'graded' : 'raw';
}

export function filterAndSortHoldings(holdings = [], { query = '', category = 'all', sort = 'value-desc', filters = {}, currency = 'USD' } = {}) {
  const needle = String(query).trim().toLowerCase();
  const selected = { ...filters };
  const matches = (value, filter) => !filter || String(value || '').toLowerCase().includes(String(filter).toLowerCase());
  const filtered = holdings.filter((holding) => {
    const item = holding.item || {};
    const matchesCategory = category === 'all' || item.category === category;
    const haystack = [item.name, item.setName, item.number, item.game, holding.seller, holding.folder, ...(holding.tags || []), holding.notes, holding.gradeCompany, holding.grade].join(' ').toLowerCase();
    const gain = holdingGain(holding, currency);
    return matchesCategory
      && (!needle || haystack.includes(needle))
      && matches(item.setName, selected.setName)
      && (!selected.ownership || ownershipType(holding) === selected.ownership)
      && matches(holding.condition, selected.condition)
      && matches(holding.gradeCompany, selected.gradeCompany)
      && matches(item.language, selected.language)
      && (!selected.tags || (holding.tags || []).some((tag) => matches(tag, selected.tags)))
      && (!selected.pricing || holdingPricingStatus(holding) === selected.pricing)
      && (!selected.performance || (gain !== null && (selected.performance === 'gain' ? gain >= 0 : gain < 0)));
  });
  const comparableGain = (holding) => holdingGain(holding, currency);
  const missingLast = (left, right, direction = -1) => {
    const a = comparableGain(left);
    const b = comparableGain(right);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * direction;
  };
  const compare = {
    'value-desc': (a, b) => holdingMarketValue(b, currency) - holdingMarketValue(a, currency),
    'gain-desc': (a, b) => missingLast(a, b),
    'gain-asc': (a, b) => missingLast(a, b, 1),
    'name-asc': (a, b) => String(a.item?.name || '').localeCompare(String(b.item?.name || '')),
    'set-asc': (a, b) => String(a.item?.setName || '').localeCompare(String(b.item?.setName || '')) || String(a.item?.number || '').localeCompare(String(b.item?.number || ''), undefined, { numeric: true }),
    'quantity-desc': (a, b) => number(b.quantity) - number(a.quantity),
    'missing-desc': (a, b) => Number(holdingPricingStatus(b) === 'unpriced') - Number(holdingPricingStatus(a) === 'unpriced'),
    'recent-desc': (a, b) => String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || '')),
    'updated-desc': (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  }[sort] || ((a, b) => holdingMarketValue(b, currency) - holdingMarketValue(a, currency));
  return filtered.sort(compare);
}

export function portfolioSnapshotId(date, currency = 'USD') {
  const value = date instanceof Date ? date.toISOString() : String(date || '');
  const day = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] || new Date(date).toISOString().slice(0, 10);
  return `portfolio:${currencyCode(currency)}:${day}`;
}

export function snapshotFor(holdings = [], date = new Date(), { currency = 'USD' } = {}) {
  const summary = portfolioSummary(holdings, { currency });
  const day = new Date(date).toISOString().slice(0, 10);
  return {
    id: portfolioSnapshotId(day, summary.currency),
    date: day,
    pricingPolicyVersion: PRICING_POLICY_VERSION,
    currency: summary.currency,
    marketValue: summary.marketValue,
    costBasis: summary.costBasis,
    uniqueItems: summary.uniqueItems,
    totalQuantity: summary.totalQuantity,
    updatedAt: new Date(date).toISOString()
  };
}
