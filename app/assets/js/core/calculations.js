const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function unitMarketValue(holding) {
  const manual = holding?.manualMarketPrice;
  if (manual !== '' && manual !== null && manual !== undefined && Number.isFinite(Number(manual))) return Math.max(0, Number(manual));
  return Math.max(0, number(holding?.item?.price));
}

export function holdingMarketValue(holding) {
  return unitMarketValue(holding) * Math.max(0, number(holding?.quantity));
}

export function holdingCostBasis(holding) {
  return (Math.max(0, number(holding?.purchasePrice)) * Math.max(0, number(holding?.quantity))) + Math.max(0, number(holding?.fees));
}

export function holdingGain(holding) {
  return holdingMarketValue(holding) - holdingCostBasis(holding);
}

export function returnPercent(marketValue, costBasis) {
  const cost = number(costBasis);
  return cost > 0 ? ((number(marketValue) - cost) / cost) * 100 : null;
}

export function portfolioSummary(holdings = []) {
  const result = holdings.reduce((summary, holding) => {
    summary.marketValue += holdingMarketValue(holding);
    summary.costBasis += holdingCostBasis(holding);
    summary.totalQuantity += Math.max(0, number(holding.quantity));
    return summary;
  }, { marketValue: 0, costBasis: 0, gain: 0, returnPercent: null, uniqueItems: holdings.length, totalQuantity: 0 });
  result.gain = result.marketValue - result.costBasis;
  result.returnPercent = returnPercent(result.marketValue, result.costBasis);
  return result;
}

export function portfolioAllocation(holdings = []) {
  return holdings.reduce((allocation, holding) => {
    const category = holding.item?.category || 'other';
    allocation[category] = (allocation[category] || 0) + holdingMarketValue(holding);
    return allocation;
  }, {});
}

export function filterAndSortHoldings(holdings = [], { query = '', category = 'all', sort = 'value-desc' } = {}) {
  const needle = String(query).trim().toLowerCase();
  const filtered = holdings.filter((holding) => {
    const item = holding.item || {};
    const matchesCategory = category === 'all' || item.category === category;
    const haystack = [item.name, item.setName, item.number, item.game, holding.folder, holding.notes, holding.gradeCompany, holding.grade].join(' ').toLowerCase();
    return matchesCategory && (!needle || haystack.includes(needle));
  });
  const compare = {
    'value-desc': (a, b) => holdingMarketValue(b) - holdingMarketValue(a),
    'gain-desc': (a, b) => holdingGain(b) - holdingGain(a),
    'name-asc': (a, b) => String(a.item?.name || '').localeCompare(String(b.item?.name || '')),
    'recent-desc': (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  }[sort] || ((a, b) => holdingMarketValue(b) - holdingMarketValue(a));
  return filtered.sort(compare);
}

export function snapshotFor(holdings = [], date = new Date()) {
  const summary = portfolioSummary(holdings);
  const day = new Date(date).toISOString().slice(0, 10);
  return {
    id: `portfolio:${day}`,
    date: day,
    marketValue: summary.marketValue,
    costBasis: summary.costBasis,
    uniqueItems: summary.uniqueItems,
    totalQuantity: summary.totalQuantity,
    updatedAt: new Date(date).toISOString()
  };
}
