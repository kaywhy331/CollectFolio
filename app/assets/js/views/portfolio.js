import { emptyState, externalImage, pageHeader } from '../core/components.js';
import { icon } from '../core/icons.js';
import { normalizeIntelligencePayload, trendLabel } from '../core/intelligence-contract.js';
import { filterAndSortHoldings, holdingCostBasis, holdingCostCurrency, holdingGain, holdingMarketCurrency, holdingMarketValue, holdingPricingStatus, portfolioSummary, returnPercent } from '../core/calculations.js';
import { catalogPriceDisclosure, catalogPriceForValuation } from '../core/pricing-policy.js';
import { filterAndSortPortfolioSets, groupPortfolioSets } from '../core/portfolio-sets.js';
import { forecastProjectionChart } from '../core/ui.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { selectPublicationForHolding, selectPublicationForWatchlist } from '../core/market-series.js';
import { findWatchedItem } from '../services/watchlist.js';
import { SUPPORT_BADGES } from '../core/copy.js';
import { historyPointsByHoldingId, overviewChange, overviewSeriesWithHistory } from './home.js';

export const PORTFOLIO_VIEWS = Object.freeze(['gallery', 'list']);
export const PORTFOLIO_SET_PAGE_SIZE = 60;

export function renderPortfolio(state) {
  const watchlistsEnabled = state.featureFlags?.watchlists !== false;
  const section = watchlistsEnabled ? state.portfolio.section || 'holdings' : 'holdings';
  // DCL-LEX-09: storage/local-first messaging is shell-owned; page
  // subtitles drop "saved on this device" and equivalents.
  // DCL-COLL-08/DCL-NAV-01: the forecasts label is eyebrow "Collection",
  // title "Forecasts" -- "Insights" stays the one app-wide surface with
  // that title.
  const labels = {
    holdings: ['Personal Collection', 'Collection', `${state.holdings.length} purchase${state.holdings.length === 1 ? '' : 's'} in your collection.`],
    sets: ['Collection map', 'Sets', 'Group the exact printings already recorded in your collection.'],
    watchlist: ['Collection', 'Watchlist', `${state.watchlistItems.length} exact variant${state.watchlistItems.length === 1 ? '' : 's'} tracked.`],
    forecasts: ['Collection', 'Forecasts', '']
  };
  const [eyebrow, title, subtitle] = labels[section] || labels.holdings;
  const refresh = section === 'holdings'
    ? `<button class="icon-button" type="button" data-action="refresh-prices" aria-label="Refresh prices">${icon('refresh', { size: 20 })}</button>`
    : '';
  return `${pageHeader(eyebrow, title, subtitle, refresh)}
    ${section !== 'forecasts' ? segmentedControl(section, watchlistsEnabled) : ''}
    ${section === 'sets' ? setsSection(state) : section === 'watchlist' ? watchlistSection(state) : section === 'forecasts' ? forecastSection(state) : holdingsSection(state)}`;
}

function segmentedControl(section, watchlistsEnabled) {
  const sections = [['holdings', 'Items'], ['sets', 'Sets'], ...(watchlistsEnabled ? [['watchlist', 'Watchlist']] : [])];
  return `<div class="segmented-control" role="tablist" aria-label="Collection sections">
    ${sections.map(([value, label]) => `<button type="button" role="tab" class="segment-button ${section === value ? 'active' : ''}" aria-selected="${section === value}" data-portfolio-section="${value}">${label}</button>`).join('')}
  </div>`;
}

function readableDate(value) {
  if (!value || Number.isNaN(new Date(value).valueOf())) return 'Date unavailable';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function setValueStatus(group, currency) {
  const value = group.pricedHoldingCount ? formatCurrency(group.marketValue, currency) : 'Unpriced';
  const gaps = [
    group.unpricedHoldingCount ? `${group.unpricedHoldingCount} unpriced` : '',
    group.excludedCurrencyCount ? `${group.excludedCurrencyCount} other-currency excluded` : ''
  ].filter(Boolean).join(' · ');
  return { value, gaps: gaps || `${group.pricedHoldingCount} valued purchase${group.pricedHoldingCount === 1 ? '' : 's'}` };
}

// DCL-COLL-03: the per-card catalog-total disclaimer and the "saved on
// this device" small (shell-owned per DCL-LEX-09) are gone; the card keeps
// only what's specific to this set.
function portfolioSetCard(group, currency) {
  const cover = group.coverHolding || {};
  const value = setValueStatus(group, currency);
  return `<article class="portfolio-set-card"><div class="portfolio-set-art">${externalImage({ ...(cover.item || {}), userImage: cover.userImage }, 'holding-image')}<span>${escapeHTML(group.game)}</span></div><div class="portfolio-set-main"><div><p class="eyebrow">${escapeHTML(group.game || group.category)}</p><h3>${escapeHTML(group.setName)}</h3><p>${group.uniquePrintingCount} distinct printing${group.uniquePrintingCount === 1 ? '' : 's'} · ${group.copyCount} cop${group.copyCount === 1 ? 'y' : 'ies'} across ${group.holdingCount} purchase${group.holdingCount === 1 ? '' : 's'}</p></div><dl><div><dt>Tracked value</dt><dd>${escapeHTML(value.value)}<small>${escapeHTML(value.gaps)}</small></dd></div><div><dt>Last changed</dt><dd>${escapeHTML(readableDate(group.latestUpdatedAt))}</dd></div></dl><button class="button secondary small" type="button" data-action="view-set-holdings" data-set-name="${escapeAttribute(group.setName)}" data-set-category="${escapeAttribute(group.category)}">View items</button></div></article>`;
}

const DEFAULT_CATEGORY_LABELS = Object.freeze({
  pokemon: 'Pokémon', magic: 'Magic: The Gathering', yugioh: 'Yu-Gi-Oh!',
  sports: 'Sports', comics: 'Comics', slab: 'Graded slab', other: 'Other'
});

function categoryLabels(holdings = []) {
  const labels = new Map(Object.entries(DEFAULT_CATEGORY_LABELS));
  holdings.forEach((holding) => {
    const category = String(holding?.item?.category || '');
    const game = String(holding?.item?.game || '').trim();
    if (category && game) labels.set(category, game);
  });
  return labels;
}

function categoryLabel(category, holdings = []) {
  if (category === 'all') return 'All categories';
  return categoryLabels(holdings).get(category) || category;
}

function setsSection(state) {
  const currency = state.settings.currency || 'USD';
  const collection = groupPortfolioSets(state.holdings, { currency });
  // DCL-COLL-09: both no-data variants of the Sets empty state collapse to
  // the same one-sentence copy; each keeps its own existing actions.
  if (!state.holdings.length) return emptyState('No sets yet', 'Add a set name to an item and it appears here.', '<div class="button-row centered"><button class="button" type="button" data-go="add">Scan an item</button><button class="button ghost" type="button" data-go="search">Search catalog</button></div>');
  if (!collection.totalSets) return emptyState('No sets yet', 'Add a set name to an item and it appears here.', '<button class="button" type="button" data-go="portfolio" data-portfolio-target="holdings">Review items</button>');
  const controls = {
    query: state.portfolio.setQuery || '',
    category: state.portfolio.setCategory || 'all',
    sort: state.portfolio.setSort || 'recent-desc'
  };
  const shown = filterAndSortPortfolioSets(collection.sets, controls);
  const limit = Math.max(1, Number(state.portfolio.setLimit) || PORTFOLIO_SET_PAGE_SIZE);
  const visible = shown.slice(0, limit);
  const categories = [...new Map(collection.sets.map((group) => [group.category, group.game || group.category])).entries()]
    .sort((left, right) => String(left[1]).localeCompare(String(right[1])));
  const unassigned = collection.unassignedHoldings
    ? `<p class="fine-print" role="status">${collection.unassignedHoldings} item${collection.unassignedHoldings === 1 ? '' : 's'} (${collection.unassignedCopies} cop${collection.unassignedCopies === 1 ? 'y' : 'ies'}) without a set name stays in Items and is never placed in a guessed group.</p>`
    : '';
  return `<section class="portfolio-sets-summary" aria-label="Set collection summary"><dl><div><dt>Named sets</dt><dd>${collection.totalSets}</dd></div><div><dt>Distinct printings</dt><dd>${collection.distinctPrintings}</dd></div><div><dt>Copies in named sets</dt><dd>${collection.totalCopies}</dd></div></dl>${unassigned}</section>
    <section class="portfolio-set-controls" aria-label="Set controls"><label class="sr-only" for="portfolio-set-query">Search collected sets</label><input id="portfolio-set-query" type="search" value="${escapeAttribute(controls.query)}" placeholder="Search collected sets" data-portfolio-set-query><label>Category<select data-portfolio-set-category><option value="all">All categories</option>${categories.map(([category, label]) => `<option value="${escapeAttribute(category)}" ${controls.category === category ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('')}</select></label><label>Sort<select data-portfolio-set-sort>${[['recent-desc', 'Recently changed'], ['alpha', 'Set A–Z'], ['printings-desc', 'Most printings'], ['value-desc', 'Highest tracked value']].map(([value, label]) => `<option value="${value}" ${controls.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></section>
    <div class="portfolio-result-heading"><div><strong>${shown.length} set${shown.length === 1 ? '' : 's'}</strong><span>${shown.length === collection.totalSets ? 'All named sets' : `Filtered from ${collection.totalSets}`}</span></div>${controls.query || controls.category !== 'all' || controls.sort !== 'recent-desc' ? '<button class="button ghost small" type="button" data-action="clear-portfolio-set-filters">Clear filters</button>' : ''}</div>
    ${visible.length ? `<div class="portfolio-set-grid">${visible.map((group) => portfolioSetCard(group, currency)).join('')}</div>${shown.length > visible.length ? `<button class="button secondary portfolio-load-more" type="button" data-action="load-more-portfolio-sets">Show ${Math.min(PORTFOLIO_SET_PAGE_SIZE, shown.length - visible.length)} more</button>` : ''}` : emptyState('No sets match these filters', 'Clear the set search or category filter to see every named set in your collection.', '<button class="button ghost" type="button" data-action="clear-portfolio-set-filters">Clear filters</button>')}`;
}

function holdingsSection(state) {
  const currency = state.settings.currency || 'USD';
  const summary = portfolioSummary(state.holdings, { currency });
  const shownPurchases = filterAndSortHoldings(state.holdings, { ...state.portfolio, currency });
  const groupMode = state.portfolio.groupMode === 'purchases' ? 'purchases' : 'grouped';
  const shown = groupMode === 'grouped' ? groupMatchingHoldings(shownPurchases, currency) : shownPurchases;
  const view = PORTFOLIO_VIEWS.includes(state.portfolio.view || state.settings?.portfolioView) ? (state.portfolio.view || state.settings.portfolioView) : 'gallery';
  const selected = (state.portfolio.selected || []).filter((id) => state.holdings.some((holding) => holding.id === id));
  const selectionMode = groupMode === 'purchases' && Boolean(state.portfolio.selectionMode || selected.length);
  const limit = Math.max(1, Number(state.portfolio.limit) || 100);
  const visible = shown.slice(0, limit);
  return `${portfolioSummaryBar(state, summary, currency)}
    ${holdingsControls(state, view, groupMode, selectionMode)}
    ${bulkToolbar(selected, selectionMode)}
    <div class="portfolio-result-heading"><div><strong>${shown.length} ${groupMode === 'grouped' ? `item${shown.length === 1 ? '' : 's'}` : `purchase${shown.length === 1 ? '' : 's'}`}</strong><span>${selectionMode ? `${selected.length} selected` : groupMode === 'purchases' ? 'Showing individual purchases' : `${shownPurchases.length} purchase${shownPurchases.length === 1 ? '' : 's'} grouped by matching item`}</span></div></div>
    ${visible.length ? `<div class="portfolio-holdings ${escapeAttribute(view)}">${visible.map((entry) => groupMode === 'grouped' ? groupedHoldingCard(entry, currency, state, view) : holdingCard(entry, currency, state, view, selected.includes(entry.id), selectionMode)).join('')}</div>${shown.length > visible.length ? `<button class="button secondary portfolio-load-more" type="button" data-action="load-more-holdings">Show ${Math.min(100, shown.length - visible.length)} more</button>` : ''}` : state.holdings.length ? emptyState('No items match these filters', 'Remove a filter or clear the search to see the rest of your collection.', '<button class="button ghost" type="button" data-action="clear-portfolio-filters">Clear all filters</button>') : emptyCollectionState()}`;
}

function collectionSparkline(state, currency) {
  const historyPoints = historyPointsByHoldingId(state.holdings, state.priceHistory);
  const { points } = overviewSeriesWithHistory(
    state.holdings, state.snapshots, historyPoints, state.overview?.range || '3M', new Date(), currency
  );
  const valid = points.filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(String(point?.date)) && Number.isFinite(Number(point?.marketValue)));
  if (new Set(valid.map((point) => point.date)).size < 2) return '';
  const width = 128; const height = 38; const pad = 3;
  const values = valid.map((point) => Number(point.marketValue));
  const min = Math.min(...values); const max = Math.max(...values); const range = max - min;
  const coordinates = valid.map((point, index) => {
    const x = pad + ((width - pad * 2) * index / Math.max(1, valid.length - 1));
    const y = range ? height - pad - ((Number(point.marketValue) - min) / range) * (height - pad * 2) : height / 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const change = overviewChange(valid);
  const summary = change.amount === null
    ? 'Collection value history'
    : Math.abs(change.amount) < 0.005
      ? 'Collection value was unchanged over this range'
      : `Collection value ${change.amount > 0 ? 'increased' : 'decreased'} by ${formatCurrency(Math.abs(change.amount), currency)} over this range`;
  return `<svg class="collection-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(summary)}"><polyline points="${coordinates}" vector-effect="non-scaling-stroke"></polyline></svg>`;
}

// DCL-COLL-01: one strip -- value, item count, coverage % (+ sparkline).
// Gain, last-updated, the market/manual/unpriced breakdown, and the
// excluded-currency fine print are dropped; Home and Data Health own them.
function portfolioSummaryBar(state, summary, currency) {
  const pricing = state.holdings.reduce((counts, holding) => {
    counts[holdingPricingStatus(holding)] += 1;
    return counts;
  }, { market: 0, manual: 0, unpriced: 0 });
  const covered = pricing.market + pricing.manual;
  const coverage = state.holdings.length ? (covered / state.holdings.length) * 100 : 0;
  return `<section class="portfolio-summary-bar" aria-label="Collection summary"><div class="portfolio-summary-primary"><span>Estimated value</span><div class="collection-value-line"><strong>${covered ? escapeHTML(formatCurrency(summary.marketValue, currency)) : 'Value not available'}</strong>${covered ? collectionSparkline(state, currency) : ''}</div></div><dl><div><dt>Items</dt><dd>${state.holdings.length}</dd></div><div><dt>Pricing coverage</dt><dd>${coverage.toFixed(0)}%</dd></div></dl></section>`;
}

function options(values, selected, emptyLabel) {
  return `<option value="">${escapeHTML(emptyLabel)}</option>${[...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b)).map((value) => `<option value="${escapeAttribute(value)}" ${selected === value ? 'selected' : ''}>${escapeHTML(value)}</option>`).join('')}`;
}

function activeFilterChips(state) {
  const filters = state.portfolio.filters || {};
  const entries = [
    state.portfolio.query ? ['query', `Search: ${state.portfolio.query}`] : null,
    state.portfolio.category !== 'all' ? ['category', `Category: ${categoryLabel(state.portfolio.category, state.holdings)}`] : null,
    ...Object.entries(filters).filter(([key, value]) => key !== 'setNameExact' && value).map(([key, value]) => [key, `${({ setName: 'Set', ownership: 'Type', condition: 'Condition', gradeCompany: 'Grader', language: 'Language', tags: 'Tag', pricing: 'Pricing', performance: 'Performance' })[key] || key}: ${value}`])
  ].filter(Boolean);
  if (!entries.length) return '';
  return `<div class="active-filters" aria-label="Active collection filters">${entries.map(([key, label]) => `<button type="button" data-action="remove-portfolio-filter" data-filter="${escapeAttribute(key)}">${escapeHTML(label)} <span aria-hidden="true">×</span></button>`).join('')}<button class="clear" type="button" data-action="clear-portfolio-filters">Clear all</button></div>`;
}

function holdingsControls(state, view, groupMode, selectionMode) {
  const filters = state.portfolio.filters || {};
  const activeCount = (state.portfolio.category !== 'all' ? 1 : 0) + Object.values(filters).filter(Boolean).length;
  const categories = new Map(Object.entries(DEFAULT_CATEGORY_LABELS));
  categoryLabels(state.holdings).forEach((label, category) => categories.set(category, label));
  const categoryOptions = [['all', 'All categories'], ...[...categories.entries()].sort((left, right) => left[1].localeCompare(right[1]))];
  const sortOptions = [['value-desc', 'Highest value'], ['gain-desc', 'Largest gain'], ['gain-asc', 'Largest loss'], ['recent-desc', 'Recently added'], ['updated-desc', 'Recently changed'], ['name-asc', 'Name A–Z'], ['set-asc', 'Set order'], ['quantity-desc', 'Highest quantity'], ['missing-desc', 'Missing information']];
  // DCL-COLL-06: a filter select that can only ever show one value gives
  // the collector nothing to choose between, so it's hidden entirely.
  const distinctValues = (values) => [...new Set(values.filter(Boolean).map(String))];
  const setNames = distinctValues(state.holdings.map((holding) => holding.item?.setName));
  const conditions = distinctValues(state.holdings.map((holding) => holding.condition));
  const graders = distinctValues(state.holdings.map((holding) => holding.gradeCompany));
  const languages = distinctValues(state.holdings.map((holding) => holding.item?.language));
  const tagValues = distinctValues(state.holdings.flatMap((holding) => holding.tags || []));
  return `<section class="portfolio-controls collection-toolbar" aria-label="Collection tools"><div class="portfolio-command"><label class="sr-only" for="portfolio-query">Search collection</label><input id="portfolio-query" type="search" value="${escapeAttribute(state.portfolio.query)}" placeholder="Search collection" data-portfolio-query><label class="collection-sort"><span class="sr-only">Sort collection</span><select data-portfolio-sort aria-label="Sort collection">${sortOptions.map(([value, label]) => `<option value="${value}" ${state.portfolio.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><details class="collection-overflow collection-display-popover"><summary aria-label="Display options">${icon(view === 'gallery' ? 'grid' : 'list', { size: 20 })}</summary><div><div class="collection-mode-toggle" role="group" aria-label="Collection item grouping"><button type="button" data-collection-group-mode="grouped" aria-pressed="${groupMode === 'grouped'}">Grouped items</button><button type="button" data-collection-group-mode="purchases" aria-pressed="${groupMode === 'purchases'}">Purchases</button></div><div class="view-toggle" role="group" aria-label="Collection view"><button type="button" data-portfolio-view="gallery" aria-pressed="${view === 'gallery'}" aria-label="Grid view">${icon('grid', { size: 20 })}</button><button type="button" data-portfolio-view="list" aria-pressed="${view === 'list'}" aria-label="List view">${icon('list', { size: 20 })}</button></div></div></details><details class="collection-overflow"><summary aria-label="More collection actions">${icon('overflow', { size: 20 })}</summary><div><button class="button ghost small" type="button" data-action="export-csv">Export CSV</button><button class="button ghost small" type="button" data-action="${selectionMode ? 'clear-holding-selection' : 'start-holding-selection'}">${selectionMode ? 'Exit selection' : 'Select'}</button></div></details></div><details class="portfolio-filter-panel"><summary>Filters${activeCount ? ` · ${activeCount}` : ''}</summary><div class="portfolio-filter-grid"><label>Category<select data-portfolio-category>${categoryOptions.map(([value, label]) => `<option value="${escapeAttribute(value)}" ${state.portfolio.category === value ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('')}</select></label>${setNames.length > 1 ? `<label>Set<select data-portfolio-filter="setName">${options(state.holdings.map((holding) => holding.item?.setName), filters.setName, 'All sets')}</select></label>` : ''}<label>Type<select data-portfolio-filter="ownership"><option value="">All types</option>${[['raw', 'Raw'], ['graded', 'Graded'], ['sealed', 'Sealed']].map(([value, label]) => `<option value="${value}" ${filters.ownership === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${conditions.length > 1 ? `<label>Condition<select data-portfolio-filter="condition">${options(state.holdings.map((holding) => holding.condition), filters.condition, 'All conditions')}</select></label>` : ''}${graders.length > 1 ? `<label>Grading company<select data-portfolio-filter="gradeCompany">${options(state.holdings.map((holding) => holding.gradeCompany), filters.gradeCompany, 'All graders')}</select></label>` : ''}${languages.length > 1 ? `<label>Language<select data-portfolio-filter="language">${options(state.holdings.map((holding) => holding.item?.language), filters.language, 'All languages')}</select></label>` : ''}${tagValues.length > 1 ? `<label>Tag<select data-portfolio-filter="tags">${options(state.holdings.flatMap((holding) => holding.tags || []), filters.tags, 'All tags')}</select></label>` : ''}<label>Pricing<select data-portfolio-filter="pricing"><option value="">All pricing states</option>${[['market', 'Market priced'], ['manual', 'Manual value'], ['unpriced', 'Unpriced']].map(([value, label]) => `<option value="${value}" ${filters.pricing === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Performance<select data-portfolio-filter="performance"><option value="">Gain and loss</option><option value="gain" ${filters.performance === 'gain' ? 'selected' : ''}>Gain</option><option value="loss" ${filters.performance === 'loss' ? 'selected' : ''}>Loss</option></select></label></div></details>${activeFilterChips(state)}</section>`;
}

function bulkToolbar(selected, selectionMode) {
  if (!selectionMode) return '';
  return `<div class="bulk-toolbar" role="region" aria-label="Bulk purchase actions"><strong>${selected.length} selected</strong><div><button class="button secondary small" type="button" data-action="bulk-edit-holdings" ${selected.length === 1 ? '' : 'disabled'}>Edit</button><button class="button secondary small" type="button" data-action="bulk-move-holdings" ${selected.length ? '' : 'disabled'}>Move</button><button class="button secondary small" type="button" data-action="bulk-tag-holdings" ${selected.length ? '' : 'disabled'}>Add tags</button><button class="button secondary small" type="button" data-action="bulk-duplicate-holdings" ${selected.length ? '' : 'disabled'}>Duplicate</button><button class="button secondary small" type="button" data-action="bulk-export-holdings" ${selected.length ? '' : 'disabled'}>Export</button><button class="button danger small" type="button" data-action="bulk-delete-holdings" ${selected.length ? '' : 'disabled'}>Delete</button><button class="button ghost small" type="button" data-action="clear-holding-selection">Done</button></div></div>`;
}

function emptyCollectionState() {
  return emptyState('Start your collection', 'Scan a photo, search for an exact item, import a backup, or create something custom. Pricing can be added later.', '<div class="empty-collection-actions"><button class="button" type="button" data-go="add">Scan</button><button class="button secondary" type="button" data-go="search">Search</button><button class="button ghost" type="button" data-action="import-json">Import</button><button class="button ghost" type="button" data-action="custom-holding">Custom item</button><input class="sr-only" id="backup-file" type="file" accept="application/json,.json" aria-label="Choose CollectFolio backup, up to 128 MB"></div>');
}

function normalizedIdentityPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchingHoldingKey(holding) {
  const item = holding?.item || {};
  const external = holding.canonicalVariantId || item.canonicalVariantId
    || (item.provider && item.externalId ? `${item.provider}:${item.externalId}` : '')
    || item.id;
  const identity = external || [item.category, item.game, item.name, item.setName, item.number, item.variant, item.language, item.productFormat].map(normalizedIdentityPart).join('|');
  const ownership = holding.grade ? `graded:${normalizedIdentityPart(holding.gradeCompany)}:${normalizedIdentityPart(holding.grade)}` : normalizedIdentityPart(holding.ownershipType || item.productFormat || 'raw');
  return `${identity}|${ownership}`;
}

export function groupMatchingHoldings(holdings = [], currency = 'USD') {
  const groups = new Map();
  holdings.forEach((holding) => {
    const key = matchingHoldingKey(holding);
    if (!groups.has(key)) groups.set(key, { key, holdings: [], item: holding.item || {}, coverHolding: holding });
    groups.get(key).holdings.push(holding);
  });
  return [...groups.values()].map((group) => {
    const statuses = group.holdings.map(holdingPricingStatus);
    const priced = group.holdings.filter((holding) => holdingPricingStatus(holding) !== 'unpriced' && holdingMarketCurrency(holding) === currency);
    const gains = group.holdings.map((holding) => holdingGain(holding, currency)).filter((value) => value !== null);
    return {
      ...group,
      quantity: group.holdings.reduce((sum, holding) => sum + Math.max(0, Number(holding.quantity) || 0), 0),
      marketValue: priced.reduce((sum, holding) => sum + holdingMarketValue(holding, currency), 0),
      pricedPurchaseCount: priced.length,
      unpricedPurchaseCount: statuses.filter((status) => status === 'unpriced').length,
      excludedCurrencyCount: group.holdings.filter((holding) => holdingPricingStatus(holding) !== 'unpriced' && holdingMarketCurrency(holding) !== currency).length,
      gain: gains.reduce((sum, value) => sum + value, 0),
      gainEligibleCount: gains.length,
      pricingStatus: new Set(statuses).size === 1 ? statuses[0] : 'mixed'
    };
  });
}

const finiteOrNull = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

export function watchlistCardViewModel(entry = {}, publication = null) {
  const ref = entry.catalogRef || {};
  const selected = selectPublicationForWatchlist(publication, entry, entry.targetCurrency || ref.currency || 'USD');
  const intelligence = selected ? normalizeIntelligencePayload(selected) : null;
  const observed = intelligence?.observed || null;
  const catalogPrice = catalogPriceForValuation(ref);
  const currentPrice = observed?.price ?? catalogPrice;
  const targetPrice = finiteOrNull(entry.targetPrice);
  const currentCurrency = String(observed?.currency || ref.currency || 'USD').toUpperCase();
  const targetCurrency = String(entry.targetCurrency || ref.currency || 'USD').toUpperCase();
  const targetComparable = targetPrice !== null && currentCurrency === targetCurrency;
  const forecasts = intelligence?.supportTier >= 4 ? Object.values(intelligence.forecasts) : [];
  const forecast = forecasts.find((candidate) => candidate.horizon === 30)
    || forecasts.find((candidate) => candidate.horizon === 90) || null;
  const forecastUpside = forecast && currentPrice > 0 ? (forecast.q50 / currentPrice) - 1 : null;
  // A gross forecast is not a buy opportunity. Ranking stays withheld until a
  // point-in-time offer, taxes, both shipping legs, selling fees, and liquidity
  // evidence are attached to this user's watch candidate.
  const opportunityScore = null;
  const alertsEnabled = targetPrice !== null || (finiteOrNull(entry.alertPercentChange) ?? 0) > 0
    || Boolean(entry.alertTrendChange || entry.alertRangeChange || entry.alertForecastChange);
  return {
    entry, ref, intelligence, observed, currentPrice, currentCurrency, targetPrice, targetCurrency, targetComparable, forecast,
    forecastUpside, opportunityScore, alertsEnabled,
    targetDistance: currentPrice !== null && targetComparable ? Math.abs(currentPrice - targetPrice) : null,
    change7d: intelligence?.supportTier >= 2 ? intelligence.trend.return7d : null,
    change30d: intelligence?.supportTier >= 2 ? intelligence.trend.return30d : null
  };
}

export function filterAndSortWatchlist(entries = [], publications = {}, controls = {}) {
  const needle = String(controls.query || '').trim().toLowerCase();
  const category = controls.category || 'all';
  const sort = controls.sort === 'opportunity-desc' ? 'forecast-desc' : controls.sort || 'forecast-desc';
  const models = entries.map((entry) => watchlistCardViewModel(entry, publications[entry.canonicalVariantId] || publications[String(entry.canonicalVariantId || '').toLowerCase()] || null))
    .filter(({ entry, ref }) => (category === 'all' || ref.category === category)
      && (!needle || [ref.name, ref.setName, ref.number, ref.rarity, ref.finish, entry.notes].join(' ').toLowerCase().includes(needle)));
  const missingLast = (left, right, key, direction = -1) => {
    const a = left[key]; const b = right[key];
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * direction;
  };
  const compare = {
    'target-asc': (a, b) => missingLast(a, b, 'targetDistance', 1),
    'forecast-desc': (a, b) => missingLast(a, b, 'forecastUpside'),
    'decline-asc': (a, b) => missingLast(a, b, 'change30d', 1),
    'changed-desc': (a, b) => String(b.entry.updatedAt || '').localeCompare(String(a.entry.updatedAt || '')),
    'value-desc': (a, b) => missingLast(a, b, 'currentPrice'),
    'added-desc': (a, b) => String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || ''))
  }[sort] || ((a, b) => missingLast(a, b, 'forecastUpside'));
  return models.sort((left, right) => compare(left, right) || String(left.ref.name || '').localeCompare(String(right.ref.name || '')));
}

function watchlistControls(state) {
  const controls = state.watchlist || {};
  const selectedSort = controls.sort === 'opportunity-desc' ? 'forecast-desc' : controls.sort || 'forecast-desc';
  const categories = [...new Set(state.watchlistItems.map((entry) => entry.catalogRef?.category).filter(Boolean))].sort();
  return `<section class="watchlist-controls" aria-label="Watchlist controls"><label class="sr-only" for="watchlist-query">Filter watchlist</label><input id="watchlist-query" type="search" value="${escapeAttribute(controls.query || '')}" placeholder="Filter watched cards" data-watchlist-query><label>Category<select data-watchlist-category><option value="all">All categories</option>${categories.map((category) => `<option value="${escapeAttribute(category)}" ${controls.category === category ? 'selected' : ''}>${escapeHTML(category[0].toUpperCase() + category.slice(1))}</option>`).join('')}</select></label><label>Sort<select data-watchlist-sort>${[
    ['forecast-desc', 'Largest forecasted upside'], ['target-asc', 'Closest to target'],
    ['decline-asc', 'Largest decline'], ['changed-desc', 'Recently changed'], ['value-desc', 'Highest value'], ['added-desc', 'Recently added']
  ].map(([value, label]) => `<option value="${value}" ${selectedSort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></section>`;
}

function watchlistSection(state) {
  const currency = state.settings.currency || 'USD';
  if (!state.watchlistItems.length) return `<section class="empty-state watchlist-empty"><span class="empty-symbol">${icon('star', { size: 24 })}</span><h2>Track cards before you buy</h2><p>Watch prices, set targets, and follow future outlooks.</p><button class="button" type="button" data-go="search">Find a card</button></section>`;
  const controls = state.watchlist || { query: '', category: 'all', sort: 'forecast-desc' };
  const shown = filterAndSortWatchlist(state.watchlistItems, state.intelligence?.byVariant || {}, controls);
  const activeAlerts = (state.alerts || []).filter((alert) => !alert.readAt && !alert.mutedAt && state.watchlistItems.some((item) => item.watchKey === alert.watchKey));
  const configured = state.watchlistItems.filter((entry) => watchlistCardViewModel(entry).alertsEnabled).length;
  const filtersUseful = state.watchlistItems.length > 1 || controls.query || (controls.category && controls.category !== 'all');
  // DCL-COLL-07: "N watched cards" + "M alerts" -- drop "exact variants"
  // and the "Approved intelligence alerts:" label.
  return `<section class="watchlist-overview"><div><p class="eyebrow">Purchase watch</p><strong>${state.watchlistItems.length} watched card${state.watchlistItems.length === 1 ? '' : 's'}</strong><span>${configured} with targets or alerts · ${activeAlerts.length} alert${activeAlerts.length === 1 ? '' : 's'}</span></div><button class="button secondary small" type="button" data-go="search">Find another card</button></section>
    ${filtersUseful ? watchlistControls(state) : ''}
    ${compareBar(state.compare || [])}
    <div class="section-heading"><div><p class="eyebrow">${shown.length} shown</p><h2>Watched cards</h2></div></div>
    ${shown.length ? `<div class="watchlist-grid">${shown.map((model) => watchlistCard(model, currency, activeAlerts.filter((alert) => alert.watchKey === model.entry.watchKey), state.compare || [])).join('')}</div>` : `<section class="empty-state"><h2>No watched cards match</h2><p>Clear the watchlist filters to see every exact variant.</p><button class="button ghost" type="button" data-action="clear-watchlist-filters">Clear filters</button></section>`}`;
}

// DCL-COLL-08: the gated state is one sentence -- no badge, no bullets, no
// gate card.
function forecastSection(state) {
  const publicEnabled = Boolean(state.featureFlags?.publicPriceIntelligence);
  if (!publicEnabled) return '<p class="muted">Forecasts aren\'t available yet. Watchlists work now.</p>';

  const publications = Object.values(state.intelligence?.byVariant || {}).flat()
    .map(normalizeIntelligencePayload)
    .filter((publication) => Object.keys(publication.forecasts).length);
  const status = `${state.intelligence?.loading ? '<p class="fine-print" role="status">Refreshing approved publications…</p>' : ''}${state.intelligence?.error ? `<p class="fine-print negative" role="status">${escapeHTML(state.intelligence.error)}</p>` : ''}`;
  // LEX sweep: drop the governance badge and the "rights-cleared ...
  // baseline, leakage, and calibration gates" engineering sentence
  // (RULE-3/Appendix C) in favor of one plain absence line.
  if (!publications.length) return `${status}<section class="card intelligence-gate" role="status"><h2>No forecasts published yet</h2><p>New outlooks appear here once one is approved.</p></section>`;
  return `${status}<div class="section-heading"><div><p class="eyebrow">Forecasts</p><h2>Product outlooks</h2></div></div><div class="forecast-list">${publications.map((publication) => forecastCard(state, publication)).join('')}</div>`;
}

function groupedHoldingCard(group, currency, state, view) {
  const holding = group.coverHolding;
  const identity = [group.item?.game, group.item?.setName, group.item?.number ? `#${group.item.number}` : '', group.item?.variant, group.item?.language].filter(Boolean).join(' · ');
  const sourceLabel = group.pricingStatus === 'market' ? 'Market' : group.pricingStatus === 'manual' ? 'Manual' : group.pricingStatus === 'unpriced' ? 'Unpriced' : 'Mixed sources';
  // DCL-COLL-05: one attention status only, shown only when the group
  // actually needs one; provenance/source clauses belong on the detail
  // page, not this card.
  const valueNote = group.unpricedPurchaseCount
    ? `${group.unpricedPurchaseCount} of ${group.holdings.length} unpriced`
    : group.excludedCurrencyCount
      ? `${group.excludedCurrencyCount} of ${group.holdings.length} other-currency`
      : '';
  const gain = group.gainEligibleCount
    ? `<dd class="${group.gain >= 0 ? 'positive' : 'negative'}">${escapeHTML(formatCurrency(group.gain, currency))}</dd><dd class="metric-note"><small>${group.gainEligibleCount} comparable purchase${group.gainEligibleCount === 1 ? '' : 's'}</small></dd>`
    : '<dd>—</dd><dd class="metric-note"><small>Add cost and current value</small></dd>';
  const attention = group.unpricedPurchaseCount ? `<span class="holding-attention">${group.unpricedPurchaseCount} need${group.unpricedPurchaseCount === 1 ? 's' : ''} a value</span>` : '';
  return `<article class="portfolio-holding-card grouped ${escapeAttribute(view)}" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}" tabindex="0" aria-label="Inspect ${escapeAttribute(group.item?.name || 'item')}"><div class="holding-art">${externalImage({ ...group.item, userImage: holding.userImage }, 'holding-image')}<span class="value-source ${escapeAttribute(group.pricingStatus)}">${escapeHTML(sourceLabel)}</span></div><div class="holding-identity"><h3>${escapeHTML(group.item?.name || 'Unnamed item')}</h3><p>${escapeHTML(identity || 'Custom collection item')}</p><div class="holding-pills"><span>Qty ${escapeHTML(String(group.quantity))}</span><span>${group.holdings.length} purchase${group.holdings.length === 1 ? '' : 's'}</span>${group.item?.rarity ? `<span>${escapeHTML(group.item.rarity)}</span>` : ''}${attention}</div></div><dl class="holding-values"><div><dt>Current value</dt><dd>${group.pricedPurchaseCount ? escapeHTML(formatCurrency(group.marketValue, currency)) : 'Unpriced'}</dd>${valueNote ? `<dd class="metric-note"><small>${escapeHTML(valueNote)}</small></dd>` : ''}</div><div><dt>Estimated gain or loss</dt>${gain}</div></dl><div class="holding-actions grouped-actions"><button class="button secondary small" type="button" data-action="show-individual-purchases">View purchases</button><button class="button ghost small" type="button" data-action="toggle-watch" data-holding-id="${escapeAttribute(holding.id)}">${findWatchedItem(state.watchlistItems, holding.item) ? 'Watching' : 'Watch'}</button></div></article>`;
}

function holdingCard(holding, currency, state, view, selected, selectionMode) {
  const value = holdingMarketValue(holding);
  const cost = holdingCostBasis(holding);
  const gain = holdingGain(holding);
  const valueCurrency = holdingMarketCurrency(holding);
  const costCurrency = holdingCostCurrency(holding);
  const hasRecordedCost = (holding.purchasePrice !== '' && holding.purchasePrice !== null && holding.purchasePrice !== undefined && Number.isFinite(Number(holding.purchasePrice)))
    || (holding.fees !== '' && holding.fees !== null && holding.fees !== undefined && Number.isFinite(Number(holding.fees)) && Number(holding.fees) > 0);
  const pricingStatus = holdingPricingStatus(holding);
  const providerPrice = holding.item?.price;
  const restrictedDisclosure = catalogPriceDisclosure(holding.item);
  const source = holding.manualMarketPrice !== '' && holding.manualMarketPrice != null
    ? providerPrice == null ? 'Manual value · market price unavailable' : restrictedDisclosure ? `Manual value · ${restrictedDisclosure}` : `Manual override · market reference retained at ${formatCurrency(providerPrice, holding.item?.currency || 'USD')}`
    : restrictedDisclosure || holding.item?.priceSource || 'No verified market price';
  const watching = Boolean(findWatchedItem(state.watchlistItems, holding.item, {
    canonicalVariantId: holding.canonicalVariantId,
    conditionClass: holding.grade ? 'graded' : 'raw',
    marketCondition: holding.grade ? `${holding.gradeCompany || 'unknown'}-${holding.grade || 'ungraded'}` : holding.marketCondition
  }));
  const identity = [holding.item?.game, holding.item?.setName, holding.item?.number ? `#${holding.item.number}` : '', holding.item?.variant, holding.item?.language].filter(Boolean).join(' · ');
  const condition = holding.grade ? `${holding.gradeCompany || 'Graded'} ${holding.grade}` : holding.condition || 'Condition not set';
  const selection = selectionMode ? `<button class="holding-select" type="button" data-action="toggle-holding-selection" data-id="${escapeAttribute(holding.id)}" aria-pressed="${selected}" aria-label="${selected ? 'Deselect' : 'Select'} ${escapeAttribute(holding.item?.name || 'purchase')}"><span aria-hidden="true">${selected ? '✓' : ''}</span></button>` : '';
  return `<article class="portfolio-holding-card ${escapeAttribute(view)}" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}" tabindex="0" aria-label="Inspect ${escapeAttribute(holding.item?.name || 'purchase')}">${selection}<div class="holding-art">${externalImage({ ...holding.item, userImage: holding.userImage }, 'holding-image')}<span class="value-source ${escapeAttribute(pricingStatus)}">${escapeHTML(pricingStatus === 'market' ? 'Market' : pricingStatus === 'manual' ? 'Manual' : 'Unpriced')}</span></div><div class="holding-identity"><h3>${escapeHTML(holding.item?.name || 'Unnamed item')}</h3><p>${escapeHTML(identity || 'Custom collection item')}</p><div class="holding-pills"><span>${escapeHTML(condition)}</span><span>Qty ${escapeHTML(String(holding.quantity || 0))}</span>${holding.item?.rarity ? `<span>${escapeHTML(holding.item.rarity)}</span>` : ''}${pricingStatus === 'unpriced' ? '<span class="holding-attention">Needs a value</span>' : ''}${(holding.tags || []).slice(0, 2).map((tag) => `<span>#${escapeHTML(tag)}</span>`).join('')}</div></div><dl class="holding-values"><div><dt>Current value</dt><dd>${pricingStatus === 'unpriced' ? 'Unpriced' : escapeHTML(formatCurrency(value, valueCurrency))}</dd><dd class="metric-note"><small>${escapeHTML(source)}${valueCurrency !== currency ? ` · Excluded from ${escapeHTML(currency)} total` : ''}</small></dd></div><div><dt>Cost basis</dt><dd>${hasRecordedCost ? escapeHTML(formatCurrency(cost, costCurrency)) : 'Not recorded'}</dd><dd class="metric-note"><small>${hasRecordedCost ? `Recorded purchase${costCurrency !== currency ? ` · Excluded from ${escapeHTML(currency)} total` : ''}` : 'Add purchase details to calculate'}</small></dd></div><div><dt>Estimated gain or loss</dt><dd class="${gain === null ? '' : gain >= 0 ? 'positive' : 'negative'}">${gain === null ? '—' : escapeHTML(formatCurrency(gain, valueCurrency))}</dd><dd class="metric-note"><small>${gain === null ? 'Needs both cost and current value' : escapeHTML(formatPercent(returnPercent(value, cost)))}</small></dd></div></dl><div class="holding-actions"><button class="button ghost small" type="button" data-action="toggle-watch" data-holding-id="${escapeAttribute(holding.id)}">${watching ? 'Watching' : 'Watch'}</button><button class="button ghost small" type="button" data-action="edit-holding" data-id="${escapeAttribute(holding.id)}">Edit</button></div></article>`;
}

function compareBar(selection) {
  if (!selection.length) return '';
  return `<div class="card compare-bar" role="status"><span>${selection.length} of 4 selected for comparison</span><div class="button-row"><button class="button small" type="button" data-action="open-compare" ${selection.length < 2 ? 'disabled' : ''}>Compare</button><button class="button ghost small" type="button" data-action="clear-compare">Clear</button></div></div>`;
}

// DCL-COLL-02: art + alert chip, name/meta, current price, 30-day move,
// target distance, two visible actions (Details, Add to collection) plus
// an overflow holding Target & alerts, Compare, Remove. The forecast
// range/confidence block, the support-badge sentence, the 7-day and
// last-update stats, the liquidity small, and the opportunity rankReason
// paragraph are gone; alert signals are capped at one.
function watchlistCard(model, currency, alerts = [], compareSelection = []) {
  const { entry, ref, intelligence, observed, currentPrice, currentCurrency, targetPrice, targetCurrency, targetComparable, alertsEnabled, change30d } = model;
  const displayCurrency = currentCurrency || observed?.currency || ref.currency || currency;
  const change = (value) => value === null ? '—' : `${value >= 0 ? '+' : ''}${formatPercent(value * 100)}`;
  const distance = targetPrice === null ? 'No target set' : currentPrice === null ? 'Waiting for a current price' : !targetComparable
    ? `Target is ${targetCurrency}; current price is ${displayCurrency}` : currentPrice <= targetPrice
    ? `${formatCurrency(targetPrice - currentPrice, displayCurrency)} below target`
    : `${formatCurrency(currentPrice - targetPrice, displayCurrency)} above target`;
  const alertText = alerts.length ? `${alerts.length} new alert${alerts.length === 1 ? '' : 's'}` : alertsEnabled ? 'Alerts on' : 'Alerts off';
  const signals = alerts.slice(0, 1).map((alert) => `<p class="watch-signal positive" role="status">● ${escapeHTML(alert.message)}</p>`).join('');
  return `<article class="watch-card"><div class="watch-card-art">${externalImage(ref, 'holding-image')}<span class="watch-alert-state ${alerts.length ? 'triggered' : alertsEnabled ? 'active' : ''}">${escapeHTML(alertText)}</span></div><div class="watch-card-main"><div class="watch-card-title"><div><h3>${escapeHTML(ref.name || 'Unnamed watched card')}</h3><p>${escapeHTML([ref.setName, ref.number, ref.rarity, ref.finish].filter(Boolean).join(' · '))}</p></div></div><div class="watch-values"><div class="actual"><span>Current market</span><strong>${currentPrice === null ? 'Price unavailable' : escapeHTML(formatCurrency(currentPrice, displayCurrency))}</strong><small>${escapeHTML(observed?.source || catalogPriceDisclosure(ref) || ref.priceSource || 'No approved observed-price source')}</small></div></div><dl class="watch-stats"><div><dt>30-day move</dt><dd class="${change30d === null ? '' : change30d >= 0 ? 'positive' : 'negative'}">${escapeHTML(change(change30d))}</dd></div><div><dt>Target</dt><dd>${targetPrice === null ? 'Not set' : escapeHTML(formatCurrency(targetPrice, targetCurrency))}<small>${escapeHTML(distance)}</small></dd></div></dl>${intelligence ? intelligenceSummary(intelligence, displayCurrency, true) : `<span class="support-badge unsupported">${escapeHTML(SUPPORT_BADGES[0])}</span>`}${signals}<div class="item-actions"><button class="button ghost small" type="button" data-action="open-detail" data-watch-key="${escapeAttribute(entry.watchKey)}">Details</button><button class="button secondary small" type="button" data-action="add-watched" data-watch-key="${escapeAttribute(entry.watchKey)}">Add to collection</button><details class="collection-overflow"><summary aria-label="More actions for ${escapeAttribute(ref.name || 'watched card')}">${icon('overflow', { size: 20 })}</summary><div><button class="button ghost small" type="button" data-action="edit-watch" data-watch-key="${escapeAttribute(entry.watchKey)}">Target &amp; alerts</button><button class="button ghost small" type="button" data-action="toggle-compare" data-watch-key="${escapeAttribute(entry.watchKey)}">${compareSelection.includes(entry.watchKey) ? `${icon('compareCheck', { size: 15 })} Comparing` : `${icon('compareBox', { size: 15 })} Compare`}</button><button class="button ghost small" type="button" data-action="remove-watch" data-watch-key="${escapeAttribute(entry.watchKey)}">Remove</button></div></details></div></div></article>`;
}

function intelligenceSummary(intelligence, currency, compact = false) {
  const tone = intelligence.supportTier >= 4 ? 'supported' : intelligence.supportTier >= 2 ? 'partial' : 'unsupported';
  const trend = intelligence.supportTier >= 2 && intelligence.trend.return30d !== null
    ? `<span class="intelligence-stat ${intelligence.trend.return30d >= 0 ? 'positive' : 'negative'}">${escapeHTML(formatPercent(intelligence.trend.return30d * 100))} / 30D · ${escapeHTML(trendLabel(intelligence.trend.status))}</span>`
    : '';
  const fair = !compact && intelligence.supportTier >= 3 && intelligence.fairValue
    ? `<span class="intelligence-stat">Fair range ${escapeHTML(formatCurrency(intelligence.fairValue.q10, currency))}–${escapeHTML(formatCurrency(intelligence.fairValue.q90, currency))}</span>`
    : '';
  return `<div class="intelligence-summary"><span class="support-badge ${tone}">${escapeHTML(SUPPORT_BADGES[intelligence.supportTier] ?? SUPPORT_BADGES[0])}</span>${trend}${fair}</div>`;
}

function forecastCard(state, publication) {
  const holding = state.holdings.find((entry) => entry.canonicalVariantId === publication.variantId
    && selectPublicationForHolding(publication, entry, holdingMarketCurrency(entry)));
  const watched = state.watchlistItems.find((entry) => entry.canonicalVariantId === publication.variantId
    && selectPublicationForWatchlist(publication, entry, entry.targetCurrency || entry.catalogRef?.currency || 'USD'));
  const item = holding?.item || watched?.catalogRef || {};
  const currency = publication.observed?.currency || item.currency || state.settings.currency || 'USD';
  const forecasts = Object.values(publication.forecasts).sort((left, right) => left.horizon - right.horizon);
  const source = publication.sourceAttributions.map((entry) => entry.name).filter(Boolean).join(', ');
  const trend30 = publication.supportTier >= 2 ? publication.trend.return30d : null;
  const trend = trend30 === null ? '' : `<span class="outlook-trend ${trend30 >= 0 ? 'positive' : 'negative'}">30D ${escapeHTML(formatPercent(trend30 * 100))} · ${escapeHTML(trendLabel(publication.trend.status))}</span>`;
  const detail = holding
    ? `<button class="button ghost small" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}">Open product detail</button>`
    : watched ? `<button class="button ghost small" type="button" data-action="open-detail" data-watch-key="${escapeAttribute(watched.watchKey)}">Open product detail</button>` : '';
  const projection = forecastProjectionChart(publication.observed?.price, forecasts, currency, {
    history: publication.history,
    asOfDate: publication.publishedAt || publication.observed?.observedAt
  })
    || '<div class="empty-chart">An approved observed price is required before ranges can be anchored on a graph.</div>';
  return `<article class="card forecast-card product-outlook-card"><div class="forecast-product-head">${externalImage(item, 'forecast-product-image')}<div><p class="eyebrow">Product outlook</p><h2>${escapeHTML(item.name || 'Verified card')}</h2><p class="item-meta">${escapeHTML([item.setName, item.number, item.finish || item.variant].filter(Boolean).join(' · '))}</p><div class="intelligence-summary"><span class="support-badge supported">${escapeHTML(SUPPORT_BADGES[publication.supportTier] ?? SUPPORT_BADGES[0])}</span>${trend}</div></div>${detail}</div>${projection}<div class="forecast-horizon-list">${forecasts.map((forecast) => `<section class="forecast-horizon"><div class="form-section-heading"><div><p class="eyebrow">${forecast.horizon}-day outlook</p><h3>${escapeHTML(formatCurrency(forecast.q50, currency))} median</h3></div>${forecast.confidence === null ? '' : `<span class="pill">Confidence ${Math.round(forecast.confidence)}/100</span>`}</div><div class="forecast-grid"><div><span>50% range</span><strong>${escapeHTML(formatCurrency(forecast.q25, currency))}–${escapeHTML(formatCurrency(forecast.q75, currency))}</strong></div><div><span>80% range</span><strong>${escapeHTML(formatCurrency(forecast.q10, currency))}–${escapeHTML(formatCurrency(forecast.q90, currency))}</strong></div><div><span>Probability of gain</span><strong>${forecast.probabilityUp === null ? '—' : `${Math.round(forecast.probabilityUp * 100)}%`}</strong></div></div><p class="fine-print">Origin ${escapeHTML(forecast.origin || '—')} · Matures ${escapeHTML(forecast.maturesAt || '—')} · Model ${escapeHTML(forecast.modelVersion || '—')}</p></section>`).join('')}</div>${source ? `<p class="price-source">Sources: ${escapeHTML(source)}</p>` : ''}</article>`;
}
