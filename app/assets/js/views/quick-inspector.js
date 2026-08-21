import { externalImage } from '../core/components.js';
import { searchResultViewModel } from '../core/view-models.js';
import { buildHoldingLocalScenario } from '../core/local-scenarios.js';
import { historyLineChart } from '../core/history-chart.js';
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
  const chart = historyLineChart(historyEntry.points, packet, state.settings?.currency || 'USD', { compact: true, stale });
  if (!chart) return '';
  return `<div class="inspector-history"><p class="eyebrow">Price history</p>${chart}</div>`;
}

function pricingSummary(model) {
  const labels = {
    verified: 'Verified market price', delayed: 'Delayed market price', manual: 'Manual value',
    pending: 'Pricing pending', unsupported: 'Pricing not supported for valuation',
    unavailable: 'No verified market price', error: 'Pricing could not be loaded'
  };
  const valueAvailable = model.currentMarketValue !== null && !['unsupported', 'unavailable', 'error'].includes(model.pricingStatus);
  if (!valueAvailable) return '';
  return `<div class="inspector-stat"><span>Current value</span><strong>${escapeHTML(formatCurrency(model.currentMarketValue, model.currency))}</strong><small class="pricing-${model.pricingStatus}">${escapeHTML(labels[model.pricingStatus] || 'Market price')}</small></div>`;
}

function movementSummary(model) {
  if (model.change30d === null) return '';
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
  const publishedForecastAvailable = model.forecastStatus === 'available';
  const watching = Boolean(findWatchedItem(state.watchlistItems, item, {
    canonicalVariantId: canonicalId,
    conditionClass: detail.catalogRef?.conditionClass,
    marketCondition: detail.catalogRef?.marketCondition || detail.watched?.marketCondition
  }));
  const identity = [model.setName, model.cardNumber ? `#${model.cardNumber}` : '', model.variant, model.language, model.rarity].filter(Boolean).join(' · ');
  const confidenceLabels = { exact: 'Exact match', likely: 'Likely match', possible: 'Confirm variant', unmatched: 'Identity unresolved' };
  const identityConfirmed = detail.identityConfirmed || model.matchBucket === 'exact';
  const confidence = detail.identityConfirmed ? 'Exact match · confirmed by you' : confidenceLabels[model.matchBucket] || 'Identity unresolved';
  const format = model.type || (item.productKind === 'sealed' ? 'Sealed product' : 'Card');
  const localEvidence = localScenario?.status === 'available' ? 'Moderate evidence' : 'Limited evidence';
  const stats = `${pricingSummary(model)}${movementSummary(model)}${localScenarioAvailable || publishedForecastAvailable ? `<div class="inspector-stat ${localScenarioAvailable ? 'scenario' : 'forecast'}"><span>${localScenarioAvailable ? 'Your scenario' : 'Published outlook'}</span><strong>${localScenarioAvailable ? `${escapeHTML(formatCurrency(localScenario.q25, localScenario.currency))}–${escapeHTML(formatCurrency(localScenario.q75, localScenario.currency))}` : 'Available'}</strong><small>${localScenarioAvailable ? `${localScenario.horizon}-day range · ${localEvidence}` : 'Approved outlook published'}</small></div>` : ''}`;
  const detent = detail.detent === 'expanded' ? 'expanded' : 'medium';
  return `<div class="quick-inspector-layer"><button class="inspector-scrim" type="button" data-action="close-detail" aria-label="Close item inspector"></button><aside class="quick-inspector" data-sheet-detent="${detent}" role="dialog" aria-modal="true" aria-labelledby="quick-inspector-title">
    <button class="inspector-handle" type="button" data-action="toggle-inspector-detent" aria-label="${detent === 'expanded' ? 'Use medium quick view' : 'Expand quick view'}" aria-expanded="${detent === 'expanded'}"><span aria-hidden="true"></span></button>
    <header><div><p class="eyebrow">Quick view</p><h2 id="quick-inspector-title">${escapeHTML(model.name || 'Item inspector')}</h2></div><button class="icon-button" type="button" data-action="close-detail" aria-label="Close item inspector">×</button></header>
    <div class="quick-inspector-body">
      <div class="inspector-art">${externalImage(item, 'inspector-image', { loading: 'eager' })}<span class="match-badge ${model.matchBucket}">${escapeHTML(confidence)}</span></div>
      <div class="inspector-identity"><strong>${escapeHTML(identity || 'Identity details pending')}</strong><span>${escapeHTML([format, model.game || model.category].filter(Boolean).join(' · '))}</span></div>
      ${model.currentMarketValue === null ? '<p class="inspector-unavailable">No verified market price yet</p>' : ''}
      ${stats ? `<div class="inspector-stats">${stats}</div>` : ''}
      ${detail.holding ? `<div class="inspector-holding"><span>In your collection</span><strong>${escapeHTML(String(detail.holding.quantity || 0))} owned · ${escapeHTML(detail.holding.condition || 'Condition not set')}</strong></div>` : ''}
      ${inspectorHistoryMarkup(item, state)}
    </div>
    <footer>${identityConfirmed ? `<button class="button" type="button" data-action="add-from-detail">${detail.holding ? 'Add another' : 'Add to collection'}</button>${state.featureFlags?.watchlists !== false ? `<button class="button secondary" type="button" data-action="toggle-watch" data-detail-watch="true">${watching ? 'Watching' : 'Watch'}</button>` : ''}` : '<button class="button inspector-confirm" type="button" data-action="confirm-detail-identity">Confirm exact item</button>'}<button class="button ghost inspector-full-detail" type="button" data-action="open-full-detail">Open full details</button></footer>
  </aside></div>`;
}
