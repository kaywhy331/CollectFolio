import { emptyState, externalImage, pageHeader } from '../core/components.js';
import { portfolioSummary } from '../core/calculations.js';
import {
  alertHistoryModels,
  confidencePresentation,
  forecastAssets,
  INSIGHTS_HORIZONS,
  INSIGHTS_VIEWS,
  performanceValueBreakdown,
  portfolioForecastSummary,
  predictionHistoryModels,
  publishedScorecards
} from '../core/insights.js';
import { localPortfolioInsights, localPortfolioScenario } from '../core/local-scenarios.js';
import { forecastProjectionChart, trendChart } from '../core/ui.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { overviewChange, overviewSeries, OVERVIEW_RANGES } from './home.js';

const VIEW_LABELS = Object.freeze({
  performance: 'Performance',
  forecasts: 'Forecasts',
  alerts: 'Alerts',
  'track-record': 'Track Record'
});

function dateLabel(value, fallback = 'Not disclosed') {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return fallback;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function insightsTabs(state, selected) {
  const unread = (state.alerts || []).filter((alert) => !alert.readAt && !alert.mutedAt).length;
  return `<div class="insights-tabs" role="tablist" aria-label="Insights sections">${INSIGHTS_VIEWS.map((view) => `<button type="button" role="tab" aria-selected="${view === selected}" class="${view === selected ? 'active' : ''}" data-insights-view="${view}">${VIEW_LABELS[view]}${view === 'alerts' && unread ? ` <span class="insights-tab-count" aria-label="${unread} unread">${unread}</span>` : ''}</button>`).join('')}</div>`;
}

export function renderInsights(state) {
  const selected = INSIGHTS_VIEWS.includes(state.insights?.view) ? state.insights.view : 'forecasts';
  const subtitles = {
    performance: 'Recorded portfolio history stays separate from every modeled future value.',
    forecasts: 'Local scenario ranges work now; published market forecasts remain a separate evidence tier.',
    alerts: 'Local notification history for exact watched variants.',
    'track-record': 'Immutable forecast receipts and approved matured-model scorecards.'
  };
  const content = selected === 'performance'
    ? performanceSection(state)
    : selected === 'alerts'
      ? alertsSection(state)
      : selected === 'track-record' ? trackRecordSection(state) : forecastsSection(state);
  return `${pageHeader('Evidence before prediction', 'Insights', subtitles[selected])}${insightsTabs(state, selected)}${content}`;
}

function performanceSection(state) {
  if (!state.holdings.length) return emptyState(
    'Performance begins with a holding',
    'Add a collectible to create local value and cost-basis snapshots. Forecasts are never inserted into this history.',
    '<button class="button" type="button" data-go="add">Add collectible</button>'
  );
  const currency = state.settings.currency || 'USD';
  const summary = portfolioSummary(state.holdings, { currency });
  const breakdown = performanceValueBreakdown(state.holdings, currency);
  const localInsights = localPortfolioInsights(state.holdings, currency);
  const range = OVERVIEW_RANGES.includes(state.overview?.range) ? state.overview.range : '3M';
  const series = overviewSeries(state.holdings, state.snapshots, range, new Date(), currency);
  const change = overviewChange(series);
  const changeMarkup = change.amount === null
    ? '<strong>Tracking began today</strong><small>No earlier local snapshot exists.</small>'
    : `<strong class="${change.amount >= 0 ? 'positive' : 'negative'}">${change.amount >= 0 ? '↗' : '↘'} ${escapeHTML(formatCurrency(Math.abs(change.amount), currency))}</strong><small>${change.percent === null ? 'Starting value was zero' : escapeHTML(formatPercent(change.percent))} over ${escapeHTML(range)}</small>`;
  return `<section class="insights-performance" aria-labelledby="performance-title">
    <div class="section-heading"><div><p class="eyebrow">Observed local history</p><h2 id="performance-title">Portfolio performance</h2><p class="muted">Recorded catalog and manual values only. Every modeled future scenario is excluded.</p></div></div>
    <div class="insights-metric-grid">
      <article><span>Recorded portfolio value</span><strong>${escapeHTML(formatCurrency(summary.marketValue, currency))}</strong><small>Market + explicit manual values</small></article>
      <article><span>Approved/catalog market values</span><strong>${escapeHTML(formatCurrency(breakdown.marketValue, currency))}</strong><small>${breakdown.marketHoldings} holding${breakdown.marketHoldings === 1 ? '' : 's'}</small></article>
      <article><span>Manual values</span><strong>${escapeHTML(formatCurrency(breakdown.manualValue, currency))}</strong><small>${breakdown.manualHoldings} holding${breakdown.manualHoldings === 1 ? '' : 's'} · used only as labeled local scenario anchors</small></article>
      <article><span>Cost basis</span><strong>${escapeHTML(formatCurrency(summary.costBasis, currency))}</strong><small>Purchase price + fees</small></article>
      <article><span>Comparable unrealized gain or loss</span><strong class="${summary.gain >= 0 ? 'positive' : 'negative'}">${escapeHTML(formatCurrency(summary.gain, currency))}</strong><small>${escapeHTML(formatPercent(summary.returnPercent))}${summary.excludedGainItems ? ` · ${summary.excludedGainItems} mixed-currency excluded` : ''}</small></article>
      <article><span>${escapeHTML(range)} movement</span>${changeMarkup}</article>
      <article><span>Largest holding share</span><strong>${localInsights.topHolding ? escapeHTML(formatPercent(localInsights.topHolding.share * 100)) : '—'}</strong><small>${localInsights.topHolding ? escapeHTML(localInsights.topHolding.name) : 'No locally valued holding'}</small></article>
      <article><span>Value concentration</span><strong>${escapeHTML(localInsights.concentration[0].toUpperCase() + localInsights.concentration.slice(1))}</strong><small>Top five represent ${escapeHTML(formatPercent(localInsights.topFiveShare * 100))} of saved local value</small></article>
    </div>
    ${summary.excludedMarketItems || summary.excludedCostItems ? `<p class="fine-print" role="status">Amounts in ${escapeHTML(summary.excludedCurrencies.join(', '))} are excluded from this ${escapeHTML(currency)} view; no exchange rate was guessed.</p>` : ''}
    <article class="card insights-history-chart"><div class="section-heading compact"><div><p class="eyebrow">Actual values</p><h3>Recorded value and cost basis</h3></div><div class="range-control" role="group" aria-label="Performance chart range">${OVERVIEW_RANGES.map((option) => `<button type="button" data-overview-range="${escapeAttribute(option)}" aria-pressed="${option === range}">${escapeHTML(option)}</button>`).join('')}</div></div>${trendChart(series, currency)}<p class="fine-print">Local snapshots reflect only values recorded in ${escapeHTML(currency)}. They are not backfilled with forecasts, exchange-rate guesses, or later market observations.</p></article>
  </section>`;
}

function intelligenceStatus(state) {
  return `${state.intelligence?.loading ? '<p class="insights-refresh" role="status">Refreshing approved publications…</p>' : ''}${state.intelligence?.error ? `<p class="insights-error" role="status">${escapeHTML(state.intelligence.error)}</p>` : ''}`;
}

function forecastsSection(state) {
  const publicEnabled = Boolean(state.featureFlags?.publicPriceIntelligence);
  const horizon = INSIGHTS_HORIZONS.includes(Number(state.insights?.horizon)) ? Number(state.insights.horizon) : 90;
  const currency = state.settings.currency || 'USD';
  const localSummary = localPortfolioScenario(state.holdings, state.localValueObservations || [], horizon, { currency });
  const summary = publicEnabled
    ? portfolioForecastSummary(state.holdings, state.intelligence?.byVariant || {}, horizon, { publicEnabled, currency })
    : null;
  const assets = publicEnabled
    ? forecastAssets(state.holdings, state.watchlistItems, state.intelligence?.byVariant || {}, horizon, { publicEnabled, currency })
    : [];
  const history = predictionHistoryModels(state.intelligence?.history || [], state.intelligence?.byVariant || {});
  const latestHistory = new Map();
  history.filter((entry) => entry.horizon === horizon).forEach((entry) => {
    if (!latestHistory.has(entry.canonicalId)) latestHistory.set(entry.canonicalId, entry);
  });
  return `${publicEnabled ? intelligenceStatus(state) : ''}<section class="forecast-workspace">
    <div class="forecast-horizon-control" role="group" aria-label="Forecast horizon">${INSIGHTS_HORIZONS.map((value) => `<button type="button" data-insights-horizon="${value}" aria-pressed="${value === horizon}">${value === 365 ? '1 year' : `${value} days`}</button>`).join('')}</div>
    ${localScenarioSummaryCard(localSummary, currency)}
    <div class="section-heading"><div><p class="eyebrow">Your saved values</p><h2>Card scenario outlooks</h2><p class="muted">Each owned holding gets a ${horizon}-day range from its own source-separated local value checks. One value is enough for a deliberately broad starting range.</p></div></div>
    ${localSummary.rows.length ? `<div class="insights-forecast-list">${localSummary.rows.map((row) => localScenarioAssetCard(row, horizon)).join('')}</div>` : emptyState('Add a holding to start', 'A current catalog value or your own estimate creates the first local scenario anchor.', '<button class="button" type="button" data-go="add">Add collectible</button>')}
    ${publicEnabled ? `${forecastSummaryCard(summary, currency)}
      <div class="section-heading"><div><p class="eyebrow">Published market evidence</p><h2>Approved forecast availability</h2><p class="muted">Published forecasts, when available, stay distinct from your local scenarios and retain their independent review gates.</p></div></div>
      ${assets.length ? `<div class="insights-forecast-list">${assets.map((asset) => forecastAssetCard(asset, state, latestHistory.get(asset.publication?.variantId), currency)).join('')}</div>` : emptyState('No published forecasts for these items', 'Local scenarios above remain available without an approved publication.', '<button class="button ghost" type="button" data-go="portfolio">Open portfolio</button>')}` : publicationGateNotice()}
  </section>`;
}

function usableLocalScenario(scenario) {
  return ['early', 'limited', 'available'].includes(scenario?.status);
}

function localScenarioSummaryCard(summary, currency) {
  const covered = summary.coveredHoldings > 0;
  const usableRows = summary.rows.filter(({ scenario }) => usableLocalScenario(scenario) && scenario.currency === currency);
  const manualCount = usableRows.filter(({ scenario }) => scenario.source === 'manual').length;
  const catalogCount = usableRows.length - manualCount;
  const sourceDetail = [manualCount ? `${manualCount} your estimate${manualCount === 1 ? '' : 's'}` : '', catalogCount ? `${catalogCount} catalog price${catalogCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  const confidenceOrder = ['Early', 'Low', 'Developing', 'Moderate'];
  const confidence = usableRows.length
    ? usableRows.map(({ scenario }) => scenario.confidence.label).sort((a, b) => confidenceOrder.indexOf(a) - confidenceOrder.indexOf(b))[0]
    : 'Unavailable';
  const projection = covered ? forecastProjectionChart(summary.currentValue, [{
    horizon: summary.horizon, q10: summary.q10, q25: summary.q25, q50: summary.q50, q75: summary.q75, q90: summary.q90
  }], currency, { mode: 'local-scenario' }) : '';
  return `<section class="card portfolio-forecast-summary local-scenario-summary" aria-labelledby="local-scenario-summary-title"><div class="section-heading"><div><p class="eyebrow">Local scenario outlook</p><h2 id="local-scenario-summary-title">${summary.horizon === 365 ? '1-year' : `${summary.horizon}-day`} portfolio range</h2><p class="muted">Available from values saved on this device. It is not a market appraisal or a published forecast.</p></div><span class="support-badge ${covered ? 'partial' : 'unsupported'}">${covered ? `${summary.coveredHoldings} modeled` : 'Needs a value'}</span></div>
    <div class="forecast-summary-values"><div class="actual"><span>Current saved value in scenario</span><strong>${covered ? escapeHTML(formatCurrency(summary.currentValue, currency)) : '—'}</strong><small>${sourceDetail || 'Add a current value to begin'}</small></div><div class="forecast"><span>Middle 50% scenario range</span><strong>${covered ? `${escapeHTML(formatCurrency(summary.q25, currency))}–${escapeHTML(formatCurrency(summary.q75, currency))}` : 'Unavailable'}</strong><small>${covered ? `Modeled midpoint ${escapeHTML(formatCurrency(summary.q50, currency))}` : 'No value anchors in this currency'}</small></div><div class="forecast"><span>Broad 80% scenario range</span><strong>${covered ? `${escapeHTML(formatCurrency(summary.q10, currency))}–${escapeHTML(formatCurrency(summary.q90, currency))}` : 'Unavailable'}</strong><small>Uncertainty is intentionally wide with short local histories</small></div></div>
    ${projection}<dl class="forecast-summary-meta"><div><dt>Confidence</dt><dd>${escapeHTML(confidence)}<small>Qualitative disclosure, not an accuracy percentage</small></dd></div><div><dt>Coverage</dt><dd>${summary.coveredHoldings} of ${summary.totalHoldings} holdings<small>${summary.excludedCurrencyHoldings ? `${summary.excludedCurrencyHoldings} other-currency excluded` : 'No exchange rate guessed'}</small></dd></div></dl>
    <p class="forecast-warning">Modeled scenario only. It never changes current portfolio value and does not claim a future sale price.</p></section>`;
}

function localScenarioAssetCard({ holding, scenario }, horizon) {
  const name = holding.item?.name || 'Unnamed holding';
  const identity = [holding.item?.setName, holding.item?.number, holding.item?.finish || holding.item?.variant].filter(Boolean).join(' · ');
  const detail = `<button class="button ghost small" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}">Open card detail</button>`;
  if (!usableLocalScenario(scenario)) {
    return `<article class="card forecast-availability-card unavailable"><div class="forecast-asset-head">${externalImage(holding.item, 'forecast-product-image')}<div><p class="eyebrow">Owned holding · Local scenario</p><h3>${escapeHTML(name)}</h3><p class="item-meta">${escapeHTML(identity || 'Saved collectible')}</p></div><span class="support-badge unsupported">${scenario.status === 'stale' ? 'Value stale' : 'Needs a value'}</span></div><p class="availability-reason">${escapeHTML(scenario.reason || 'No usable local value is saved.')}</p><p class="muted">${escapeHTML(scenario.nextAction || 'Edit the holding and add a current value.')}</p><div class="item-actions">${detail}</div></article>`;
  }
  const history = (scenario.history || []).filter((entry) => entry.source === scenario.source && entry.currency === scenario.currency);
  const projection = forecastProjectionChart(scenario.observed, [scenario], scenario.currency, {
    mode: 'local-scenario', history, asOfDate: scenario.observedAt
  });
  return `<article class="card forecast-availability-card local-scenario-card ${scenario.status}"><div class="forecast-asset-head">${externalImage(holding.item, 'forecast-product-image')}<div><p class="eyebrow">Owned holding · Local scenario</p><h3>${escapeHTML(name)}</h3><p class="item-meta">${escapeHTML(identity || 'Saved collectible')}</p></div><span class="support-badge partial">${escapeHTML(scenario.confidence.label)} confidence</span></div>
    <div class="actual-forecast-split"><div class="actual"><span>Saved unit value</span><strong>${escapeHTML(formatCurrency(scenario.observed, scenario.currency))}</strong><small>${escapeHTML(scenario.source === 'manual' ? 'Your estimate' : scenario.sourceLabel || 'Catalog price')} · value date ${escapeHTML(dateLabel(scenario.valueAsOf || scenario.observedAt))}</small></div><div class="forecast"><span>${horizon}-day local scenario</span><strong>${escapeHTML(formatCurrency(scenario.q25, scenario.currency))}–${escapeHTML(formatCurrency(scenario.q75, scenario.currency))}</strong><small>Middle 50% · midpoint ${escapeHTML(formatCurrency(scenario.q50, scenario.currency))}</small></div></div>${projection}
    <dl class="forecast-explanation"><div><dt>Confidence</dt><dd>${escapeHTML(scenario.confidence.label)}<small>${escapeHTML(scenario.confidence.detail)}</small></dd></div><div><dt>Local history</dt><dd>${scenario.observationCount} same-source check${scenario.observationCount === 1 ? '' : 's'}<small>Manual and catalog series never create cross-source returns</small></dd></div><div><dt>Broad range</dt><dd>${escapeHTML(formatCurrency(scenario.q10, scenario.currency))}–${escapeHTML(formatCurrency(scenario.q90, scenario.currency))}<small>80% modeled scenario range</small></dd></div><div><dt>Model</dt><dd>${escapeHTML(scenario.modelVersion)}<small>${scenario.excludedChangeCount ? `${scenario.excludedChangeCount} extreme change excluded` : 'No extreme changes entered the model'}</small></dd></div></dl>
    <p class="forecast-warning">Your local scenario is not a market observation, appraisal, investment recommendation, or guaranteed return.</p><div class="item-actions">${detail}</div></article>`;
}

function publicationGateNotice() {
  return `<section class="card intelligence-gate publication-gate" role="status"><span class="support-badge restricted">Research gate active</span><h2>Published market forecasts remain gated</h2><p>The local scenarios above do not wait for an approved source. Separately, public market forecasts remain hidden until their source-rights, exact-mapping, validation, feature-flag, and operator-review gates pass.</p><ul class="evidence-list"><li>Local ranges are labeled modeled scenarios from your saved values.</li><li>They never become measured Track Record outcomes.</li><li>No private research output is presented as public market guidance.</li></ul></section>`;
}

function forecastSummaryCard(summary, currency) {
  const covered = summary.coveredHoldings > 0;
  const asOf = summary.asOfDate ? dateLabel(summary.asOfDate) : 'No approved forecast';
  const modelUpdate = summary.modelUpdateDate ? dateLabel(summary.modelUpdateDate) : 'Not disclosed';
  return `<section class="card portfolio-forecast-summary" aria-labelledby="forecast-summary-title"><div class="section-heading"><div><p class="eyebrow">Portfolio forecast summary</p><h2 id="forecast-summary-title">${summary.horizon === 365 ? '1-year' : `${summary.horizon}-day`} outlook</h2></div><span class="support-badge ${covered ? 'supported' : 'unsupported'}">${covered ? `${summary.coveredHoldings} covered` : 'Unavailable'}</span></div>
    <div class="forecast-summary-values">
      <div class="actual"><span>Current recorded portfolio value</span><strong>${escapeHTML(formatCurrency(summary.currentPortfolioValue, currency))}</strong><small>Actual market + manual values; no forecast included</small></div>
      <div class="actual"><span>Approved current value in forecast</span><strong>${covered ? escapeHTML(formatCurrency(summary.approvedCurrentValue, currency)) : '—'}</strong><small>Covered holdings only</small></div>
      <div class="forecast"><span>${summary.horizon === 365 ? '1-year' : `${summary.horizon}-day`} likely modeled range</span><strong>${covered ? `${escapeHTML(formatCurrency(summary.lowerBound, currency))}–${escapeHTML(formatCurrency(summary.upperBound, currency))}` : 'Unavailable'}</strong><small>${covered ? `Modeled midpoint ${escapeHTML(formatCurrency(summary.expectedValue, currency))}` : 'No eligible holdings at this horizon'}</small></div>
    </div>
    <dl class="forecast-summary-meta">
      <div><dt>Confidence</dt><dd>${escapeHTML(summary.confidenceLabel)}<small>${escapeHTML(summary.confidenceReason)}</small></dd></div>
      <div><dt>Coverage</dt><dd>${summary.coveredHoldings} of ${summary.totalHoldings} holdings<small>${summary.limitedHoldings ? `${summary.limitedHoldings} explicitly limited` : 'Only approved exact-item forecasts count'}</small></dd></div>
      <div><dt>Oldest included as-of date</dt><dd>${escapeHTML(asOf)}<small>Conservative freshness boundary</small></dd></div>
      <div><dt>Latest model publication</dt><dd>${escapeHTML(modelUpdate)}<small>Not inferred as a training date</small></dd></div>
    </dl>
    <p class="forecast-warning">Forecast ranges are model outputs, not appraisals or guaranteed returns. They are never added to current portfolio value.</p></section>`;
}

function forecastAssetCard(asset, state, history, fallbackCurrency) {
  const name = asset.item?.name || 'Unnamed exact item';
  const identity = [asset.item?.setName, asset.item?.number, asset.item?.finish || asset.item?.variant].filter(Boolean).join(' · ');
  const detail = asset.holdingId
    ? `<button class="button ghost small" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(asset.holdingId)}">Open card detail</button>`
    : asset.watchKey ? `<button class="button ghost small" type="button" data-action="open-detail" data-watch-key="${escapeAttribute(asset.watchKey)}">Open card detail</button>` : '';
  if (!asset.forecast || !asset.publication) {
    return `<article class="card forecast-availability-card unavailable"><div class="forecast-asset-head">${externalImage(asset.item, 'forecast-product-image')}<div><p class="eyebrow">${escapeHTML(asset.context)}</p><h3>${escapeHTML(name)}</h3><p class="item-meta">${escapeHTML(identity || 'Exact identity details unavailable')}</p></div><span class="support-badge unsupported">Unavailable</span></div><p class="availability-reason">${escapeHTML(asset.reason)}</p><p class="muted">${escapeHTML(asset.nextAction)}</p>${asset.availableHorizons?.length ? `<p class="fine-print">Approved horizons: ${asset.availableHorizons.map((value) => `${value} days`).join(', ')}</p>` : ''}<div class="item-actions">${detail}</div></article>`;
  }
  const publication = asset.publication;
  const forecast = asset.forecast;
  const currency = publication.observed?.currency || fallbackCurrency;
  const confidence = confidencePresentation(forecast, publication);
  const ribbon = forecastProjectionChart(publication.observed?.price, Object.values(publication.forecasts), currency, {
    history: publication.history,
    asOfDate: publication.publishedAt || publication.observed?.observedAt
  }) || '<div class="empty-chart">An approved current observation is required before this forecast can be drawn.</div>';
  const drivers = publication.drivers.supporting.length
    ? `<div><h4>Positive drivers</h4><ul class="evidence-list">${publication.drivers.supporting.map((entry) => `<li>${escapeHTML(entry)}</li>`).join('')}</ul></div>` : '';
  const risks = publication.drivers.limiting.length
    ? `<div><h4>Risks and limitations</h4><ul class="evidence-list">${publication.drivers.limiting.map((entry) => `<li>${escapeHTML(entry)}</li>`).join('')}</ul></div>` : '';
  const sources = publication.sourceAttributions.map((entry) => entry.attribution || entry.name).filter(Boolean);
  const observedDate = publication.observed?.observedAt || publication.publishedAt;
  return `<article class="card forecast-availability-card ${asset.status}"><div class="forecast-asset-head">${externalImage(asset.item, 'forecast-product-image')}<div><p class="eyebrow">${escapeHTML(asset.context)} · Approved outlook</p><h3>${escapeHTML(name)}</h3><p class="item-meta">${escapeHTML(identity || 'Exact mapped variant')}</p></div><span class="support-badge ${asset.status === 'limited' ? 'partial' : 'supported'}">${asset.status === 'limited' ? 'Limited' : 'Available'}</span></div>
    <div class="actual-forecast-split"><div class="actual"><span>Current market observation</span><strong>${publication.observed ? escapeHTML(formatCurrency(publication.observed.price, currency)) : 'Unavailable'}</strong><small>${escapeHTML(publication.observed?.source || 'Approved source not disclosed')} · ${escapeHTML(dateLabel(observedDate))}</small></div><div class="forecast"><span>${forecast.horizon}-day modeled likely range</span><strong>${escapeHTML(formatCurrency(forecast.q25, currency))}–${escapeHTML(formatCurrency(forecast.q75, currency))}</strong><small>Median ${escapeHTML(formatCurrency(forecast.q50, currency))} · matures ${escapeHTML(dateLabel(forecast.maturesAt))}</small></div></div>
    ${ribbon}
    <dl class="forecast-explanation">
      <div><dt>Confidence</dt><dd>${escapeHTML(confidence.label)}<small>${escapeHTML(confidence.reason)}</small></dd></div>
      <div><dt>Forecast coverage</dt><dd>${escapeHTML(forecast.coverageStatus || `${asset.quantity} ${asset.context === 'Owned holding' ? 'owned item' : 'watched variant'}`)}<small>${asset.context === 'Owned holding' ? 'Quantity is reflected only in the portfolio summary.' : 'Not included in portfolio totals.'}</small></dd></div>
      <div><dt>Probability of gain</dt><dd>${forecast.probabilityUp === null ? 'Not disclosed' : `${Math.round(forecast.probabilityUp * 100)}%`}<small>Published model probability, not a guaranteed return</small></dd></div>
      <div><dt>Data freshness</dt><dd>${escapeHTML(forecast.dataFreshness || dateLabel(observedDate))}<small>Approved observation or publication date</small></dd></div>
      <div><dt>What changed</dt><dd>${escapeHTML(forecast.whatChanged || history?.whatChanged || 'No previous archived forecast is available.')}<small>${history?.previousForecastId ? 'Traceable to the prior local publication receipt.' : 'This is the first local receipt for this horizon.'}</small></dd></div>
    </dl>
    ${drivers || risks ? `<div class="forecast-drivers">${drivers}${risks}</div>` : '<p class="muted">No driver or risk explanation was included in this approved publication.</p>'}
    <details class="forecast-advanced"><summary>Model and data details</summary><dl><div><dt>As-of date</dt><dd>${escapeHTML(dateLabel(publication.publishedAt))}</dd></div><div><dt>Model update date</dt><dd>${escapeHTML(dateLabel(forecast.modelUpdatedAt, 'Not disclosed'))}</dd></div><div><dt>Model version</dt><dd>${escapeHTML(forecast.modelVersion || 'Not disclosed')}</dd></div><div><dt>Full modeled range</dt><dd>${escapeHTML(formatCurrency(forecast.q10, currency))}–${escapeHTML(formatCurrency(forecast.q90, currency))}</dd></div><div><dt>Sources</dt><dd>${sources.length ? sources.map(escapeHTML).join(' · ') : 'Not disclosed'}</dd></div></dl></details>
    <p class="forecast-warning">Modeled range, not a promise of future value.</p><div class="item-actions">${detail}</div></article>`;
}

function alertsSection(state) {
  const filter = ['all', 'unread', 'muted'].includes(state.insights?.alertFilter) ? state.insights.alertFilter : 'all';
  const all = alertHistoryModels(state.alerts || [], state.watchlistItems || [], 'all');
  const alerts = alertHistoryModels(state.alerts || [], state.watchlistItems || [], filter);
  const unread = all.filter((alert) => alert.unread && !alert.muted).length;
  const muted = all.filter((alert) => alert.muted).length;
  return `<section class="alerts-workspace" aria-labelledby="alerts-title"><div class="alerts-summary"><div><p class="eyebrow">Local notification history</p><h2 id="alerts-title">Alerts</h2><p>${all.length} recorded · ${unread} unread · ${muted} muted</p></div>${unread ? '<button class="button ghost small" type="button" data-action="mark-all-alerts-read">Mark all read</button>' : ''}</div>
    <div class="alert-filter" role="group" aria-label="Filter alert history">${[['all', 'All'], ['unread', 'Unread'], ['muted', 'Muted']].map(([value, label]) => `<button type="button" data-alert-filter="${value}" aria-pressed="${filter === value}">${label}</button>`).join('')}</div>
    ${alerts.length ? `<div class="alert-history-list">${alerts.map(alertCard).join('')}</div>` : all.length ? emptyState('No alerts match this filter', 'Choose another history filter to review saved notifications.', '<button class="button ghost" type="button" data-alert-filter="all">Show all alerts</button>') : emptyState('No alert history yet', 'Set a target or movement rule on an exact Watchlist item. Alerts are created only from approved market changes.', '<button class="button" type="button" data-go="portfolio" data-portfolio-target="watchlist">Open Watchlist</button>')}
  </section>`;
}

function alertCard(alert) {
  const label = alert.kind === 'forecast_change' ? 'Model-based forecast change' : String(alert.kind || 'market alert').replaceAll('_', ' ');
  const name = alert.item?.name || 'Exact watched variant';
  return `<article class="alert-history-card ${alert.unread ? 'unread' : 'read'} ${alert.muted ? 'muted' : ''}"><div class="alert-state"><span>${alert.unread ? 'Unread' : 'Read'}</span>${alert.muted ? '<span>Muted</span>' : ''}${alert.system ? '<span>System</span>' : '<span>Market</span>'}</div><div><p class="eyebrow">${escapeHTML(label)}</p><h3>${escapeHTML(name)}</h3><p>${escapeHTML(alert.message || 'A configured alert condition changed.')}</p><small>${escapeHTML(dateLabel(alert.triggeredAt))}${alert.variantId ? ` · exact variant ${escapeHTML(alert.variantId)}` : ''}</small>${alert.kind === 'forecast_change' ? '<p class="fine-print">This notification describes a model output change, not an observed price movement.</p>' : ''}</div><div class="item-actions">${alert.watched ? `<button class="button ghost small" type="button" data-action="open-detail" data-watch-key="${escapeAttribute(alert.watchKey)}">Open card</button><button class="button ghost small" type="button" data-action="edit-watch" data-watch-key="${escapeAttribute(alert.watchKey)}">Edit rule</button>` : ''}<button class="button ghost small" type="button" data-action="${alert.unread ? 'mark-alert-read' : 'mark-alert-unread'}" data-id="${escapeAttribute(alert.id)}">Mark ${alert.unread ? 'read' : 'unread'}</button><button class="button ghost small" type="button" data-action="toggle-alert-mute" data-id="${escapeAttribute(alert.id)}">${alert.muted ? 'Unmute notification' : 'Mute notification'}</button></div></article>`;
}

function trackRecordSection(state) {
  if (!state.featureFlags?.publicPriceIntelligence) return `<section class="card intelligence-gate" role="status"><span class="support-badge restricted">Publication gate active</span><h2>Track Record is unavailable</h2><p>Prediction history and accuracy claims remain hidden while public forecasting is disabled. Private research ledgers are never exposed through this screen.</p></section>`;
  const scorecards = publishedScorecards(state.intelligence?.byVariant || {});
  const history = predictionHistoryModels(state.intelligence?.history || [], state.intelligence?.byVariant || {});
  return `${intelligenceStatus(state)}<section class="track-record-workspace" aria-labelledby="track-record-title"><div class="section-heading"><div><p class="eyebrow">Accountable model output</p><h2 id="track-record-title">Prediction Track Record</h2><p class="muted">Open forecasts stay out of accuracy metrics. Matured records are never rewritten, and this client displays only approved evaluations.</p></div></div>
    ${scorecards.length ? `<div class="scorecard-list">${scorecards.map(scorecardCard).join('')}</div>` : '<section class="card scorecard-unavailable" role="status"><h3>Accuracy metrics are not published yet</h3><p>No fully evaluated scorecard with the approved minimum sample is available. Percentages remain hidden instead of being calculated from open or incomplete local records.</p></section>'}
    <div class="section-heading"><div><p class="eyebrow">Append-only local receipts</p><h2>Forecast history</h2><p class="muted">Approved public snapshots are archived under immutable keys during refresh. Importable backups remain user-owned.</p></div></div>
    ${history.length ? `<div class="prediction-history-list">${history.map((entry) => historyCard(entry, state)).join('')}</div>` : emptyState('No forecast receipts archived', 'An immutable receipt appears after an approved public forecast is loaded for an owned or watched exact variant.', '<button class="button" type="button" data-go="portfolio" data-portfolio-target="watchlist">Open Watchlist</button>')}
    <p class="fine-print">Local forecast receipts do not create accuracy claims. Only complete, approved scorecards built from matured evaluations can publish aggregate metrics.</p></section>`;
}

function scorecardCard(scorecard) {
  return `<article class="card model-scorecard"><div class="section-heading compact"><div><p class="eyebrow">${scorecard.horizonDays}-day · ${escapeHTML(scorecard.cohort)}</p><h3>Approved model scorecard</h3></div><span class="support-badge supported">${scorecard.maturedForecasts} matured</span></div><dl class="scorecard-metrics"><div><dt>Median absolute error</dt><dd>${escapeHTML(formatPercent(scorecard.medianAbsoluteErrorPct))}</dd></div><div><dt>Directional accuracy</dt><dd>${escapeHTML(formatPercent(scorecard.directionAccuracy * 100))}</dd></div><div><dt>80% interval coverage</dt><dd>${escapeHTML(formatPercent(scorecard.interval80Coverage * 100))}</dd></div><div><dt>No-change baseline error</dt><dd>${escapeHTML(formatPercent(scorecard.baselineErrorPct))}</dd></div></dl><p class="fine-print">Model ${escapeHTML(scorecard.modelVersion)} · published ${escapeHTML(dateLabel(scorecard.publishedAt))}${scorecard.lastTrained ? ` · trained ${escapeHTML(dateLabel(scorecard.lastTrained))}` : ''}. Held-out or prospective matured outcomes only.</p></article>`;
}

function historyCard(entry, state) {
  const holding = state.holdings.find((candidate) => String(candidate.canonicalVariantId || '').toLowerCase() === String(entry.canonicalId).toLowerCase());
  const watched = state.watchlistItems.find((candidate) => String(candidate.canonicalVariantId || '').toLowerCase() === String(entry.canonicalId).toLowerCase());
  const item = holding?.item || watched?.catalogRef || {};
  const status = entry.status === 'matured' ? 'Matured and evaluated' : entry.status === 'awaiting-evaluation' ? 'Matured · awaiting approved outcome' : 'Open · not included in metrics';
  const action = holding
    ? `<button class="button ghost small" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}">Open card</button>`
    : watched ? `<button class="button ghost small" type="button" data-action="open-detail" data-watch-key="${escapeAttribute(watched.watchKey)}">Open card</button>` : '';
  return `<article class="prediction-history-card"><div><p class="eyebrow">${entry.horizon}-day forecast · ${escapeHTML(status)}</p><h3>${escapeHTML(item.name || entry.canonicalId)}</h3><p>${escapeHTML(formatCurrency(entry.lowerBound, entry.currency))}–${escapeHTML(formatCurrency(entry.upperBound, entry.currency))} likely range · ${escapeHTML(formatCurrency(entry.expectedValue, entry.currency))} midpoint</p><small>Created ${escapeHTML(dateLabel(entry.asOfDate))} · matures ${escapeHTML(dateLabel(entry.maturityDate))}</small></div><dl><div><dt>Previous record</dt><dd>${entry.previousForecastId ? 'Linked' : 'First local receipt'}</dd></div><div><dt>What changed</dt><dd>${escapeHTML(entry.whatChanged)}</dd></div>${entry.status === 'matured' ? `<div><dt>Actual at maturity</dt><dd>${escapeHTML(formatCurrency(entry.actualValueAtMaturity, entry.currency))}</dd></div><div><dt>Absolute error</dt><dd>${escapeHTML(formatCurrency(entry.absoluteError, entry.currency))}</dd></div><div><dt>Direction result</dt><dd>${escapeHTML(entry.directionResult)}</dd></div>` : ''}</dl><details><summary>Immutable record details</summary><p class="fine-print">Forecast ID ${escapeHTML(entry.forecastId)} · model ${escapeHTML(entry.modelVersion || 'not disclosed')}${entry.previousForecastId ? ` · previous ${escapeHTML(entry.previousForecastId)}` : ''}</p></details><div class="item-actions">${action}</div></article>`;
}
