import { externalImage } from '../core/components.js';
import { searchResultViewModel } from '../core/view-models.js';
import { buildHoldingLocalScenario } from '../core/local-scenarios.js';
import { historyBarChart } from '../core/history-chart.js';
import { escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { selectPublicationForCatalogItem, selectPublicationForHolding, selectPublicationForWatchlist } from '../core/market-series.js';
import { isTrajectoryStale, trajectoryKeyForItem } from '../services/forecast-trajectory.js';
import { historyKeyForItem } from '../services/history-trajectory.js';
import { findWatchedItem } from '../services/watchlist.js';

// 0.8.17: compact bar chart for the drawer -- fewer bars, tighter height
// (see core/history-chart.js's `compact` option). Same fail-closed rule
// as the full detail page: no published history object -> no chart, and
// forecast-less items simply get history bars with no projection overlay.
function inspectorHistoryMarkup(item, state) {
  const historyKey = historyKeyForItem(item || {});
  if (!historyKey) return '';
  const historyEntry = state.priceHistory?.byKey?.[historyKey];
  if (!historyEntry?.available || !Array.isArray(historyEntry.points) || !historyEntry.points.length) return '';
  const trajectoryKey = trajectoryKeyForItem(item || {});
  const trajectoryEntry = trajectoryKey ? state.trajectoryForecasts?.byKey?.[trajectoryKey] : null;
  const packet = trajectoryEntry?.eligibility === 'published' ? trajectoryEntry.packet : null;
  const stale = packet ? isTrajectoryStale(packet, trajectoryEntry.manifest?.asOf || trajectoryEntry.groupAsOf) : false;
  const chart = historyBarChart(historyEntry.points, packet, state.settings?.currency || 'USD', { compact: true, stale });
  if (!chart) return '';
  return `<div class="inspector-history"><p class="eyebrow">Price history</p>${chart}</div>`;
}

function pricingSummary(model) {
  const labels = {
    verified: 'Verified market price', delayed: 'Delayed market price', manual: 'Manual value',
    pending: 'Pricing pending', unsupported: 'Pricing not supported for valuation',
    unavailable: 'Pricing unavailable', error: 'Pricing could not be loaded'
  };
  const valueAvailable = model.currentMarketValue !== null && !['unsupported', 'unavailable', 'error'].includes(model.pricingStatus);
  return `<div class="inspector-stat"><span>Current value</span><strong>${valueAvailable ? escapeHTML(formatCurrency(model.currentMarketValue, model.currency)) : '—'}</strong><small class="pricing-${model.pricingStatus}">${escapeHTML(labels[model.pricingStatus] || 'Pricing pending')}</small></div>`;
}

function movementSummary(model) {
  if (model.change30d === null) return '<div class="inspector-stat"><span>30-day movement</span><strong>—</strong><small>Not enough approved history</small></div>';
  const positive = model.change30d >= 0;
  return `<div class="inspector-stat"><span>30-day movement</span><strong class="${positive ? 'positive' : 'negative'}"><span aria-hidden="true">${positive ? '↗' : '↘'}</span> ${escapeHTML(formatPercent(Math.abs(model.change30d) * 100))}</strong><small>${positive ? 'Increased' : 'Decreased'} over 30 days</small></div>`;
}

export function renderQuickInspector(detail, state) {
  const item = detail?.item;
  if (!item) return '';
  const canonicalId = detail.catalogRef?.canonicalVariantId || detail.holding?.canonicalVariantId || detail.watched?.canonicalVariantId || '';
  const rawPublication = state.featureFlags?.publicPriceIntelligence && canonicalId
    ? state.intelligence?.byVariant?.[canonicalId]
    : null;
  const publication = detail.holding
    ? selectPublicationForHolding(rawPublication, detail.holding, state.settings.currency)
    : detail.watched
      ? selectPublicationForWatchlist(rawPublication, detail.watched, state.settings.currency)
      : selectPublicationForCatalogItem(rawPublication, item, state.settings.currency);
  const model = searchResultViewModel({ ...item, canonicalVariantId: canonicalId }, { publication, currency: state.settings.currency });
  const localScenario = detail.holding
    ? buildHoldingLocalScenario(detail.holding, state.localValueObservations || [], state.settings?.defaultForecastHorizon || 90)
    : null;
  const localScenarioAvailable = ['early', 'limited', 'available'].includes(localScenario?.status);
  const watching = Boolean(findWatchedItem(state.watchlistItems, item, {
    canonicalVariantId: canonicalId,
    conditionClass: detail.catalogRef?.conditionClass,
    marketCondition: detail.catalogRef?.marketCondition || detail.watched?.marketCondition
  }));
  const identity = [model.setName, model.cardNumber ? `#${model.cardNumber}` : '', model.variant, model.language, model.rarity].filter(Boolean).join(' · ');
  return `<div class="quick-inspector-layer"><button class="inspector-scrim" type="button" data-action="close-detail" aria-label="Close card inspector"></button><aside class="quick-inspector" role="dialog" aria-modal="true" aria-labelledby="quick-inspector-title">
    <div class="inspector-handle" aria-hidden="true"></div>
    <header><div><p class="eyebrow">Selected printing</p><h2 id="quick-inspector-title">${escapeHTML(model.name || 'Card inspector')}</h2></div><button class="icon-button" type="button" data-action="close-detail" aria-label="Close card inspector">×</button></header>
    <div class="quick-inspector-body">
      <div class="inspector-art">${externalImage(item, 'inspector-image', { loading: 'eager' })}<span class="match-badge ${model.matchBucket}">${escapeHTML(model.matchBucket === 'exact' ? 'Exact identity' : model.matchBucket === 'likely' ? 'Likely match' : model.matchBucket === 'possible' ? 'Possible match' : 'Review identity')}</span></div>
      <div class="inspector-identity"><strong>${escapeHTML(identity || 'Identity details pending')}</strong><span>${escapeHTML([model.game || model.category, model.sourceId].filter(Boolean).join(' · '))}</span></div>
      <div class="inspector-stats">${pricingSummary(model)}${movementSummary(model)}<div class="inspector-stat forecast"><span>${localScenarioAvailable ? 'Manual scenario' : 'Published forecast'}</span><strong>${localScenarioAvailable ? `${escapeHTML(formatCurrency(localScenario.q25, localScenario.currency))}–${escapeHTML(formatCurrency(localScenario.q75, localScenario.currency))}` : model.forecastStatus === 'available' ? 'Available' : '—'}</strong><small>${localScenarioAvailable ? `${localScenario.horizon}-day range · ${escapeHTML(localScenario.confidence.label)} confidence` : model.forecastStatus === 'available' ? 'Approved outlook published' : detail.holding ? 'Add a value to start a manual scenario' : 'No approved outlook published'}</small></div></div>
      ${detail.holding ? `<div class="inspector-holding"><span>In your portfolio</span><strong>${escapeHTML(String(detail.holding.quantity || 0))} owned · ${escapeHTML(detail.holding.condition || 'Condition not set')}</strong></div>` : ''}
      ${inspectorHistoryMarkup(item, state)}
    </div>
    <footer><button class="button" type="button" data-action="add-from-detail">${detail.holding ? 'Add another' : 'Add to portfolio'}</button>${state.featureFlags?.watchlists !== false ? `<button class="button secondary" type="button" data-action="toggle-watch" data-detail-watch="true">${watching ? 'Watching' : 'Watch'}</button>` : ''}<button class="button ghost inspector-full-detail" type="button" data-action="open-full-detail">Open full details</button></footer>
  </aside></div>`;
}
