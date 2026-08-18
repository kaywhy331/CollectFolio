import { emptyState, externalImage, pageHeader } from '../core/components.js';
import { holdingMarketCurrency, holdingMarketValue, portfolioAllocation, portfolioSummary, snapshotFor } from '../core/calculations.js';
import { normalizeIntelligencePayload, trendLabel } from '../core/intelligence-contract.js';
import { localPortfolioInsights, localPortfolioScenario } from '../core/local-scenarios.js';
import { allocationChart, trendChart } from '../core/ui.js';
import { holdingViewModel } from '../core/view-models.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { selectPublicationForHolding } from '../core/market-series.js';
import { mergeRetroSeriesWithSnapshots, reconstructPortfolioValueSeries } from '../core/portfolio-history.js';
import { historyKeyForItem } from '../services/history-trajectory.js';

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
  byDay.set(current.date, current);
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
export function overviewSeriesWithHistory(holdings = [], snapshots = [], historyPointsByHoldingId = {}, range = '3M', now = new Date(), currency = 'USD') {
  const daily = dailySnapshotSeries(holdings, snapshots, now, currency);
  const retro = reconstructPortfolioValueSeries(holdings, historyPointsByHoldingId, { currency, now });
  const merged = mergeRetroSeriesWithSnapshots(retro.points, daily);
  return { points: filterByRange(merged, range), coverage: retro.coverage };
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
export function portfolioMovers(holdings = [], byVariant = {}) {
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
    .slice(0, 3);
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

function forecastCoverage(state) {
  const currency = state.settings.currency || 'USD';
  const scenario = localPortfolioScenario(state.holdings, state.localValueObservations || [], 90, { currency });
  const published = state.featureFlags?.publicPriceIntelligence
    ? state.holdings.filter((holding) => {
      const publication = holding.canonicalVariantId
        ? selectPublicationForHolding(state.intelligence?.byVariant?.[holding.canonicalVariantId], holding, currency)
        : null;
      return publication && holdingViewModel(holding, { publication }).forecasts.length > 0;
    }).length
    : 0;
  return scenario.coveredHoldings
    ? { count: scenario.coveredHoldings, label: `${scenario.coveredHoldings} of ${state.holdings.length}`, detail: `Local 90-day scenarios · ${published} published market outlook${published === 1 ? '' : 's'}.` }
    : { count: 0, label: 'Needs values', detail: 'Add a current value to start manual scenarios.' };
}

function attentionModule(state, coverage) {
  const signals = watchlistSignals(state.alerts, state.watchlistItems);
  const items = [];
  if (coverage.unpriced) items.push(`<button class="attention-item" type="button" data-go="portfolio"><span class="attention-icon warning" aria-hidden="true">!</span><span><strong>${coverage.unpriced} unpriced holding${coverage.unpriced === 1 ? '' : 's'}</strong><small>Add a manual value or review the exact printing.</small></span><span aria-hidden="true">→</span></button>`);
  if (state.scanDraftCount) items.push(`<button class="attention-item" type="button" data-action="resume-scan"><span class="attention-icon" aria-hidden="true">↥</span><span><strong>Saved scan ready</strong><small>Continue reviewing ${state.scanDraftCount} local draft${state.scanDraftCount === 1 ? '' : 's'}.</small></span><span aria-hidden="true">→</span></button>`);
  if (signals.length) items.push(`<button class="attention-item" type="button" data-insights-view="alerts"><span class="attention-icon positive" aria-hidden="true">◆</span><span><strong>${signals.length} Watchlist alert${signals.length === 1 ? '' : 's'}</strong><small>${escapeHTML(signals[0].message)}</small></span><span aria-hidden="true">→</span></button>`);
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
      return `<button class="overview-card-row" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}">${externalImage({ ...holding.item, userImage: holding.userImage }, 'card-thumbnail')}<span><strong>${escapeHTML(holding.item?.name || 'Mapped card')}</strong><small>${escapeHTML([holding.item?.setName, holding.item?.number].filter(Boolean).join(' · ') || 'Exact holding')}</small><span class="${tone}"><span aria-hidden="true">${change >= 0 ? '↗' : '↘'}</span> ${escapeHTML(formatPercent(Math.abs(change) * 100))} · ${escapeHTML(trendLabel(intelligence.trend.status))}</span></span><span aria-hidden="true">→</span></button>`;
    }).join('')}</div></section>`;
}

function recentHoldingsModule(state, currency) {
  const recent = [...state.holdings]
    .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))
    .slice(0, 4);
  if (!recent.length) return '';
  return `<section class="card overview-module"><div class="section-heading compact"><div><p class="eyebrow">Collection</p><h2>Recent holdings</h2></div><button class="button ghost small" type="button" data-go="portfolio">View all</button></div><div class="overview-card-list">${recent.map((holding) => {
    const valueCurrency = holdingMarketCurrency(holding);
    return `<button class="overview-card-row" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}">${externalImage({ ...holding.item, userImage: holding.userImage }, 'card-thumbnail')}<span><strong>${escapeHTML(holding.item?.name || 'Unnamed item')}</strong><small>${escapeHTML([holding.item?.setName, holding.item?.number].filter(Boolean).join(' · ') || 'Custom holding')}</small><span>${escapeHTML(formatCurrency(holdingMarketValue(holding), valueCurrency))}${valueCurrency !== currency ? ` · outside ${escapeHTML(currency)} total` : ''} · Qty ${escapeHTML(String(holding.quantity || 0))}</span></span><span aria-hidden="true">→</span></button>`;
  }).join('')}</div></section>`;
}

function allocationModule(state, currency) {
  const allocation = portfolioAllocation(state.holdings, { currency });
  if (!Object.values(allocation).some((value) => value > 0)) return '';
  return `<section class="card overview-module"><div class="section-heading compact"><div><p class="eyebrow">By market value</p><h2>Collection mix</h2></div></div>${allocationChart(allocation)}</section>`;
}

function refreshStatusMarkup(refresh = {}) {
  if (!refresh.status || refresh.status === 'disabled') return '';
  const labels = {
    loading: ['Checking market data', 'Reading the latest private refresh receipt.'],
    current: ['Market data is current', 'The latest market data build completed successfully.'],
    in_progress: ['Market data is updating', 'One deterministic full-cohort refresh is in progress.'],
    update_required: ['New market data is queued', 'The hourly refresh lane will process this source build.'],
    unavailable: ['Refresh status unavailable', 'The portfolio remains usable with its existing local data.']
  };
  const [label, detail] = labels[refresh.status] || labels.unavailable;
  const successful = refresh.lastSuccessfulSourceBuild
    ? validDate(refresh.lastSuccessfulSourceBuild)
    : null;
  const receipt = successful
    ? ` Last successful build: ${successful.toLocaleString(undefined, {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'
    })} UTC.`
    : '';
  return `<section class="source-refresh-status" data-source-refresh-status="${escapeAttribute(refresh.status)}" role="status"><span class="source-refresh-dot" aria-hidden="true"></span><span><strong>${escapeHTML(label)}</strong><small>${escapeHTML(detail + receipt)}</small></span></section>`;
}

export function renderHome(state) {
  const currency = state.settings.currency || 'USD';
  const summary = portfolioSummary(state.holdings, { currency });
  const range = OVERVIEW_RANGES.includes(state.overview?.range) ? state.overview.range : '3M';
  const historyPoints = historyPointsByHoldingId(state.holdings, state.priceHistory);
  const { points: series, coverage: historyCoverage } = overviewSeriesWithHistory(
    state.holdings, state.snapshots, historyPoints, range, new Date(), currency
  );
  const change = overviewChange(series);
  const gainTone = summary.gain >= 0 ? 'positive' : 'negative';
  const coverage = pricingCoverage(state.holdings, state.intelligence?.byVariant);
  const forecast = forecastCoverage(state);
  const localInsights = localPortfolioInsights(state.holdings, currency);
  const asOf = series.at(-1)?.date
    ? new Date(`${series.at(-1).date}T00:00:00.000Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : '';

  const header = pageHeader('Portfolio', 'Overview', state.holdings.length
    ? `${summary.uniqueItems} unique items · ${summary.totalQuantity} total pieces`
    : 'A clear view of what you own and what needs attention', '<button class="icon-button" type="button" data-action="refresh-prices" aria-label="Refresh prices">↻</button>');
  const sourceRefresh = refreshStatusMarkup(state.tcgcsvRefresh);

  if (!state.holdings.length) {
    return `${header}${sourceRefresh}<div class="overview-empty">${emptyState('Build your first portfolio view', 'Add one collectible to begin tracking value, cost basis, and collection mix.', '<div class="button-row centered"><button class="button" type="button" data-go="add">Add first collectible</button><button class="button ghost" type="button" data-go="search">Search cards</button></div>')}</div>${state.scanDraftCount ? `<button class="button secondary" type="button" data-action="resume-scan">Resume saved scan (${state.scanDraftCount})</button>` : ''}`;
  }

  return `${header}${sourceRefresh}
    <section class="overview-hero" aria-label="Portfolio performance">
      <article class="card overview-performance">
        <div class="overview-performance-head"><div><p class="metric-label">Estimated market value · ${escapeHTML(currency)} only</p><strong class="overview-value">${escapeHTML(formatCurrency(summary.marketValue, currency))}</strong>${movementMarkup(change, range, currency)}</div><div class="range-control" role="group" aria-label="Portfolio chart range">${OVERVIEW_RANGES.map((option) => `<button type="button" data-overview-range="${escapeAttribute(option)}" aria-pressed="${option === range}">${escapeHTML(option)}</button>`).join('')}</div></div>
        ${trendChart(series, currency)}
        <div class="overview-chart-meta"><span><strong>${coverage.percent.toFixed(0)}%</strong> pricing coverage</span>${historyCoverage.total ? `<span><strong>${historyCoverage.percent}%</strong> chart history coverage across this portfolio</span>` : ''}<span>${asOf ? `Updated ${escapeHTML(asOf)}` : 'Waiting for the first snapshot'}</span></div>
      </article>
      <aside class="overview-summary" aria-label="Portfolio summary">
        <article class="summary-stat"><span>Cost basis</span><strong>${escapeHTML(formatCurrency(summary.costBasis, currency))}</strong><small>Purchase price + fees</small></article>
        <article class="summary-stat"><span>Comparable unrealized gain or loss</span><strong class="${gainTone}"><span aria-hidden="true">${summary.gain >= 0 ? '↗' : '↘'}</span> ${escapeHTML(formatCurrency(summary.gain, currency))}</strong><small>${escapeHTML(formatPercent(summary.returnPercent))} all time${summary.excludedGainItems ? ` · ${summary.excludedGainItems} mixed-currency excluded` : ''}</small></article>
        <article class="summary-stat forecast"><span>Scenario coverage</span><strong>${escapeHTML(forecast.label)}</strong><small>${escapeHTML(forecast.detail)}</small></article>
        <article class="summary-stat"><span>Pricing sources</span><strong>${coverage.covered} of ${coverage.total}</strong><small>${coverage.market} market · ${coverage.manual} manual · ${coverage.unpriced} unpriced</small></article>
        <article class="summary-stat"><span>Value concentration</span><strong>${escapeHTML(localInsights.concentration[0].toUpperCase() + localInsights.concentration.slice(1))}</strong><small>${localInsights.topHolding ? `${escapeHTML(localInsights.topHolding.name)} is ${escapeHTML(formatPercent(localInsights.topHolding.share * 100))}` : 'Add a locally valued holding'}</small></article>
      </aside>
    </section>
    ${attentionModule(state, coverage)}
    ${summary.excludedMarketItems || summary.excludedCostItems ? `<p class="fine-print" role="status">Amounts in ${escapeHTML(summary.excludedCurrencies.join(', '))} stay in their source currency and are excluded from ${escapeHTML(currency)} totals. No exchange rate was guessed.</p>` : ''}
    <div class="overview-modules">${moversModule(state)}${recentHoldingsModule(state, currency)}${allocationModule(state, currency)}</div>`;
}
