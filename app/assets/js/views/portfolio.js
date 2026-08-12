import { emptyState, externalImage, pageHeader } from '../core/components.js';
import { watchKeyForItem } from '../core/catalog-identity.js';
import { normalizeIntelligencePayload, trendLabel } from '../core/intelligence-contract.js';
import { filterAndSortHoldings, holdingCostBasis, holdingCostCurrency, holdingGain, holdingMarketCurrency, holdingMarketValue, holdingPricingStatus, portfolioSummary, returnPercent } from '../core/calculations.js';
import { catalogPriceDisclosure, catalogPriceForValuation } from '../core/pricing-policy.js';
import { forecastProjectionChart } from '../core/ui.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';

export const PORTFOLIO_VIEWS = Object.freeze(['gallery', 'list']);
const SUPPORT_LABELS = Object.freeze([
  'Card identified; pricing pending', 'Current market price', 'Market history available',
  'Modeled value available', 'Forecast available', 'Forecast fully evaluated'
]);

export function renderPortfolio(state) {
  const watchlistsEnabled = state.featureFlags?.watchlists !== false;
  const section = watchlistsEnabled ? state.portfolio.section || 'holdings' : 'holdings';
  const labels = {
    holdings: ['Collection', 'Portfolio', `${state.holdings.length} unique holdings across your local portfolio.`],
    watchlist: ['Collection', 'Watchlist', `${state.watchlistItems.length} exact variant${state.watchlistItems.length === 1 ? '' : 's'} saved on this device.`],
    forecasts: ['Evidence before prediction', 'Insights', 'Model output stays gated until its data rights and validation requirements pass.']
  };
  const [eyebrow, title, subtitle] = labels[section] || labels.holdings;
  const refresh = section === 'holdings'
    ? '<button class="icon-button" type="button" data-action="refresh-prices" aria-label="Refresh prices">↻</button>'
    : '';
  return `${pageHeader(eyebrow, title, subtitle, refresh)}
    ${watchlistsEnabled && section !== 'forecasts' ? segmentedControl(section) : ''}
    ${section === 'watchlist' ? watchlistSection(state) : section === 'forecasts' ? forecastSection(state) : holdingsSection(state)}`;
}

function segmentedControl(section) {
  return `<div class="segmented-control" role="tablist" aria-label="Portfolio sections">
    ${[['holdings', 'Holdings'], ['watchlist', 'Watchlist']].map(([value, label]) => `<button type="button" role="tab" class="segment-button ${section === value ? 'active' : ''}" aria-selected="${section === value}" data-portfolio-section="${value}">${label}</button>`).join('')}
  </div>`;
}

function holdingsSection(state) {
  const currency = state.settings.currency || 'USD';
  const summary = portfolioSummary(state.holdings, { currency });
  const shown = filterAndSortHoldings(state.holdings, { ...state.portfolio, currency });
  const view = PORTFOLIO_VIEWS.includes(state.portfolio.view || state.settings?.portfolioView) ? (state.portfolio.view || state.settings.portfolioView) : 'gallery';
  const selected = (state.portfolio.selected || []).filter((id) => state.holdings.some((holding) => holding.id === id));
  const limit = Math.max(1, Number(state.portfolio.limit) || 100);
  const visible = shown.slice(0, limit);
  return `${portfolioSummaryBar(state, summary, currency)}
    ${holdingsControls(state, view)}
    ${bulkToolbar(selected)}
    <div class="portfolio-result-heading"><div><strong>${shown.length} holding${shown.length === 1 ? '' : 's'}</strong><span>${selected.length ? `${selected.length} selected` : 'Exact lots remain separate'}</span></div><button class="button ghost small" type="button" data-action="export-csv">Export CSV</button></div>
    ${visible.length ? `<div class="portfolio-holdings ${escapeAttribute(view)}">${visible.map((holding) => holdingCard(holding, currency, state, view, selected.includes(holding.id))).join('')}</div>${shown.length > visible.length ? `<button class="button secondary portfolio-load-more" type="button" data-action="load-more-holdings">Show ${Math.min(100, shown.length - visible.length)} more</button>` : ''}` : state.holdings.length ? emptyState('No holdings match these filters', 'Remove a filter or clear the search to see the rest of your portfolio.', '<button class="button ghost" type="button" data-action="clear-portfolio-filters">Clear all filters</button>') : emptyState('Add your first collectible', 'Search, scan, import, or create a custom item. Pricing is optional.', '<button class="button" type="button" data-go="add">Add collectible</button>')}`;
}

function portfolioSummaryBar(state, summary, currency) {
  const pricing = state.holdings.reduce((counts, holding) => {
    counts[holdingPricingStatus(holding)] += 1;
    return counts;
  }, { market: 0, manual: 0, unpriced: 0 });
  const covered = pricing.market + pricing.manual;
  const coverage = state.holdings.length ? (covered / state.holdings.length) * 100 : 0;
  const latestValue = state.holdings.map((holding) => holding.updatedAt || holding.createdAt).filter(Boolean).sort().at(-1);
  const latest = latestValue && !Number.isNaN(new Date(latestValue).valueOf())
    ? new Date(latestValue).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : 'No holdings yet';
  const excluded = summary.excludedMarketItems || summary.excludedCostItems
    ? `<p class="fine-print" role="status">${summary.excludedMarketItems} market value${summary.excludedMarketItems === 1 ? '' : 's'} and ${summary.excludedCostItems} cost basis entr${summary.excludedCostItems === 1 ? 'y' : 'ies'} in ${escapeHTML(summary.excludedCurrencies.join(', '))} are excluded from ${escapeHTML(currency)} totals; no exchange rate was guessed.</p>`
    : '';
  return `<section class="portfolio-summary-bar" aria-label="Portfolio summary"><div class="portfolio-summary-primary"><span>Local portfolio · ${escapeHTML(currency)} only</span><strong>${escapeHTML(formatCurrency(summary.marketValue, currency))}</strong><small>${summary.uniqueItems} unique · ${summary.totalQuantity} total</small></div><dl><div><dt>Cost basis</dt><dd>${escapeHTML(formatCurrency(summary.costBasis, currency))}</dd></div><div><dt>Comparable gain or loss</dt><dd class="${summary.gain >= 0 ? 'positive' : 'negative'}"><span aria-hidden="true">${summary.gain >= 0 ? '↗' : '↘'}</span> ${escapeHTML(formatCurrency(summary.gain, currency))}</dd><small>${escapeHTML(formatPercent(summary.returnPercent))}${summary.excludedGainItems ? ` · ${summary.excludedGainItems} mixed-currency excluded` : ''}</small></div><div><dt>Pricing coverage</dt><dd>${coverage.toFixed(0)}%</dd><small>${pricing.market} market · ${pricing.manual} manual · ${pricing.unpriced} unpriced</small></div><div><dt>Last updated</dt><dd>${escapeHTML(latest)}</dd><small>Saved on this device</small></div></dl>${excluded}</section>`;
}

function options(values, selected, emptyLabel) {
  return `<option value="">${escapeHTML(emptyLabel)}</option>${[...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b)).map((value) => `<option value="${escapeAttribute(value)}" ${selected === value ? 'selected' : ''}>${escapeHTML(value)}</option>`).join('')}`;
}

function activeFilterChips(state) {
  const filters = state.portfolio.filters || {};
  const entries = [
    state.portfolio.query ? ['query', `Search: ${state.portfolio.query}`] : null,
    state.portfolio.category !== 'all' ? ['category', `Category: ${state.portfolio.category}`] : null,
    ...Object.entries(filters).filter(([, value]) => value).map(([key, value]) => [key, `${({ setName: 'Set', ownership: 'Type', condition: 'Condition', gradeCompany: 'Grader', language: 'Language', tags: 'Tag', pricing: 'Pricing', performance: 'Performance' })[key] || key}: ${value}`])
  ].filter(Boolean);
  if (!entries.length) return '';
  return `<div class="active-filters" aria-label="Active portfolio filters">${entries.map(([key, label]) => `<button type="button" data-action="remove-portfolio-filter" data-filter="${escapeAttribute(key)}">${escapeHTML(label)} <span aria-hidden="true">×</span></button>`).join('')}<button class="clear" type="button" data-action="clear-portfolio-filters">Clear all</button></div>`;
}

function holdingsControls(state, view) {
  const filters = state.portfolio.filters || {};
  const hasFilters = state.portfolio.query || state.portfolio.category !== 'all' || Object.values(filters).some(Boolean);
  return `<section class="portfolio-controls" aria-label="Holdings controls"><div class="portfolio-command"><label class="sr-only" for="portfolio-query">Search holdings</label><input id="portfolio-query" type="search" value="${escapeAttribute(state.portfolio.query)}" placeholder="Search holdings" data-portfolio-query><div class="view-toggle" role="group" aria-label="Holding view"><button type="button" data-portfolio-view="gallery" aria-pressed="${view === 'gallery'}" aria-label="Gallery view">▦</button><button type="button" data-portfolio-view="list" aria-pressed="${view === 'list'}" aria-label="List view">☷</button></div></div><details class="portfolio-filter-panel" ${hasFilters ? 'open' : ''}><summary><span>Filters &amp; sort</span><span>${hasFilters ? 'Active' : 'All holdings'}</span></summary><div class="portfolio-filter-grid"><label>Category<select data-portfolio-category>${['all', 'pokemon', 'magic', 'yugioh', 'sports', 'comics', 'slab', 'other'].map((value) => `<option value="${value}" ${state.portfolio.category === value ? 'selected' : ''}>${escapeHTML(value === 'all' ? 'All categories' : value[0].toUpperCase() + value.slice(1))}</option>`).join('')}</select></label><label>Set<select data-portfolio-filter="setName">${options(state.holdings.map((holding) => holding.item?.setName), filters.setName, 'All sets')}</select></label><label>Type<select data-portfolio-filter="ownership"><option value="">All types</option>${[['raw', 'Raw'], ['graded', 'Graded'], ['sealed', 'Sealed']].map(([value, label]) => `<option value="${value}" ${filters.ownership === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Condition<select data-portfolio-filter="condition">${options(state.holdings.map((holding) => holding.condition), filters.condition, 'All conditions')}</select></label><label>Grading company<select data-portfolio-filter="gradeCompany">${options(state.holdings.map((holding) => holding.gradeCompany), filters.gradeCompany, 'All graders')}</select></label><label>Language<select data-portfolio-filter="language">${options(state.holdings.map((holding) => holding.item?.language), filters.language, 'All languages')}</select></label><label>Tag<select data-portfolio-filter="tags">${options(state.holdings.flatMap((holding) => holding.tags || []), filters.tags, 'All tags')}</select></label><label>Pricing<select data-portfolio-filter="pricing"><option value="">All pricing states</option>${[['market', 'Market priced'], ['manual', 'Manual value'], ['unpriced', 'Unpriced']].map(([value, label]) => `<option value="${value}" ${filters.pricing === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Performance<select data-portfolio-filter="performance"><option value="">Gain and loss</option><option value="gain" ${filters.performance === 'gain' ? 'selected' : ''}>Gain</option><option value="loss" ${filters.performance === 'loss' ? 'selected' : ''}>Loss</option></select></label><label>Sort<select data-portfolio-sort>${[['value-desc', 'Highest value'], ['gain-desc', 'Largest gain'], ['gain-asc', 'Largest loss'], ['recent-desc', 'Recently added'], ['updated-desc', 'Recently changed'], ['name-asc', 'Name A–Z'], ['set-asc', 'Set order'], ['quantity-desc', 'Highest quantity'], ['missing-desc', 'Missing information']].map(([value, label]) => `<option value="${value}" ${state.portfolio.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div></details>${activeFilterChips(state)}</section>`;
}

function bulkToolbar(selected) {
  if (!selected.length) return '';
  return `<div class="bulk-toolbar" role="region" aria-label="Bulk holding actions"><strong>${selected.length} selected</strong><div><button class="button secondary small" type="button" data-action="bulk-edit-holdings" ${selected.length === 1 ? '' : 'disabled'}>Edit</button><button class="button secondary small" type="button" data-action="bulk-move-holdings">Move</button><button class="button secondary small" type="button" data-action="bulk-tag-holdings">Add tags</button><button class="button secondary small" type="button" data-action="bulk-duplicate-holdings">Duplicate</button><button class="button secondary small" type="button" data-action="bulk-export-holdings">Export</button><button class="button danger small" type="button" data-action="bulk-delete-holdings">Delete</button><button class="button ghost small" type="button" data-action="clear-holding-selection">Clear</button></div></div>`;
}

const finiteOrNull = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

export function watchlistCardViewModel(entry = {}, publication = null) {
  const ref = entry.catalogRef || {};
  const intelligence = publication ? normalizeIntelligencePayload(publication) : null;
  const observed = intelligence?.observed || null;
  const catalogPrice = catalogPriceForValuation(ref);
  const currentPrice = observed?.price ?? catalogPrice;
  const targetPrice = finiteOrNull(entry.targetPrice);
  const currentCurrency = String(observed?.currency || ref.currency || 'USD').toUpperCase();
  const targetCurrency = String(entry.targetCurrency || ref.currency || 'USD').toUpperCase();
  const targetComparable = targetPrice !== null && currentCurrency === targetCurrency;
  const forecasts = intelligence?.supportTier >= 4 ? Object.values(intelligence.forecasts) : [];
  const forecast = forecasts.find((candidate) => candidate.horizon === 30)
    || forecasts.sort((left, right) => left.horizon - right.horizon)[0] || null;
  const forecastUpside = forecast && currentPrice > 0 ? (forecast.q50 / currentPrice) - 1 : null;
  const hasOpportunityEvidence = Boolean(observed && forecast && forecast.probabilityUp !== null && forecast.confidence !== null && currentPrice > 0);
  const opportunityScore = hasOpportunityEvidence
    ? forecastUpside * forecast.probabilityUp * (forecast.confidence / 100)
    : null;
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
  const sort = controls.sort || 'opportunity-desc';
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
    'opportunity-desc': (a, b) => missingLast(a, b, 'opportunityScore'),
    'target-asc': (a, b) => missingLast(a, b, 'targetDistance', 1),
    'forecast-desc': (a, b) => missingLast(a, b, 'forecastUpside'),
    'decline-asc': (a, b) => missingLast(a, b, 'change30d', 1),
    'changed-desc': (a, b) => String(b.entry.updatedAt || '').localeCompare(String(a.entry.updatedAt || '')),
    'value-desc': (a, b) => missingLast(a, b, 'currentPrice'),
    'added-desc': (a, b) => String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || ''))
  }[sort] || ((a, b) => missingLast(a, b, 'opportunityScore'));
  return models.sort((left, right) => compare(left, right) || String(left.ref.name || '').localeCompare(String(right.ref.name || '')));
}

function watchlistControls(state) {
  const controls = state.watchlist || {};
  const categories = [...new Set(state.watchlistItems.map((entry) => entry.catalogRef?.category).filter(Boolean))].sort();
  return `<section class="watchlist-controls" aria-label="Watchlist controls"><label class="sr-only" for="watchlist-query">Filter watchlist</label><input id="watchlist-query" type="search" value="${escapeAttribute(controls.query || '')}" placeholder="Filter watched cards" data-watchlist-query><label>Category<select data-watchlist-category><option value="all">All categories</option>${categories.map((category) => `<option value="${escapeAttribute(category)}" ${controls.category === category ? 'selected' : ''}>${escapeHTML(category[0].toUpperCase() + category.slice(1))}</option>`).join('')}</select></label><label>Sort<select data-watchlist-sort>${[
    ['opportunity-desc', 'Best opportunity'], ['target-asc', 'Closest to target'], ['forecast-desc', 'Largest forecasted upside'],
    ['decline-asc', 'Largest decline'], ['changed-desc', 'Recently changed'], ['value-desc', 'Highest value'], ['added-desc', 'Recently added']
  ].map(([value, label]) => `<option value="${value}" ${(controls.sort || 'opportunity-desc') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></section>`;
}

function watchlistSection(state) {
  const currency = state.settings.currency || 'USD';
  if (!state.watchlistItems.length) return `<section class="empty-state watchlist-empty"><span class="empty-symbol">☆</span><h2>Track cards before you buy</h2><p>Watch prices, set targets, and follow future outlooks.</p><button class="button" type="button" data-go="search">Find a card</button></section>`;
  const controls = state.watchlist || { query: '', category: 'all', sort: 'opportunity-desc' };
  const shown = filterAndSortWatchlist(state.watchlistItems, state.intelligence?.byVariant || {}, controls);
  const activeAlerts = (state.alerts || []).filter((alert) => !alert.readAt && !alert.mutedAt && state.watchlistItems.some((item) => item.watchKey === alert.watchKey));
  const configured = state.watchlistItems.filter((entry) => watchlistCardViewModel(entry).alertsEnabled).length;
  const filtersUseful = state.watchlistItems.length > 1 || controls.query || (controls.category && controls.category !== 'all');
  return `<section class="watchlist-overview"><div><p class="eyebrow">Purchase watch</p><strong>${state.watchlistItems.length} exact variant${state.watchlistItems.length === 1 ? '' : 's'}</strong><span>${configured} with targets or alerts · Approved intelligence alerts: ${activeAlerts.length}</span></div><button class="button secondary small" type="button" data-go="search">Find another card</button></section>
    ${filtersUseful ? watchlistControls(state) : ''}
    ${compareBar(state.compare || [])}
    <div class="section-heading"><div><p class="eyebrow">${shown.length} shown</p><h2>Watched cards</h2></div></div>
    ${shown.length ? `<div class="watchlist-grid">${shown.map((model) => watchlistCard(model, currency, activeAlerts.filter((alert) => alert.watchKey === model.entry.watchKey), state.compare || [])).join('')}</div>` : `<section class="empty-state"><h2>No watched cards match</h2><p>Clear the watchlist filters to see every exact variant.</p><button class="button ghost" type="button" data-action="clear-watchlist-filters">Clear filters</button></section>`}`;
}

function forecastSection(state) {
  const publicEnabled = Boolean(state.featureFlags?.publicPriceIntelligence);
  if (!publicEnabled) return `<section class="card intelligence-gate" role="status">
    <span class="support-badge ${publicEnabled ? 'supported' : 'restricted'}">${publicEnabled ? 'Publication enabled' : 'Research gate active'}</span>
    <h2>Forecasts are not publicly available</h2>
    <p>Watchlists work now. Public price intelligence remains disabled until source rights, mapping, and walk-forward model gates pass.</p>
    <ul class="evidence-list"><li>No fabricated estimates for unsupported cards.</li><li>Past predictions will remain immutable once forecasting launches.</li><li>Observed price, trend, fair value, and forecast will remain separate outputs.</li></ul>
  </section>`;

  const publications = Object.values(state.intelligence?.byVariant || {})
    .map(normalizeIntelligencePayload)
    .filter((publication) => Object.keys(publication.forecasts).length);
  const outlookCount = publications.reduce((count, publication) => count + Object.keys(publication.forecasts).length, 0);
  const status = `${state.intelligence?.loading ? '<p class="fine-print" role="status">Refreshing approved publications…</p>' : ''}${state.intelligence?.error ? `<p class="fine-print negative" role="status">${escapeHTML(state.intelligence.error)}</p>` : ''}`;
  if (!publications.length) return `${status}<section class="card intelligence-gate" role="status"><span class="support-badge supported">Publication enabled</span><h2>No approved forecasts published yet</h2><p>Cards appear here only after a rights-cleared model run passes horizon-specific baseline, leakage, and calibration gates.</p></section>`;
  return `${status}<div class="section-heading"><div><p class="eyebrow">${publications.length} product${publications.length === 1 ? '' : 's'} · ${outlookCount} approved horizon${outlookCount === 1 ? '' : 's'}</p><h2>Product outlooks</h2></div></div><div class="forecast-list">${publications.map((publication) => forecastCard(state, publication)).join('')}</div>`;
}

function holdingCard(holding, currency, state, view, selected) {
  const value = holdingMarketValue(holding);
  const cost = holdingCostBasis(holding);
  const gain = holdingGain(holding);
  const valueCurrency = holdingMarketCurrency(holding);
  const costCurrency = holdingCostCurrency(holding);
  const pricingStatus = holdingPricingStatus(holding);
  const providerPrice = holding.item?.price;
  const restrictedDisclosure = catalogPriceDisclosure(holding.item);
  const source = holding.manualMarketPrice !== '' && holding.manualMarketPrice != null
    ? providerPrice == null ? 'Manual value · market price unavailable' : restrictedDisclosure ? `Manual value · ${restrictedDisclosure}` : `Manual override · market reference retained at ${formatCurrency(providerPrice, holding.item?.currency || 'USD')}`
    : restrictedDisclosure || holding.item?.priceSource || 'Pricing unavailable';
  const key = watchKeyForItem(holding.item, { canonicalVariantId: holding.canonicalVariantId, conditionClass: holding.grade ? 'graded' : 'raw' });
  const watching = state.watchlistItems.some((entry) => entry.watchKey === key);
  const publication = holding.canonicalVariantId ? state.intelligence?.byVariant?.[holding.canonicalVariantId] : null;
  const intelligence = publication ? normalizeIntelligencePayload(publication) : null;
  const movement = intelligence?.supportTier >= 2 && intelligence.trend.return30d !== null
    ? `<span class="${intelligence.trend.return30d >= 0 ? 'positive' : 'negative'}"><span aria-hidden="true">${intelligence.trend.return30d >= 0 ? '↗' : '↘'}</span> ${escapeHTML(formatPercent(Math.abs(intelligence.trend.return30d) * 100))} / 30D</span>`
    : '<span>30D movement unavailable</span>';
  const forecastAvailable = Boolean(intelligence?.supportTier >= 4 && Object.keys(intelligence.forecasts).length);
  const identity = [holding.item?.setName, holding.item?.number ? `#${holding.item.number}` : '', holding.item?.variant, holding.item?.language].filter(Boolean).join(' · ');
  const condition = holding.grade ? `${holding.gradeCompany || 'Graded'} ${holding.grade}` : holding.condition || 'Condition not set';
  return `<article class="portfolio-holding-card ${escapeAttribute(view)}" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}" tabindex="0" aria-label="Inspect ${escapeAttribute(holding.item?.name || 'holding')}"><button class="holding-select" type="button" data-action="toggle-holding-selection" data-id="${escapeAttribute(holding.id)}" aria-pressed="${selected}" aria-label="${selected ? 'Deselect' : 'Select'} ${escapeAttribute(holding.item?.name || 'holding')}"><span aria-hidden="true">${selected ? '✓' : ''}</span></button><div class="holding-art">${externalImage({ ...holding.item, userImage: holding.userImage }, 'holding-image')}<span class="value-source ${escapeAttribute(pricingStatus)}">${escapeHTML(pricingStatus === 'market' ? 'Market' : pricingStatus === 'manual' ? 'Manual' : 'Unpriced')}</span></div><div class="holding-identity"><h3>${escapeHTML(holding.item?.name || 'Unnamed item')}</h3><p>${escapeHTML(identity || 'Custom catalog entry')}</p><div class="holding-pills"><span>${escapeHTML(condition)}</span><span>Qty ${escapeHTML(String(holding.quantity || 0))}</span>${holding.item?.rarity ? `<span>${escapeHTML(holding.item.rarity)}</span>` : ''}${(holding.tags || []).slice(0, 2).map((tag) => `<span>#${escapeHTML(tag)}</span>`).join('')}</div></div><dl class="holding-values"><div><dt>Current value</dt><dd>${pricingStatus === 'unpriced' ? '—' : escapeHTML(formatCurrency(value, valueCurrency))}</dd><small>${escapeHTML(source)}${valueCurrency !== currency ? ` · Excluded from ${escapeHTML(currency)} total` : ''}</small></div><div><dt>Cost basis</dt><dd>${escapeHTML(formatCurrency(cost, costCurrency))}</dd><small>Recorded acquisition${costCurrency !== currency ? ` · Excluded from ${escapeHTML(currency)} total` : ''}</small></div><div><dt>Gain or loss</dt><dd class="${pricingStatus === 'unpriced' || gain === null ? '' : gain >= 0 ? 'positive' : 'negative'}">${pricingStatus === 'unpriced' || gain === null ? '—' : escapeHTML(formatCurrency(gain, valueCurrency))}</dd><small>${pricingStatus === 'unpriced' ? 'Waiting for a value' : gain === null ? `${escapeHTML(valueCurrency)} value and ${escapeHTML(costCurrency)} cost cannot be combined` : escapeHTML(formatPercent(returnPercent(value, cost)))}</small></div></dl><div class="holding-outlook">${movement}<span class="${forecastAvailable ? 'forecast-available' : ''}">${forecastAvailable ? 'Outlook available' : 'No approved outlook'}</span></div><div class="holding-actions"><button class="button ghost small" type="button" data-action="toggle-watch" data-holding-id="${escapeAttribute(holding.id)}">${watching ? 'Watching' : 'Watch'}</button><button class="button ghost small" type="button" data-action="edit-holding" data-id="${escapeAttribute(holding.id)}">Edit</button><button class="button ghost small" type="button" data-action="delete-holding" data-id="${escapeAttribute(holding.id)}">Delete</button></div></article>`;
}

function compareBar(selection) {
  if (!selection.length) return '';
  return `<div class="card compare-bar" role="status"><span>${selection.length} of 4 selected for comparison</span><div class="button-row"><button class="button small" type="button" data-action="open-compare" ${selection.length < 2 ? 'disabled' : ''}>Compare</button><button class="button ghost small" type="button" data-action="clear-compare">Clear</button></div></div>`;
}

function watchlistCard(model, currency, alerts = [], compareSelection = []) {
  const { entry, ref, intelligence, observed, currentPrice, currentCurrency, targetPrice, targetCurrency, targetComparable, forecast, forecastUpside, opportunityScore, alertsEnabled, change7d, change30d } = model;
  const displayCurrency = currentCurrency || observed?.currency || ref.currency || currency;
  const support = entry.canonicalVariantId ? 'Exact card verified · approved outlook not published' : ref.mappingStatus === 'source_exact' ? 'Exact source identity · awaiting card verification' : 'Card identified · exact verification required';
  const change = (value) => value === null ? 'Unavailable' : `${value >= 0 ? '+' : ''}${formatPercent(value * 100)}`;
  const distance = targetPrice === null ? 'No target set' : currentPrice === null ? 'Waiting for a current price' : !targetComparable
    ? `Target is ${targetCurrency}; current price is ${displayCurrency}` : currentPrice <= targetPrice
    ? `${formatCurrency(targetPrice - currentPrice, displayCurrency)} below target`
    : `${formatCurrency(currentPrice - targetPrice, displayCurrency)} above target`;
  const forecastRange = forecast ? `${formatCurrency(forecast.q25, displayCurrency)}–${formatCurrency(forecast.q75, displayCurrency)}` : 'No approved outlook';
  const forecastMeta = forecast ? `${forecast.horizon}D · ${forecast.confidence === null ? 'confidence unavailable' : `confidence ${Math.round(forecast.confidence)}/100`}` : 'Still useful for targets and identity tracking';
  const alertText = alerts.length ? `${alerts.length} new alert${alerts.length === 1 ? '' : 's'}` : alertsEnabled ? 'Alerts on' : 'Alerts off';
  const update = observed?.observedAt || ref.priceUpdatedAt || entry.updatedAt;
  const updated = update && !Number.isNaN(new Date(update).valueOf()) ? new Date(update).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Not available';
  const signals = alerts.slice(0, 2).map((alert) => `<p class="watch-signal positive" role="status">● ${escapeHTML(alert.message)}</p>`).join('');
  const rankReason = opportunityScore === null
    ? 'Not ranked as an opportunity without an approved observed price, forecast, probability, and confidence.'
    : `Opportunity evidence: ${forecastUpside >= 0 ? '+' : ''}${formatPercent(forecastUpside * 100)} approved median upside with ${Math.round(forecast.probabilityUp * 100)}% probability of gain.`;
  return `<article class="watch-card"><div class="watch-card-art">${externalImage(ref, 'holding-image')}<span class="watch-alert-state ${alerts.length ? 'triggered' : alertsEnabled ? 'active' : ''}">${escapeHTML(alertText)}</span></div><div class="watch-card-main"><div class="watch-card-title"><div><h3>${escapeHTML(ref.name || 'Unnamed watched card')}</h3><p>${escapeHTML([ref.setName, ref.number, ref.rarity, ref.finish].filter(Boolean).join(' · '))}</p></div><button class="icon-button" type="button" data-action="remove-watch" data-watch-key="${escapeAttribute(entry.watchKey)}" aria-label="Remove ${escapeAttribute(ref.name || 'card')} from Watchlist">×</button></div><div class="watch-values"><div class="actual"><span>Current market</span><strong>${currentPrice === null ? 'Price unavailable' : escapeHTML(formatCurrency(currentPrice, displayCurrency))}</strong><small>${escapeHTML(observed?.source || catalogPriceDisclosure(ref) || ref.priceSource || 'No approved observed-price source')}</small></div><div class="forecast"><span>Future outlook</span><strong>${escapeHTML(forecastRange)}</strong><small>${escapeHTML(forecastMeta)}</small></div></div><dl class="watch-stats"><div><dt>7-day move</dt><dd class="${change7d === null ? '' : change7d >= 0 ? 'positive' : 'negative'}">${escapeHTML(change(change7d))}</dd></div><div><dt>30-day move</dt><dd class="${change30d === null ? '' : change30d >= 0 ? 'positive' : 'negative'}">${escapeHTML(change(change30d))}</dd></div><div><dt>Target</dt><dd>${targetPrice === null ? 'Not set' : escapeHTML(formatCurrency(targetPrice, targetCurrency))}<small>${escapeHTML(distance)}</small></dd></div><div><dt>Last price update</dt><dd>${escapeHTML(updated)}<small>${escapeHTML(ref.salesFrequency || 'Liquidity unavailable')}</small></dd></div></dl>${intelligence ? intelligenceSummary(intelligence, displayCurrency) : `<span class="support-badge unsupported">${escapeHTML(SUPPORT_LABELS[0])} · ${escapeHTML(support)}</span>`}<p class="opportunity-reason">${escapeHTML(rankReason)}</p>${signals}<div class="item-actions"><button class="button ghost small" type="button" data-action="open-detail" data-watch-key="${escapeAttribute(entry.watchKey)}">Details</button><button class="button ghost small" type="button" data-action="toggle-compare" data-watch-key="${escapeAttribute(entry.watchKey)}">${compareSelection.includes(entry.watchKey) ? '☑ Comparing' : '☐ Compare'}</button><button class="button secondary small" type="button" data-action="add-watched" data-watch-key="${escapeAttribute(entry.watchKey)}">Add to portfolio</button><button class="button ghost small" type="button" data-action="edit-watch" data-watch-key="${escapeAttribute(entry.watchKey)}">Target &amp; alerts</button></div></div></article>`;
}

function intelligenceSummary(intelligence, currency, compact = false) {
  const tone = intelligence.supportTier >= 4 ? 'supported' : intelligence.supportTier >= 2 ? 'partial' : 'unsupported';
  const trend = intelligence.supportTier >= 2 && intelligence.trend.return30d !== null
    ? `<span class="intelligence-stat ${intelligence.trend.return30d >= 0 ? 'positive' : 'negative'}">${escapeHTML(formatPercent(intelligence.trend.return30d * 100))} / 30D · ${escapeHTML(trendLabel(intelligence.trend.status))}</span>`
    : '';
  const fair = !compact && intelligence.supportTier >= 3 && intelligence.fairValue
    ? `<span class="intelligence-stat">Fair range ${escapeHTML(formatCurrency(intelligence.fairValue.q10, currency))}–${escapeHTML(formatCurrency(intelligence.fairValue.q90, currency))}</span>`
    : '';
  return `<div class="intelligence-summary"><span class="support-badge ${tone}">${escapeHTML(SUPPORT_LABELS[intelligence.supportTier] || 'Approved market evidence')}</span>${trend}${fair}</div>`;
}

function forecastCard(state, publication) {
  const holding = state.holdings.find((entry) => entry.canonicalVariantId === publication.variantId);
  const watched = state.watchlistItems.find((entry) => entry.canonicalVariantId === publication.variantId);
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
  return `<article class="card forecast-card product-outlook-card"><div class="forecast-product-head">${externalImage(item, 'forecast-product-image')}<div><p class="eyebrow">Approved product outlook</p><h2>${escapeHTML(item.name || 'Verified card')}</h2><p class="item-meta">${escapeHTML([item.setName, item.number, item.finish || item.variant].filter(Boolean).join(' · '))}</p><div class="intelligence-summary"><span class="support-badge supported">${escapeHTML(SUPPORT_LABELS[publication.supportTier] || 'Forecast available')}</span>${trend}</div></div>${detail}</div>${projection}<div class="forecast-horizon-list">${forecasts.map((forecast) => `<section class="forecast-horizon"><div class="form-section-heading"><div><p class="eyebrow">${forecast.horizon}-day outlook</p><h3>${escapeHTML(formatCurrency(forecast.q50, currency))} median</h3></div>${forecast.confidence === null ? '' : `<span class="pill">Confidence ${Math.round(forecast.confidence)}/100</span>`}</div><div class="forecast-grid"><div><span>50% range</span><strong>${escapeHTML(formatCurrency(forecast.q25, currency))}–${escapeHTML(formatCurrency(forecast.q75, currency))}</strong></div><div><span>80% range</span><strong>${escapeHTML(formatCurrency(forecast.q10, currency))}–${escapeHTML(formatCurrency(forecast.q90, currency))}</strong></div><div><span>Probability of gain</span><strong>${forecast.probabilityUp === null ? '—' : `${Math.round(forecast.probabilityUp * 100)}%`}</strong></div></div><p class="fine-print">Origin ${escapeHTML(forecast.origin || 'not disclosed')} · Matures ${escapeHTML(forecast.maturesAt || 'not disclosed')} · Model ${escapeHTML(forecast.modelVersion || 'not disclosed')}</p></section>`).join('')}</div>${source ? `<p class="price-source">Sources: ${escapeHTML(source)}</p>` : ''}</article>`;
}
