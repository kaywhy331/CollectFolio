import { emptyState, externalImage, pageHeader } from '../core/components.js';
import {
  alertHistoryModels,
  forecastAssets,
  INSIGHTS_HORIZONS,
  INSIGHTS_VIEWS,
  portfolioForecastSummary,
  predictionHistoryModels,
  publishedScorecards
} from '../core/insights.js';
import { localPortfolioInsights } from '../core/local-scenarios.js';
import { buildCollectionScenario, SCENARIO_SORTS, sortScenarioRows } from '../core/scenario-lab.js';
import { collectionFreshness } from '../core/data-freshness.js';
import { methodologyDisclosure } from '../core/methodology.js';
import { forecastProjectionChart } from '../core/ui.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { CLARIFIERS } from '../core/copy.js';
import { portfolioMovers, pricingCoverage } from './home.js';

const VIEW_LABELS = Object.freeze({
  performance: 'Overview',
  forecasts: 'Scenario Lab',
  alerts: 'Alerts',
  'track-record': 'Track Record'
});

// LEX sweep: "Not disclosed" is an Appendix-C banned phrase outside Data &
// Methodology; this fallback matches portfolio.js's readableDate wording.
function dateLabel(value, fallback = 'Date unavailable') {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return fallback;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function horizonLabel(value, { adjective = false } = {}) {
  const labels = { 7: ['7 days', '7-day'], 30: ['30 days', '30-day'], 90: ['90 days', '90-day'], 180: ['6 months', '6-month'], 365: ['1 year', '1-year'] };
  return (labels[Number(value)] || [`${value} days`, `${value}-day`])[adjective ? 1 : 0];
}

function insightsTabs(state, selected) {
  const unread = (state.alerts || []).filter((alert) => !alert.readAt && !alert.mutedAt).length;
  return `<div class="insights-tabs" role="tablist" aria-label="Insights sections">${INSIGHTS_VIEWS.map((view) => `<button type="button" role="tab" aria-selected="${view === selected}" class="${view === selected ? 'active' : ''}" data-insights-view="${view}">${VIEW_LABELS[view]}${view === 'alerts' && unread ? ` <span class="insights-tab-count" aria-label="${unread} unread">${unread}</span>` : ''}</button>`).join('')}</div>`;
}

export function renderInsights(state) {
  const selected = INSIGHTS_VIEWS.includes(state.insights?.view) ? state.insights.view : 'performance';
  const subtitles = {
    performance: 'Understand changes, gaps, and risks across your collection.',
    forecasts: 'Explore how your collection could change under different assumptions.',
    alerts: 'Local notification history for exact watched variants.',
    'track-record': 'How published forecasts are scored against outcomes.'
  };
  const content = selected === 'performance'
    ? overviewSection(state)
    : selected === 'alerts'
      ? alertsSection(state)
      : selected === 'track-record' ? trackRecordSection(state) : forecastsSection(state);
  // DCL-LEX-11: the Methodology disclosure is reachable from Insights,
  // once, regardless of which tab is active.
  // DCL-LEX-06/RULE-7: eyebrow sweep -- "Evidence before prediction" is
  // gone (Appendix A: eyebrow -> "Insights").
  return `${pageHeader('Insights', 'Insights', subtitles[selected])}${insightsTabs(state, selected)}${content}${methodologyDisclosure()}`;
}

function insightRow({ eyebrow, title, value, detail, action = '' }) {
  return `<article class="insight-row"><div><p class="eyebrow">${escapeHTML(eyebrow)}</p><h3>${escapeHTML(title)}</h3><p>${escapeHTML(detail)}</p></div><strong>${escapeHTML(value)}</strong>${action}</article>`;
}

function overviewSection(state) {
  if (!state.holdings.length) return emptyState(
    'Insights begin with your collection',
    'Scan or add an exact item to reveal value changes, concentration, missing prices, and alerts.',
    '<button class="button" type="button" data-go="add">Scan an item</button>'
  );
  const currency = state.settings.currency || 'USD';
  const localInsights = localPortfolioInsights(state.holdings, currency);
  const movers = portfolioMovers(state.holdings, state.intelligence?.byVariant || {}, Number.MAX_SAFE_INTEGER);
  const increase = movers.filter(({ intelligence }) => intelligence.trend.return30d > 0).sort((a, b) => b.intelligence.trend.return30d - a.intelligence.trend.return30d)[0];
  const decrease = movers.filter(({ intelligence }) => intelligence.trend.return30d < 0).sort((a, b) => a.intelligence.trend.return30d - b.intelligence.trend.return30d)[0];
  const coverage = pricingCoverage(state.holdings, state.intelligence?.byVariant || {});
  const freshness = collectionFreshness(state.holdings);
  const unread = (state.alerts || []).filter((alert) => !alert.readAt && !alert.mutedAt).length;
  const detailAction = (holding) => holding ? `<button class="button ghost small" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}">Review item</button>` : '';
  // DCL-INS-01/RULE-2: a row renders only when its supporting data exists
  // -- no permanent "Unavailable"/"None" placeholder variants. The two
  // rows that both reported the unpriced count are merged into one, and
  // "Recently completed sets" (which could only ever say "Unavailable")
  // is gone.
  const rows = [
    increase ? insightRow({ eyebrow: 'Largest value increase', title: increase.holding.item?.name || 'Unnamed item', value: `+${formatPercent(increase.intelligence.trend.return30d * 100)}`, detail: 'Largest approved 30-day increase in your collection.', action: detailAction(increase.holding) }) : '',
    decrease ? insightRow({ eyebrow: 'Largest value decrease', title: decrease.holding.item?.name || 'Unnamed item', value: formatPercent(decrease.intelligence.trend.return30d * 100), detail: 'Largest approved 30-day decrease in your collection.', action: detailAction(decrease.holding) }) : '',
    localInsights.topHolding ? insightRow({ eyebrow: 'Highest concentration', title: localInsights.topHolding.name, value: formatPercent(localInsights.topHolding.share * 100), detail: `${localInsights.concentration} concentration; top five represent ${formatPercent(localInsights.topFiveShare * 100)}.`, action: '<button class="button ghost small" type="button" data-go="portfolio">Open Collection</button>' }) : '',
    // DCL-NAV-03: the deep-link filter (pricing=unpriced) is applied by
    // app.js when a data-go CTA also carries data-portfolio-pricing, so
    // the filter chip is visible on arrival at Collection.
    insightRow({ eyebrow: 'Missing prices', title: coverage.unpriced ? `${coverage.unpriced} item${coverage.unpriced === 1 ? '' : 's'} need a value` : 'Every item is priced', value: `${coverage.percent.toFixed(0)}% covered`, detail: coverage.unpriced ? 'Add a manual value or review an exact catalog match.' : 'Market and explicit manual values cover the full collection.', action: '<button class="button ghost small" type="button" data-go="portfolio" data-portfolio-pricing="unpriced">Resolve pricing</button>' }),
    freshness.known ? insightRow({ eyebrow: 'Stale prices', title: freshness.stale ? `${freshness.stale} may be stale` : 'No known stale prices', value: freshness.latest.label, detail: `${freshness.known} market-price update time${freshness.known === 1 ? '' : 's'} checked.`, action: '<button class="button ghost small" type="button" data-action="refresh-prices">Refresh prices</button>' }) : '',
    insightRow({ eyebrow: 'Watchlist alerts', title: unread ? `${unread} unread alert${unread === 1 ? '' : 's'}` : 'No unread alerts', value: unread ? 'Review' : 'Clear', detail: unread ? 'Review the exact watched items whose saved rules were triggered.' : 'No active Watchlist rule needs attention.', action: '<button class="button ghost small" type="button" data-insights-view="alerts">Open Alerts</button>' })
  ].filter(Boolean);
  // DCL-LEX-06/RULE-7: "Actionable collection signals" removed for a
  // plain 1-word wayfinding eyebrow.
  return `<section class="insights-overview" aria-labelledby="insights-overview-title"><div class="section-heading"><div><p class="eyebrow">Collection</p><h2 id="insights-overview-title">Overview</h2></div></div><div class="insight-row-list">${rows.join('')}</div></section>`;
}

function intelligenceStatus(state) {
  return `${state.intelligence?.loading ? '<p class="insights-refresh" role="status">Refreshing approved publications…</p>' : ''}${state.intelligence?.error ? `<p class="insights-error" role="status">${escapeHTML(state.intelligence.error)}</p>` : ''}`;
}

function forecastsSection(state) {
  const publicEnabled = Boolean(state.featureFlags?.publicPriceIntelligence);
  const horizon = INSIGHTS_HORIZONS.includes(Number(state.insights?.horizon)) ? Number(state.insights.horizon) : 90;
  const currency = state.settings.currency || 'USD';
  const scenario = buildCollectionScenario(state.holdings, state.localValueObservations || [], horizon, {
    currency, assumptions: state.insights?.scenarioAssumptions
  });
  const sort = SCENARIO_SORTS.includes(state.insights?.scenarioSort) ? state.insights.scenarioSort : 'upside';
  const rows = sortScenarioRows(scenario.rows, sort);
  const publishedSummary = publicEnabled
    ? portfolioForecastSummary(state.holdings, state.intelligence?.byVariant || {}, horizon, { publicEnabled, currency })
    : null;
  const publishedAssets = publicEnabled
    ? forecastAssets(state.holdings, state.watchlistItems, state.intelligence?.byVariant || {}, horizon, { publicEnabled, currency })
      .filter((asset) => asset.forecast && asset.publication)
    : [];
  const assumptions = scenario.assumptions;
  const categories = [...new Map(state.holdings.map((holding) => [holding.item?.category, holding.item?.game || holding.item?.category]).filter(([key]) => key)).entries()]
    .sort((left, right) => String(left[1]).localeCompare(String(right[1])));
  const directionOptions = (selected) => [['down', 'Down'], ['unchanged', 'Unchanged'], ['up', 'Up']]
    .map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
  // DCL-INS-05: humanized, one-line current-assumption summary for the
  // collapsed control's <summary> -- omits category/item entirely when no
  // override is selected instead of ever printing raw "none".
  const categoryLabel = assumptions.category ? (categories.find(([value]) => value === assumptions.category)?.[1] || assumptions.category) : '';
  const itemName = assumptions.itemId ? (state.holdings.find((holding) => holding.id === assumptions.itemId)?.item?.name || '') : '';
  const assumptionSummary = [
    `Market ${assumptions.marketDirection}`,
    categoryLabel ? `${categoryLabel} ${assumptions.categoryDirection}` : '',
    itemName ? `${itemName} ${assumptions.itemDirection}` : '',
    `${assumptions.volatility} volatility`
  ].filter(Boolean).join(' · ');
  return `${publicEnabled ? intelligenceStatus(state) : ''}<section class="scenario-lab" aria-labelledby="scenario-lab-title">
    <div class="section-heading"><div><p class="eyebrow">Collection</p><h2 id="scenario-lab-title">Scenario Lab</h2><p class="muted">Explore how your collection could change under different assumptions.</p></div></div>
    <div class="forecast-horizon-control" role="group" aria-label="Scenario horizon">${INSIGHTS_HORIZONS.map((value) => `<button type="button" data-insights-horizon="${value}" aria-pressed="${value === horizon}">${horizonLabel(value)}</button>`).join('')}</div>
    ${scenarioSummaryCard(scenario)}
    <details class="scenario-assumptions"><summary><span>Adjust assumptions</span><span>${escapeHTML(assumptionSummary)}</span></summary>
    <form class="scenario-controls" aria-label="Scenario assumptions">
      <label>Broad market direction<select data-scenario-assumption="marketDirection">${directionOptions(assumptions.marketDirection)}</select></label>
      <label>Category<select data-scenario-assumption="category"><option value="">Choose category</option>${categories.map(([value, label]) => `<option value="${escapeAttribute(value)}" ${assumptions.category === value ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('')}</select></label>
      <label>Category direction<select data-scenario-assumption="categoryDirection">${directionOptions(assumptions.categoryDirection)}</select></label>
      <label>Volatility<select data-scenario-assumption="volatility">${[['low', 'Low'], ['typical', 'Typical'], ['high', 'High']].map(([value, label]) => `<option value="${value}" ${assumptions.volatility === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>Individual item<select data-scenario-assumption="itemId"><option value="">No item override</option>${state.holdings.map((holding) => `<option value="${escapeAttribute(holding.id)}" ${assumptions.itemId === holding.id ? 'selected' : ''}>${escapeHTML(holding.item?.name || 'Unnamed item')}</option>`).join('')}</select></label>
      <label>Item direction<select data-scenario-assumption="itemDirection">${directionOptions(assumptions.itemDirection)}</select></label>
      <label>Manual-value assumptions<select data-scenario-assumption="manualValues"><option value="steady" ${assumptions.manualValues === 'steady' ? 'selected' : ''}>Hold manual values steady</option><option value="follow" ${assumptions.manualValues === 'follow' ? 'selected' : ''}>Apply selected directions</option></select></label>
    </form>
    </details>
    <p class="scenario-disclosure" role="note">${escapeHTML(CLARIFIERS.scenario)}</p>
    <div class="scenario-outlook-heading"><div><p class="eyebrow">Item outlooks</p><h3>Compare scenario effects</h3></div><label>Sort rows<select data-scenario-sort>${[['upside', 'Largest upside'], ['downside', 'Largest downside'], ['uncertainty', 'Widest uncertainty'], ['evidence', 'Strongest evidence'], ['value', 'Highest value']].map(([value, label]) => `<option value="${value}" ${sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
    ${rows.length ? `<div class="scenario-item-list">${rows.map((row) => scenarioItemRow(row, state.insights?.expandedScenarioId === row.holding.id)).join('')}</div>` : emptyState('No valued items to model', 'Add an accepted market value or explicit manual value. Unpriced and other-currency items stay excluded.', '<button class="button" type="button" data-go="portfolio">Review Collection</button>')}
    ${scenarioMethodology(scenario)}
    ${publishedAssets.length ? publishedForecastsSection(publishedSummary, publishedAssets, state, currency) : publicEnabled ? '' : publicationGateNotice()}
  </section>`;
}

function scenarioSummaryCard(scenario) {
  if (!scenario.coveredHoldings) return '<section class="card scenario-summary" role="status"><h3>Scenario unavailable</h3><p>Add at least one accepted current value in the selected currency to calculate a scenario.</p></section>';
  const difference = scenario.neutral
    ? '<strong>Unchanged scenario</strong><small>Current value and median are the same under these assumptions.</small>'
    : `<strong class="${scenario.difference >= 0 ? 'positive' : 'negative'}">${scenario.difference >= 0 ? '+' : '−'}${escapeHTML(formatCurrency(Math.abs(scenario.difference), scenario.currency))}</strong><small>${escapeHTML(formatPercent(scenario.differencePercent))} from current saved value</small>`;
  const chart = scenario.neutral
    ? '<div class="scenario-neutral-state" role="status"><strong>Unchanged scenario</strong><span>Adjust a direction assumption to compare a modeled path. A flat line is intentionally not shown.</span></div>'
    : forecastProjectionChart(scenario.currentValue, [{
      horizon: scenario.horizon, q10: scenario.q10, q25: scenario.q25, q50: scenario.median,
      q75: scenario.q75, q90: scenario.q90
    }], scenario.currency, { mode: 'local-scenario' });
  return `<section class="card scenario-summary" aria-labelledby="scenario-output-title"><div class="section-heading compact"><div><p class="eyebrow">Scenario output</p><h3 id="scenario-output-title">${horizonLabel(scenario.horizon, { adjective: true })} collection scenario</h3></div><span class="support-badge modeled">${escapeHTML(scenario.evidence.level)}</span></div><dl class="scenario-output-grid"><div><dt>Current saved value</dt><dd>${escapeHTML(formatCurrency(scenario.currentValue, scenario.currency))}</dd></div><div><dt>Median scenario value</dt><dd>${escapeHTML(formatCurrency(scenario.median, scenario.currency))}</dd></div><div><dt>Middle 50% range</dt><dd>${escapeHTML(formatCurrency(scenario.q25, scenario.currency))}–${escapeHTML(formatCurrency(scenario.q75, scenario.currency))}</dd></div><div><dt>Broad 80% range</dt><dd>${escapeHTML(formatCurrency(scenario.q10, scenario.currency))}–${escapeHTML(formatCurrency(scenario.q90, scenario.currency))}</dd></div><div><dt>Difference from current</dt><dd>${difference}</dd></div><div><dt>Coverage</dt><dd>${scenario.coveredHoldings} of ${scenario.totalHoldings} items</dd></div><div><dt>Evidence level</dt><dd>${escapeHTML(scenario.evidence.level)}<small>${escapeHTML(scenario.evidence.detail)}</small></dd></div></dl>${chart}</section>`;
}

function scenarioItemRow(row, expanded) {
  const difference = Math.abs(row.difference) < 0.005
    ? 'Unchanged'
    : `${row.difference >= 0 ? '+' : '−'}${formatCurrency(Math.abs(row.difference), row.currency)}`;
  const detail = expanded ? `<div class="scenario-item-detail"><dl><div><dt>Broad 80% range</dt><dd>${escapeHTML(formatCurrency(row.q10, row.currency))}–${escapeHTML(formatCurrency(row.q90, row.currency))}</dd></div><div><dt>Difference</dt><dd>${escapeHTML(difference)}</dd></div><div><dt>Evidence</dt><dd>${escapeHTML(row.evidence.detail)}</dd></div><div><dt>Applied assumptions</dt><dd>Market ${escapeHTML(row.applied.market)} · category ${escapeHTML(row.applied.category)} · item ${escapeHTML(row.applied.item)} · manual values ${escapeHTML(row.applied.manualValues)}</dd></div></dl><button class="button ghost small" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(row.holding.id)}">Open item detail</button></div>` : '';
  return `<article class="scenario-item-row ${expanded ? 'expanded' : ''}"><button type="button" data-scenario-expand="${escapeAttribute(row.holding.id)}" aria-expanded="${expanded}">${externalImage({ ...row.holding.item, userImage: row.holding.userImage }, 'scenario-item-image')}<span class="scenario-item-name"><strong>${escapeHTML(row.holding.item?.name || 'Unnamed item')}</strong><small>${escapeHTML([row.holding.item?.setName, row.holding.item?.number].filter(Boolean).join(' · ') || 'Collection item')}</small></span><span><small>Current</small><strong>${escapeHTML(formatCurrency(row.currentValue, row.currency))}</strong></span><span><small>Median</small><strong>${escapeHTML(formatCurrency(row.median, row.currency))}</strong></span><span><small>Middle 50%</small><strong>${escapeHTML(formatCurrency(row.q25, row.currency))}–${escapeHTML(formatCurrency(row.q75, row.currency))}</strong></span><span class="scenario-evidence"><small>Evidence</small><strong>${escapeHTML(row.evidence.level)}</strong></span><i aria-hidden="true">${expanded ? '−' : '+'}</i></button>${detail}</article>`;
}

function scenarioMethodology(scenario) {
  const assumptions = scenario.assumptions;
  // DCL-INS-05: humanized assumptions here too -- category/item are
  // omitted entirely when unset rather than ever printing raw "none".
  const assumptionsLine = [
    `Market ${assumptions.marketDirection}`,
    assumptions.category ? `${assumptions.category} ${assumptions.categoryDirection}` : '',
    assumptions.itemId ? `item ${assumptions.itemDirection}` : '',
    `volatility ${assumptions.volatility}`,
    assumptions.manualValues === 'follow' ? 'manual values follow assumptions' : 'manual values held steady'
  ].filter(Boolean).join('; ');
  return `<details class="data-details scenario-methodology"><summary><span>Scenario methodology</span><span>Inputs, assumptions, evidence, and calculation time</span></summary><div><dl><div><dt>Model name</dt><dd>Collection assumption scenario</dd></div><div><dt>Model version</dt><dd>${escapeHTML(scenario.modelVersion)}</dd></div><div><dt>Inputs</dt><dd>Accepted saved values, quantities, currency, and local observation receipts.</dd></div><div><dt>Assumptions</dt><dd>${escapeHTML(assumptionsLine)}.</dd></div><div><dt>Observation count</dt><dd>${scenario.observationCount}</dd></div><div><dt>Data-source coverage</dt><dd>${scenario.sourceCount} source${scenario.sourceCount === 1 ? '' : 's'}</dd></div><div><dt>Calculation timestamp</dt><dd>${escapeHTML(scenario.calculatedAt)}</dd></div></dl></div></details>`;
}

function publishedEvidence(publication) {
  const observations = (publication.history?.length || 0) + (publication.observed ? 1 : 0);
  const sources = Math.max(1, new Set((publication.sourceAttributions || []).map((entry) => entry.name || entry.attribution).filter(Boolean)).size);
  const level = observations >= 8 && sources >= 2 ? 'Strong evidence' : observations >= 3 && sources >= 2 ? 'Moderate evidence' : 'Limited evidence';
  return { level, detail: `Based on ${observations} observation${observations === 1 ? '' : 's'} from ${sources} source${sources === 1 ? '' : 's'}.` };
}

function publishedForecastsSection(summary, assets, state, currency) {
  const rows = assets.map((asset) => {
    const forecast = asset.forecast;
    const publication = asset.publication;
    const evidence = publishedEvidence(publication);
    const expanded = state.insights?.expandedPublishedId === asset.key;
    const action = asset.holdingId
      ? `<button class="button ghost small" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(asset.holdingId)}">Open item detail</button>`
      : `<button class="button ghost small" type="button" data-action="open-detail" data-watch-key="${escapeAttribute(asset.watchKey)}">Open item detail</button>`;
    const detail = expanded ? `<div class="scenario-item-detail"><dl><div><dt>Broad 80% range</dt><dd>${escapeHTML(formatCurrency(forecast.q10, currency))}–${escapeHTML(formatCurrency(forecast.q90, currency))}</dd></div><div><dt>Evidence</dt><dd>${escapeHTML(evidence.detail)}</dd></div><div><dt>Published</dt><dd>${escapeHTML(dateLabel(publication.publishedAt))}</dd></div><div><dt>Matures</dt><dd>${escapeHTML(dateLabel(forecast.maturesAt))}</dd></div></dl>${action}</div>` : '';
    return `<article class="scenario-item-row published-outlook-row ${expanded ? 'expanded' : ''}"><button type="button" data-published-expand="${escapeAttribute(asset.key)}" aria-expanded="${expanded}">${externalImage(asset.item, 'scenario-item-image')}<span class="scenario-item-name"><strong>${escapeHTML(asset.item?.name || 'Unnamed item')}</strong><small>${escapeHTML(asset.context)}</small></span><span><small>Current market</small><strong>${publication.observed ? escapeHTML(formatCurrency(publication.observed.price, currency)) : 'Unpriced'}</strong></span><span><small>Median</small><strong>${escapeHTML(formatCurrency(forecast.q50, currency))}</strong></span><span><small>Middle 50%</small><strong>${escapeHTML(formatCurrency(forecast.q25, currency))}–${escapeHTML(formatCurrency(forecast.q75, currency))}</strong></span><span class="scenario-evidence"><small>Evidence</small><strong>${escapeHTML(evidence.level)}</strong></span><i aria-hidden="true">${expanded ? '−' : '+'}</i></button>${detail}</article>`;
  }).join('');
  // LEX sweep/RULE-7: "Approved market evidence" (3 words, governance
  // tone) shortened to a plain wayfinding eyebrow.
  return `<section class="published-forecasts" aria-labelledby="published-forecasts-title"><div class="section-heading"><div><p class="eyebrow">Forecasts</p><h3 id="published-forecasts-title">Published Forecasts</h3><p class="muted">Visible only for exact items whose evidence and publication requirements passed review. These outputs remain separate from Scenario Lab.</p></div><span class="support-badge supported">${summary.coveredHoldings} covered</span></div><div class="scenario-item-list">${rows}</div></section>`;
}

// DCL-INS-03: when the flag is off, this section simply doesn't render.
function publicationGateNotice() {
  return '';
}

function alertsSection(state) {
  const filter = ['all', 'unread', 'muted'].includes(state.insights?.alertFilter) ? state.insights.alertFilter : 'all';
  const all = alertHistoryModels(state.alerts || [], state.watchlistItems || [], 'all');
  const alerts = alertHistoryModels(state.alerts || [], state.watchlistItems || [], filter);
  const unread = all.filter((alert) => alert.unread && !alert.muted).length;
  const muted = all.filter((alert) => alert.muted).length;
  // LEX sweep/RULE-7: "Local notification history" (3 words, and repeats
  // the page lede almost verbatim) shortened to a plain eyebrow.
  return `<section class="alerts-workspace" aria-labelledby="alerts-title"><div class="alerts-summary"><div><p class="eyebrow">Notifications</p><h2 id="alerts-title">Alerts</h2><p>${all.length} recorded · ${unread} unread · ${muted} muted</p></div>${unread ? '<button class="button ghost small" type="button" data-action="mark-all-alerts-read">Mark all read</button>' : ''}</div>
    <div class="alert-filter" role="group" aria-label="Filter alert history">${[['all', 'All'], ['unread', 'Unread'], ['muted', 'Muted']].map(([value, label]) => `<button type="button" data-alert-filter="${value}" aria-pressed="${filter === value}">${label}</button>`).join('')}</div>
    ${alerts.length ? `<div class="alert-history-list">${alerts.map(alertCard).join('')}</div>` : all.length ? emptyState('No alerts match this filter', 'Choose another history filter to review saved notifications.', '<button class="button ghost" type="button" data-alert-filter="all">Show all alerts</button>') : emptyState('No alert history yet', 'Set a target or movement rule on an exact Watchlist item. Alerts are created only from approved market changes.', '<button class="button" type="button" data-go="portfolio" data-portfolio-target="watchlist">Open Watchlist</button>')}
  </section>`;
}

function alertCard(alert) {
  const labels = {
    target_price: 'Price target reached',
    percent_change: 'Price movement threshold',
    new_catalog_price: 'New catalog price',
    price_stale: 'Price became stale',
    became_unpriced: 'Item became unpriced',
    set_release: 'Set release or availability',
    watchlist_change: 'Watchlist change',
    forecast_change: 'Model-based forecast change',
    trend_change: 'Market trend change',
    range_change: 'Market range change'
  };
  const label = labels[alert.kind] || 'Collection alert';
  const name = alert.item?.name || 'Exact watched variant';
  // DCL-INS-06: chips mark exceptions only -- Unread, Muted, System.
  // Default (read/market) states carry zero chips.
  return `<article class="alert-history-card ${alert.unread ? 'unread' : 'read'} ${alert.muted ? 'muted' : ''}"><div class="alert-state">${alert.unread ? '<span>Unread</span>' : ''}${alert.muted ? '<span>Muted</span>' : ''}${alert.system ? '<span>System</span>' : ''}</div><div><p class="eyebrow">${escapeHTML(label)}</p><h3>${escapeHTML(name)}</h3><p>${escapeHTML(alert.message || 'A configured alert condition changed.')}</p><small>${escapeHTML(dateLabel(alert.triggeredAt))}</small>${alert.kind === 'forecast_change' ? '<p class="fine-print">This notification describes a model output change, not an observed price movement.</p>' : ''}</div><div class="item-actions">${alert.watched ? `<button class="button ghost small" type="button" data-action="open-detail" data-watch-key="${escapeAttribute(alert.watchKey)}">Open item</button><button class="button ghost small" type="button" data-action="edit-watch" data-watch-key="${escapeAttribute(alert.watchKey)}">Edit rule</button>` : ''}<button class="button ghost small" type="button" data-action="${alert.unread ? 'mark-alert-read' : 'mark-alert-unread'}" data-id="${escapeAttribute(alert.id)}">Mark ${alert.unread ? 'read' : 'unread'}</button><button class="button ghost small" type="button" data-action="toggle-alert-mute" data-id="${escapeAttribute(alert.id)}">${alert.muted ? 'Unmute notification' : 'Mute notification'}</button></div></article>`;
}

// DCL-INS-04: the gated state is one line (no badge, no card); the
// empty-scorecard and empty-history states each collapse to one short
// line; the surrounding governance prose (immutability, local storage
// mechanics) is gone -- the equivalent guarantee now lives once in
// methodologyDisclosure, rendered at the bottom of this page.
function trackRecordSection(state) {
  if (!state.featureFlags?.publicPriceIntelligence) return '<p class="muted">Forecast accuracy appears here once predictions mature.</p>';
  const scorecards = publishedScorecards(state.intelligence?.byVariant || {});
  const history = predictionHistoryModels(state.intelligence?.history || [], state.intelligence?.byVariant || {});
  // DCL-LEX-06/RULE-7: "Accountable model output" removed for a plain
  // wayfinding eyebrow.
  return `${intelligenceStatus(state)}<section class="track-record-workspace" aria-labelledby="track-record-title"><div class="section-heading"><div><p class="eyebrow">Collection</p><h2 id="track-record-title">Prediction Track Record</h2></div></div>
    ${scorecards.length ? `<div class="scorecard-list">${scorecards.map(scorecardCard).join('')}</div>` : '<p class="muted">Accuracy metrics aren\'t published yet.</p>'}
    <div class="section-heading"><div><p class="eyebrow">Track Record</p><h2>Forecast history</h2></div></div>
    ${history.length ? `<div class="prediction-history-list">${history.map((entry) => historyCard(entry, state)).join('')}</div>` : '<p class="muted">No forecast receipts yet.</p>'}
    </section>`;
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
  return `<article class="prediction-history-card"><div><p class="eyebrow">${entry.horizon}-day forecast · ${escapeHTML(status)}</p><h3>${escapeHTML(item.name || entry.canonicalId)}</h3><p>${escapeHTML(formatCurrency(entry.lowerBound, entry.currency))}–${escapeHTML(formatCurrency(entry.upperBound, entry.currency))} likely range · ${escapeHTML(formatCurrency(entry.expectedValue, entry.currency))} midpoint</p><small>Created ${escapeHTML(dateLabel(entry.asOfDate))} · matures ${escapeHTML(dateLabel(entry.maturityDate))}</small></div><dl><div><dt>Previous record</dt><dd>${entry.previousForecastId ? 'Linked' : 'First local receipt'}</dd></div><div><dt>What changed</dt><dd>${escapeHTML(entry.whatChanged)}</dd></div>${entry.status === 'matured' ? `<div><dt>Actual at maturity</dt><dd>${escapeHTML(formatCurrency(entry.actualValueAtMaturity, entry.currency))}</dd></div><div><dt>Absolute error</dt><dd>${escapeHTML(formatCurrency(entry.absoluteError, entry.currency))}</dd></div><div><dt>Direction result</dt><dd>${escapeHTML(entry.directionResult)}</dd></div>` : ''}</dl><details><summary>Immutable record details</summary><p class="fine-print">Forecast ID ${escapeHTML(entry.forecastId)} · model ${escapeHTML(entry.modelVersion || '—')}${entry.previousForecastId ? ` · previous ${escapeHTML(entry.previousForecastId)}` : ''}</p></details><div class="item-actions">${action}</div></article>`;
}
