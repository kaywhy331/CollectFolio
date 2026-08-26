import { emptyState, externalImage, pageHeader } from '../core/components.js';
import { icon } from '../core/icons.js';
import { holdingMarketCurrency, holdingMarketValue, holdingPricingStatus, portfolioAllocation, portfolioSummary, snapshotFor } from '../core/calculations.js';
import { collectionFreshness } from '../core/data-freshness.js';
import { normalizeIntelligencePayload } from '../core/intelligence-contract.js';
import { trendChart } from '../core/ui.js';
import { holdingViewModel } from '../core/view-models.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { selectPublicationForHolding } from '../core/market-series.js';
import { mergeRetroSeriesWithSnapshots, reconstructPortfolioValueSeries } from '../core/portfolio-history.js';
import { historyKeyForItem } from '../services/history-trajectory.js';
import { UNKNOWN } from '../core/copy.js';

export const OVERVIEW_RANGES = Object.freeze(['1D', '7D', '1M', '3M', '1Y', 'All']);

const RANGE_DAYS = Object.freeze({ '1D': 1, '7D': 7, '1M': 30, '3M': 90, '1Y': 365, All: Infinity });

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function hasManualValue(holding = {}) {
  return holding.manualMarketPrice !== ''
    && holding.manualMarketPrice !== null
    && holding.manualMarketPrice !== undefined
    && Number.isFinite(Number(holding.manualMarketPrice));
}

function filterByRange(points, range) {
  const days = RANGE_DAYS[OVERVIEW_RANGES.includes(range) ? range : '3M'];
  if (!Number.isFinite(days) || !points.length) return points;
  const latest = validDate(`${points.at(-1).date}T00:00:00.000Z`);
  if (!latest) return points;
  const cutoff = new Date(latest);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return points.filter((point) => validDate(`${point.date}T00:00:00.000Z`) >= cutoff);
}

// The locally-recorded side of the chart series: today's live snapshot
// plus every recorded daily local snapshot, one point per day. This is
// exactly what overviewSeries used to compute end to end before 0.8.17
// added a retro-history side to merge in (see overviewSeriesWithHistory
// below) -- kept as its own function because mergeRetroSeriesWithSnapshots
// needs it as the "snapshots win" input on its own, range-unfiltered.
function dailySnapshotSeries(holdings = [], snapshots = [], now = new Date(), currency = 'USD') {
  if (!holdings.length) return [];
  const current = snapshotFor(holdings, now, { currency });
  const byDay = new Map(
    (Array.isArray(snapshots) ? snapshots : [])
      .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(String(entry?.date || '')))
      .filter((entry) => String(entry.currency || 'USD').toUpperCase() === String(currency).toUpperCase())
      .map((entry) => [entry.date, { ...entry }])
  );
  if (holdings.some((holding) => holdingPricingStatus(holding) !== 'unpriced')) byDay.set(current.date, current);
  return [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
}

// 0.8.17: resolves each holding's TCGCSV weekly price-history points (if
// any were published for it) out of `state.priceHistory.byKey`, keyed by
// holding.id for portfolio-history.js's reconstruction input. A holding
// with no TCGCSV identity, or whose group/variant was never published,
// is simply absent from the returned map -- reconstructPortfolioValueSeries
// treats that as its documented flat-fallback case, never an error.
export function historyPointsByHoldingId(holdings = [], priceHistory = {}) {
  const byKey = priceHistory?.byKey || {};
  const result = {};
  (Array.isArray(holdings) ? holdings : []).forEach((holding) => {
    const key = historyKeyForItem(holding?.item || {});
    const entry = key ? byKey[key] : null;
    if (entry?.available && Array.isArray(entry.points) && entry.points.length) {
      result[holding.id] = entry.points;
    }
  });
  return result;
}

export function overviewSeries(holdings = [], snapshots = [], range = '3M', now = new Date(), currency = 'USD') {
  return filterByRange(dailySnapshotSeries(holdings, snapshots, now, currency), range);
}

// 0.8.17: merges the Item-3 retro weekly reconstruction (from published
// TCGCSV price history) underneath the existing locally-recorded daily
// snapshot series -- snapshots win on any overlapping date, per the
// coordinator's merge strategy. `historyPointsByHoldingId` is
// `{ [holding.id]: [[date, price], ...] }`, already resolved by the
// caller from state.priceHistory.byKey (see hydratePortfolioHistory in
// app.js). Falls back to plain snapshot-only behavior (identical to
// overviewSeries) when no history is resolvable for any holding --
// fail-closed, never a regression from pre-0.8.17 behavior.
//
// DCL-HOME-05: split out of overviewSeriesWithHistory so renderHome can
// compute per-range point counts off the *unfiltered* merged series (to
// decide which range buttons are even eligible to render) without a second,
// independent recomputation of the merge. overviewSeriesWithHistory's own
// signature/behavior is unchanged -- it now just calls this and filters.
export function mergedOverviewSeries(holdings = [], snapshots = [], historyPointsByHoldingId = {}, now = new Date(), currency = 'USD') {
  const daily = dailySnapshotSeries(holdings, snapshots, now, currency);
  const retro = reconstructPortfolioValueSeries(holdings, historyPointsByHoldingId, { currency, now });
  return { points: mergeRetroSeriesWithSnapshots(retro.points, daily), coverage: retro.coverage };
}

export function overviewSeriesWithHistory(holdings = [], snapshots = [], historyPointsByHoldingId = {}, range = '3M', now = new Date(), currency = 'USD') {
  const { points, coverage } = mergedOverviewSeries(holdings, snapshots, historyPointsByHoldingId, now, currency);
  return { points: filterByRange(points, range), coverage };
}

export function overviewChange(points = []) {
  if (points.length < 2) return { amount: null, percent: null };
  const first = Number(points[0]?.marketValue);
  const last = Number(points.at(-1)?.marketValue);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { amount: null, percent: null };
  return {
    amount: last - first,
    percent: first > 0 ? ((last - first) / first) * 100 : null
  };
}

export function pricingCoverage(holdings = [], byVariant = {}) {
  const result = { market: 0, manual: 0, unpriced: 0, covered: 0, total: holdings.length, percent: 0 };
  holdings.forEach((holding) => {
    const publication = holding.canonicalVariantId
      ? selectPublicationForHolding(byVariant?.[holding.canonicalVariantId], holding, holdingMarketCurrency(holding))
      : null;
    const model = holdingViewModel(holding, { publication });
    if (hasManualValue(holding)) result.manual += 1;
    else if (['verified', 'delayed'].includes(model.valueSource) || (model.valueSource === 'pending' && model.unitValue > 0)) result.market += 1;
    else result.unpriced += 1;
  });
  result.covered = result.market + result.manual;
  result.percent = result.total ? (result.covered / result.total) * 100 : 0;
  return result;
}

// PRD Sec 10.3 compact Overview modules. Both render nothing at all when no
// approved intelligence or alert data exists, so dormant capabilities do not
// create empty dashboard chrome.
export function portfolioMovers(holdings = [], byVariant = {}, limit = 3) {
  return holdings
    .map((holding) => ({
      holding,
      publication: holding.canonicalVariantId
        ? selectPublicationForHolding(byVariant[holding.canonicalVariantId], holding, holdingMarketCurrency(holding))
        : null
    }))
    .filter(({ publication }) => publication)
    .map(({ holding, publication }) => ({ holding, intelligence: normalizeIntelligencePayload(publication) }))
    .filter(({ intelligence }) => intelligence.supportTier >= 2 && intelligence.trend.return30d !== null)
    .sort((left, right) => Math.abs(right.intelligence.trend.return30d) - Math.abs(left.intelligence.trend.return30d))
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function watchlistSignals(alerts = [], watchlistItems = []) {
  const watchedKeys = new Set(watchlistItems.map((entry) => entry.watchKey));
  return alerts
    .filter((alert) => !alert.readAt && !alert.mutedAt && watchedKeys.has(alert.watchKey))
    .slice(0, 3);
}

function movementMarkup(change, range, currency) {
  if (change.amount === null) {
    return '<p class="overview-movement neutral"><span aria-hidden="true">●</span> Tracking began today</p>';
  }
  const tone = change.amount >= 0 ? 'positive' : 'negative';
  const direction = change.amount >= 0 ? 'Increased' : 'Decreased';
  const glyph = change.amount >= 0 ? '↗' : '↘';
  const percent = change.percent === null ? '' : ` (${formatPercent(change.percent)})`;
  return `<p class="overview-movement ${tone}"><span aria-hidden="true">${glyph}</span><span class="sr-only">${direction}</span> ${escapeHTML(formatCurrency(Math.abs(change.amount), currency))}${escapeHTML(percent)} <span class="muted">${escapeHTML(range)}</span></p>`;
}

function attentionModule(state, coverage) {
  const signals = watchlistSignals(state.alerts, state.watchlistItems);
  const items = [];
  // DCL-NAV-03: the deep-link filter (pricing=unpriced) itself is wired up
  // by app.js's data-go handler in a later stage -- this just emits the
  // attribute the handler will read.
  if (coverage.unpriced) items.push(`<button class="attention-item" type="button" data-go="portfolio" data-portfolio-pricing="unpriced"><span class="attention-icon warning" aria-hidden="true">!</span><span><strong>${coverage.unpriced} unpriced item${coverage.unpriced === 1 ? '' : 's'}</strong><small>Add a manual value or review the exact printing.</small></span><span aria-hidden="true">→</span></button>`);
  if (state.scanDraftCount) items.push(`<button class="attention-item" type="button" data-action="resume-scan"><span class="attention-icon">${icon('resume', { size: 20 })}</span><span><strong>Saved scan ready</strong><small>Continue reviewing ${state.scanDraftCount} local draft${state.scanDraftCount === 1 ? '' : 's'}.</small></span><span aria-hidden="true">→</span></button>`);
  if (signals.length) items.push(`<button class="attention-item" type="button" data-go="portfolio" data-portfolio-target="watchlist" data-watchlist-view="alerts"><span class="attention-icon positive" aria-hidden="true">◆</span><span><strong>${signals.length} Watchlist alert${signals.length === 1 ? '' : 's'}</strong><small>${escapeHTML(signals[0].message)}</small></span><span aria-hidden="true">→</span></button>`);
  if (!items.length) return '';
  return `<section class="overview-attention" aria-labelledby="attention-title"><div class="section-heading compact"><div><p class="eyebrow">Today</p><h2 id="attention-title">Needs attention</h2></div></div><div class="attention-list">${items.join('')}</div></section>`;
}

function moversModule(state) {
  const movers = portfolioMovers(state.holdings, state.intelligence?.byVariant);
  if (!movers.length) return '';
  return `<section class="card overview-module"><div class="section-heading compact"><div><p class="eyebrow">30-day movement</p><h2>Top movers</h2></div><button class="button ghost small" type="button" data-go="portfolio">View all</button></div>
    <div class="overview-card-list">${movers.map(({ holding, intelligence }) => {
      const change = intelligence.trend.return30d;
      const tone = change >= 0 ? 'positive' : 'negative';
      // CENSUS GAP CLOSURE: the trend-label word ("Rise"/"Fall"/...) is
      // dropped -- the arrow glyph + tone color + signed percent already
      // carry direction and magnitude, so the word only restated them.
      return `<button class="overview-card-row" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}">${externalImage({ ...holding.item, userImage: holding.userImage }, 'card-thumbnail')}<span><strong>${escapeHTML(holding.item?.name || 'Mapped card')}</strong><small>${escapeHTML([holding.item?.setName, holding.item?.number].filter(Boolean).join(' · ') || 'Exact item')}</small><span class="${tone}"><span aria-hidden="true">${change >= 0 ? '↗' : '↘'}</span> ${escapeHTML(formatPercent(Math.abs(change) * 100))}</span></span><span aria-hidden="true">→</span></button>`;
    }).join('')}</div></section>`;
}

function recentHoldingsModule(state, currency) {
  const recent = [...state.holdings]
    .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))
    .slice(0, 4);
  if (!recent.length) return '';
  return `<section class="card overview-module"><div class="section-heading compact"><div><p class="eyebrow">Collection</p><h2>Recent items</h2></div><button class="button ghost small" type="button" data-go="portfolio">View all</button></div><div class="overview-card-list">${recent.map((holding) => {
    const valueCurrency = holdingMarketCurrency(holding);
    const pricing = holdingPricingStatus(holding);
    const value = pricing === 'unpriced' ? 'Unpriced' : formatCurrency(holdingMarketValue(holding), valueCurrency);
    const valueType = pricing === 'manual' ? 'Manual value' : pricing === 'market' ? 'Market value' : '';
    return `<button class="overview-card-row" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}">${externalImage({ ...holding.item, userImage: holding.userImage }, 'card-thumbnail')}<span><strong>${escapeHTML(holding.item?.name || 'Unnamed item')}</strong><small>${escapeHTML([holding.item?.setName, holding.item?.number].filter(Boolean).join(' · ') || 'Custom item')}</small><span>${escapeHTML(value)}${valueType ? ` · ${escapeHTML(valueType)}` : ''}${pricing !== 'unpriced' && valueCurrency !== currency ? ` · outside ${escapeHTML(currency)} total` : ''} · Qty ${escapeHTML(String(holding.quantity || 0))}</span></span><span aria-hidden="true">→</span></button>`;
  }).join('')}</div></section>`;
}

function allocationModule(state, currency) {
  const entries = Object.entries(portfolioAllocation(state.holdings, { currency }))
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return '';
  const segments = entries.map(([label, value], index) => {
    const percent = (value / total) * 100;
    return `<span class="allocation-segment mix-tone-${index % 6}" style="--allocation-share:${percent.toFixed(2)}%"><span class="sr-only">${escapeHTML(label)} ${percent.toFixed(0)}%</span></span>`;
  }).join('');
  const ranked = entries.map(([label, value], index) => {
    const percent = (value / total) * 100;
    return `<li><i class="mix-tone-${index % 6}" aria-hidden="true"></i><span><strong>${escapeHTML(label)}</strong><small>${escapeHTML(formatCurrency(value, currency))}</small></span><b>${percent.toFixed(0)}%</b></li>`;
  }).join('');
  return `<section class="card overview-module"><div class="section-heading compact"><div><p class="eyebrow">By accepted value</p><h2>Collection mix</h2></div></div><div class="allocation-stack" role="img" aria-label="Collection value mix by category">${segments}</div><ol class="allocation-ranking">${ranked}</ol></section>`;
}

function refreshStatusMarkup(refresh = {}) {
  if (!refresh.status || refresh.status === 'disabled') return '';
  // DCL-HOME-08: "current" detail drops the internals-flavored "refresh
  // completed successfully" phrasing; the receipt sentence drops the
  // "Last successful refresh:" label for a plain "Updated <date>." (the
  // localized date/time formatting itself is unchanged).
  const labels = {
    loading: ['Checking price freshness', 'Your saved collection remains available while this finishes.'],
    current: ['Prices updated recently', 'Prices are up to date.'],
    in_progress: ['Prices are updating', 'Saved values remain visible during the update.'],
    update_required: ['Price update scheduled', 'Your current saved values remain available.'],
    unavailable: ['Refresh status unavailable', 'Your collection remains usable with its saved local data.']
  };
  const [label, detail] = labels[refresh.status] || labels.unavailable;
  const successful = refresh.lastSuccessfulSourceBuild
    ? validDate(refresh.lastSuccessfulSourceBuild)
    : null;
  const receipt = successful
    ? ` Updated ${successful.toLocaleString(undefined, {
      dateStyle: 'medium', timeStyle: 'short'
    })}.`
    : '';
  return `<section class="source-refresh-status" data-source-refresh-status="${escapeAttribute(refresh.status)}" role="status"><span class="source-refresh-dot" aria-hidden="true"></span><span><strong>${escapeHTML(label)}</strong><small>${escapeHTML(detail + receipt)}</small></span></section>`;
}

// DCL-HOME-10/LEX-09: the currency-scope note is owned here (Data Health)
// only -- the in-flow hero/summary fine print that used to repeat it was
// deleted. Renders nothing when every holding's value/cost is already in
// the collection currency.
function currencyScopeNote(summary, currency) {
  if (!summary.excludedMarketItems && !summary.excludedCostItems) return '';
  return `<p class="fine-print currency-scope-note">Amounts in ${escapeHTML(summary.excludedCurrencies.join(', '))} are shown separately from ${escapeHTML(currency)} totals.</p>`;
}

// The refresh affordance lives here (rather than a page header) for the
// holdings-present path -- DCL-HOME-01 removes the page header once
// holdings exist, so this row is the one place left to reach it.
//
// A11y fix (DCL-VER-05): the refresh button used to sit *inside*
// <summary>, which axe flags as "nested-interactive" (a <summary> is
// itself an interactive disclosure control, so a focusable button inside
// it is unreachable/ambiguous for assistive tech). The button is now a
// sibling of <summary> -- still a direct child of <details>, positioned
// over the same row purely with CSS (see .data-health-refresh in
// app.css) -- so no interactive control nests inside another.
function dataHealthModule(state, coverage, historyCoverage, freshness, summary, currency) {
  const historyPercent = Number(historyCoverage?.percent) || 0;
  return `<details class="card data-health"><summary><span><strong>Data Health</strong><small>${coverage.percent.toFixed(0)}% pricing coverage · ${freshness.stale} stale</small></span><span aria-hidden="true">⌄</span></summary><button class="icon-button data-health-refresh" type="button" data-action="refresh-prices" aria-label="Refresh prices">${icon('refresh', { size: 20 })}</button><div class="data-health-grid"><div><span>Market-price coverage</span><strong>${coverage.market} of ${coverage.total}</strong></div><div><span>History coverage</span><strong>${historyPercent}%</strong></div><div><span>Stale values</span><strong>${freshness.stale}</strong></div><div><span>Manual values</span><strong>${coverage.manual}</strong></div><div><span>Last price update</span><strong>${escapeHTML(freshness.latest.label)}</strong></div></div>${currencyScopeNote(summary, currency)}${refreshStatusMarkup(state.tcgcsvRefresh)}</details>`;
}

export function renderHome(state) {
  const currency = state.settings.currency || 'USD';
  const summary = portfolioSummary(state.holdings, { currency });
  const now = new Date();
  const historyPoints = historyPointsByHoldingId(state.holdings, state.priceHistory);
  const merged = mergedOverviewSeries(state.holdings, state.snapshots, historyPoints, now, currency);
  // DCL-HOME-05: a range is only eligible when its filtered series (from the
  // unfiltered merged series) has >=2 points -- a single point can't draw a
  // trend line. Ineligible buttons are hidden below; a saved selection
  // that's gone ineligible falls back to the widest eligible range, since
  // OVERVIEW_RANGES is already ordered narrowest to widest. A brand-new
  // collection (only "today", no range yet has 2+ points) falls back to
  // showing the full range set rather than an empty control -- the chart
  // itself already renders its own insufficient-data state for one point.
  const eligibleRanges = OVERVIEW_RANGES.filter((option) => filterByRange(merged.points, option).length >= 2);
  const visibleRanges = eligibleRanges.length ? eligibleRanges : OVERVIEW_RANGES;
  const widestEligible = eligibleRanges.length ? eligibleRanges[eligibleRanges.length - 1] : '3M';
  const requestedRange = OVERVIEW_RANGES.includes(state.overview?.range) ? state.overview.range : widestEligible;
  const range = eligibleRanges.length && !eligibleRanges.includes(requestedRange) ? widestEligible : requestedRange;
  const series = filterByRange(merged.points, range);
  const historyCoverage = merged.coverage;
  const change = overviewChange(series);
  const coverage = pricingCoverage(state.holdings, state.intelligence?.byVariant);
  const freshness = collectionFreshness(state.holdings);
  const chartSeries = series.map((point) => ({ ...point, costBasis: summary.costBasisItems ? point.costBasis : null }));
  const gainValid = summary.gainEligibleItems > 0 && summary.returnPercent !== null;
  const gainTone = gainValid && summary.gain < 0 ? 'negative' : 'positive';

  const dataHealth = dataHealthModule(state, coverage, historyCoverage, freshness, summary, currency);

  // DCL-HOME-01: the page header only survives on the empty-state path --
  // once holdings exist the hero card is the first element on Home.
  if (!state.holdings.length) {
    const header = pageHeader(state.settings.collectionName || 'Personal Collection', 'Home', 'A clear view of what you own and what needs attention', `<button class="icon-button" type="button" data-action="refresh-prices" aria-label="Refresh prices">${icon('refresh', { size: 20 })}</button>`);
    return `${header}<div class="overview-empty">${emptyState('Build your collection', 'Scan or search for your first collectible to start tracking its value.', '<div class="button-row centered"><button class="button" type="button" data-go="add">Scan first item</button><button class="button ghost" type="button" data-go="search">Search catalog</button></div>')}</div>${state.scanDraftCount ? `<button class="button secondary" type="button" data-action="resume-scan">Resume saved scan (${state.scanDraftCount})</button>` : ''}${dataHealth}`;
  }

  return `<section class="overview-hero" aria-label="Collection performance">
      <article class="card overview-performance">
        <div class="overview-performance-head"><div><p class="metric-label">Estimated value</p><strong class="overview-value">${coverage.covered ? escapeHTML(formatCurrency(summary.marketValue, currency)) : UNKNOWN.unpriced}</strong><span class="freshness-badge" data-freshness="${escapeAttribute(freshness.latest.state)}">${escapeHTML(freshness.latest.label)}</span>${movementMarkup(change, range, currency)}</div><div class="range-control" role="group" aria-label="Collection chart range">${visibleRanges.map((option) => `<button type="button" data-overview-range="${escapeAttribute(option)}" aria-pressed="${option === range}">${escapeHTML(option)}</button>`).join('')}</div></div>
        ${trendChart(chartSeries, currency)}
      </article>
      <aside class="overview-summary" aria-label="Collection summary">
        <article class="summary-stat"><span>Cost basis</span><strong>${summary.costBasisItems ? escapeHTML(formatCurrency(summary.costBasis, currency)) : UNKNOWN.notRecorded}</strong><small>${summary.costBasisItems ? `${summary.costBasisItems} of ${summary.uniqueItems} purchases include cost` : 'Add purchase details to calculate'}</small></article>
        <article class="summary-stat"><span>Estimated gain</span><strong class="${gainValid ? gainTone : ''}">${gainValid ? `<span aria-hidden="true">${summary.gain >= 0 ? '↗' : '↘'}</span> ${escapeHTML(formatCurrency(summary.gain, currency))}` : UNKNOWN.dash}</strong><small>${gainValid ? `${escapeHTML(formatPercent(summary.returnPercent))} · ${summary.gainEligibleItems} comparable purchase${summary.gainEligibleItems === 1 ? '' : 's'}` : 'Needs both current value and cost basis'}</small></article>
        <article class="summary-stat"><span>Pricing coverage</span><strong>${coverage.percent.toFixed(0)}%</strong><small>${coverage.market} market · ${coverage.manual} manual · ${coverage.unpriced} unpriced</small></article>
      </aside>
    </section>
    ${attentionModule(state, coverage)}
    <div class="overview-modules">${moversModule(state)}${recentHoldingsModule(state, currency)}${allocationModule(state, currency)}</div>${dataHealth}`;
}
