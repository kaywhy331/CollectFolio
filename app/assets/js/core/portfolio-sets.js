import {
  holdingMarketCurrency,
  holdingMarketValue,
  holdingPricingStatus
} from './calculations.js';
import { normalizeQuery } from './utils.js';

const setNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function copies(holding = {}) {
  const quantity = Number(holding.quantity);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

function identityPart(value, fallback = '-') {
  return normalizeQuery(String(value ?? '').normalize('NFKC')) || fallback;
}

function printingIdentity(holding = {}) {
  const item = holding.item || {};
  const canonical = identityPart(holding.canonicalVariantId, '');
  if (canonical) return `variant:${canonical}`;
  const provider = identityPart(item.provider || item.category, 'custom');
  const externalId = String(item.externalId || '').trim();
  const language = identityPart(item.language, 'en');
  const edition = identityPart(item.edition, 'standard');
  const finish = identityPart(item.finish || item.variant, 'unspecified');
  if (externalId) return `source:${provider}:${externalId}:${language}:${edition}:${finish}`;
  return `catalog:${provider}:${identityPart(item.name)}:${identityPart(item.number)}:${language}:${edition}:${finish}`;
}

function setIdentity(holding = {}) {
  const item = holding.item || {};
  const setName = String(item.setName || '').trim();
  if (!setName) return null;
  const category = String(item.category || 'other').trim() || 'other';
  const categoryKey = identityPart(category, 'other');
  const gameKey = identityPart(item.game || item.category, categoryKey);
  return {
    id: `${gameKey}:${identityPart(setName)}`,
    gameKey,
    game: String(item.game || item.category || 'Other').trim() || 'Other',
    category,
    categoryKey,
    setName
  };
}

export function groupPortfolioSets(holdings = [], { currency = 'USD' } = {}) {
  const selectedCurrency = String(currency || 'USD').toUpperCase();
  const groups = new Map();
  let unassignedHoldings = 0;
  let unassignedCopies = 0;

  for (const holding of Array.isArray(holdings) ? holdings : []) {
    const identity = setIdentity(holding);
    if (!identity) {
      unassignedHoldings += 1;
      unassignedCopies += copies(holding);
      continue;
    }
    if (!groups.has(identity.id)) {
      groups.set(identity.id, {
        ...identity,
        holdings: [],
        holdingIds: [],
        holdingCount: 0,
        copyCount: 0,
        uniquePrintingCount: 0,
        marketValue: 0,
        pricedHoldingCount: 0,
        unpricedHoldingCount: 0,
        excludedCurrencyCount: 0,
        latestUpdatedAt: '',
        coverHolding: null,
        currency: selectedCurrency,
        printingKeys: new Set()
      });
    }
    const group = groups.get(identity.id);
    const pricingStatus = holdingPricingStatus(holding);
    const marketCurrency = holdingMarketCurrency(holding);
    group.holdings.push(holding);
    group.holdingIds.push(holding.id);
    group.holdingCount += 1;
    group.copyCount += copies(holding);
    group.printingKeys.add(printingIdentity(holding));
    if (pricingStatus === 'unpriced') group.unpricedHoldingCount += 1;
    else if (marketCurrency !== selectedCurrency) group.excludedCurrencyCount += 1;
    else {
      group.pricedHoldingCount += 1;
      group.marketValue += holdingMarketValue(holding);
    }
    const updatedAt = String(holding.updatedAt || holding.createdAt || '');
    if (updatedAt > group.latestUpdatedAt) group.latestUpdatedAt = updatedAt;
    if (!group.coverHolding || (!group.coverHolding.userImage && holding.userImage)
      || (!group.coverHolding.userImage && !group.coverHolding.item?.image && (holding.item?.image || holding.item?.imageSmall))) {
      group.coverHolding = holding;
    }
  }

  const sets = [...groups.values()].map((group) => {
    const { printingKeys, ...result } = group;
    return { ...result, uniquePrintingCount: printingKeys.size };
  });
  return {
    sets,
    totalSets: sets.length,
    distinctPrintings: sets.reduce((total, group) => total + group.uniquePrintingCount, 0),
    totalCopies: sets.reduce((total, group) => total + group.copyCount, 0),
    unassignedHoldings,
    unassignedCopies
  };
}

export function filterAndSortPortfolioSets(sets = [], controls = {}) {
  const query = normalizeQuery(controls.query);
  const category = identityPart(controls.category, 'all');
  const sort = ['recent-desc', 'alpha', 'printings-desc', 'value-desc'].includes(controls.sort)
    ? controls.sort
    : 'recent-desc';
  const filtered = (Array.isArray(sets) ? sets : []).filter((group) => {
    const matchesCategory = category === 'all' || (group.categoryKey || identityPart(group.category, 'other')) === category;
    const haystack = normalizeQuery(`${group.setName} ${group.game} ${group.category}`);
    return matchesCategory && (!query || haystack.includes(query));
  });
  return filtered.sort((left, right) => {
    if (sort === 'alpha') return setNameCollator.compare(left.setName, right.setName)
      || setNameCollator.compare(left.game, right.game);
    if (sort === 'printings-desc') return right.uniquePrintingCount - left.uniquePrintingCount
      || setNameCollator.compare(left.setName, right.setName);
    if (sort === 'value-desc') {
      if (!left.pricedHoldingCount && right.pricedHoldingCount) return 1;
      if (left.pricedHoldingCount && !right.pricedHoldingCount) return -1;
      return right.marketValue - left.marketValue || setNameCollator.compare(left.setName, right.setName);
    }
    return String(right.latestUpdatedAt).localeCompare(String(left.latestUpdatedAt))
      || setNameCollator.compare(left.setName, right.setName);
  });
}
