import { externalImage } from '../core/components.js';
import { catalogCrumb, crumbMarkup } from '../core/catalog-crumb.js';
import { searchResultViewModel } from '../core/view-models.js';
import { buildHoldingLocalScenario } from '../core/local-scenarios.js';
import { historyLineChart } from '../core/history-chart.js';
import { normalizeIntelligencePayload } from '../core/intelligence-contract.js';
import { escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { selectPublicationForCatalogItem, selectPublicationForHolding, selectPublicationForWatchlist } from '../core/market-series.js';
import { isTrajectoryStale, trajectoryKeyForItem } from '../services/forecast-trajectory.js';
import { historyKeyForItem } from '../services/history-trajectory.js';
import { findWatchedItem } from '../services/watchlist.js';
import { UNKNOWN } from '../core/copy.js';

// Directive 2 (UX declutter follow-up, Kevin 2026-08-26): the quick view is
// no longer a modal overlay gated to the /items|/holdings route -- app.js
// renders this as a persistent, non-modal panel appended after whatever
// view is already on screen, independent of the active route. This module
// stays a pure render function either way; app.js owns all the open/close/
// resize/history plumbing.

// FA-07/FA-08: a defensive ISO-date-prefix reader for the fine-print
// published date, sourced from network state (packet.asOf / manifest.asOf /
// groupAsOf). Deliberately string-only -- no Date parsing/Intl formatting --
// so a date-only value never gets reinterpreted through the viewer's local
// timezone (see the matching helper/comment in price-intelligence-detail.js).
// Malformed input resolves to '' so callers can omit the line.
function isoDatePrefix(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

// 0.8.17: compact bar chart for the panel -- fewer bars, tighter height
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
  // DCL-DET-11: one "Unpriced" stat replaces the standalone "no verified
  // market price" line -- the stats row always carries exactly one
  // representation of a missing price.
  if (!valueAvailable) return `<div class="inspector-stat"><span>Current value</span><strong>${UNKNOWN.unpriced}</strong></div>`;
  return `<div class="inspector-stat"><span>Current value</span><strong>${escapeHTML(formatCurrency(model.currentMarketValue, model.currency))}</strong><small class="pricing-${model.pricingStatus}">${escapeHTML(labels[model.pricingStatus] || 'Market price')}</small></div>`;
}

function movementSummary(model) {
  if (model.change30d === null) return '';
  const positive = model.change30d >= 0;
  return `<div class="inspector-stat"><span>30-day movement</span><strong class="${positive ? 'positive' : 'negative'}"><span aria-hidden="true">${positive ? '↗' : '↘'}</span> ${escapeHTML(formatPercent(Math.abs(model.change30d) * 100))}</strong><small>${positive ? 'Increased' : 'Decreased'} over 30 days</small></div>`;
}

// Forecast data (directive 2 content spec) -- exactly one of three already-
// eligible sources, first match wins, nothing invented here (RULE-2):
//   1. A published forecast (intelligence.supportTier >= 4): median + the
//      50%/80% range for its nearest horizon, the same numbers
//      forecastSection() leads with on the full detail page.
//   2. Trajectory-v1 (services/forecast-trajectory.js): the 30/90-day
//      bands from a fresh, published packet -- same eligibility gate
//      trajectorySection() uses on the full detail page (eligibility ===
//      'published', packet present, not stale).
//   3. The holding's local scenario (already used above for the same
//      "Your scenario" stat before this pass).
function outlookSummary({ intelligence, item, state, localScenario }) {
  const forecasts = intelligence && intelligence.supportTier >= 4
    ? Object.values(intelligence.forecasts).sort((left, right) => left.horizon - right.horizon)
    : [];
  if (forecasts.length) {
    const nearest = forecasts[0];
    const currency = intelligence.observed?.currency || state.settings.currency;
    return `<div class="inspector-stat forecast"><span>Published outlook · ${nearest.horizon}d</span><strong>${escapeHTML(formatCurrency(nearest.q50, currency))} median</strong><small>50%: ${escapeHTML(formatCurrency(nearest.q25, currency))}–${escapeHTML(formatCurrency(nearest.q75, currency))} · 80%: ${escapeHTML(formatCurrency(nearest.q10, currency))}–${escapeHTML(formatCurrency(nearest.q90, currency))}</small></div>`;
  }
  const trajectoryKey = trajectoryKeyForItem(item || {});
  const trajectoryEntry = trajectoryKey ? state.trajectoryForecasts?.byKey?.[trajectoryKey] : null;
  const packet = trajectoryEntry?.eligibility === 'published' ? trajectoryEntry.packet : null;
  const fresh = packet && !isTrajectoryStale(packet, trajectoryEntry.manifest?.asOf || trajectoryEntry.groupAsOf);
  if (fresh) {
    const currency = state.settings?.currency || 'USD';
    const bands = [30, 90]
      .map((horizon) => [horizon, packet.horizons?.[String(horizon)]])
      .filter(([, band]) => band)
      .map(([horizon, band]) => `${horizon}d ${escapeHTML(formatCurrency(band.q10, currency))}–${escapeHTML(formatCurrency(band.q90, currency))}`);
    // FA-07/FA-08: same published-date fine print as the full detail page's
    // trajectorySection, read from whichever field the entry carries.
    // RULE-5: no field present means the clause is simply omitted.
    const publishedDateText = isoDatePrefix(packet.asOf || trajectoryEntry.manifest?.asOf || trajectoryEntry.groupAsOf);
    if (bands.length) return `<div class="inspector-stat forecast"><span>Market outlook</span><strong>${bands.join(' · ')}</strong><small>80% range${publishedDateText ? ` · Forecast published ${escapeHTML(publishedDateText)}` : ''}</small></div>`;
  }
  if (['early', 'limited', 'available'].includes(localScenario?.status)) {
    const evidence = localScenario.status === 'available' ? 'Moderate evidence' : 'Limited evidence';
    return `<div class="inspector-stat scenario"><span>Your scenario</span><strong>${escapeHTML(formatCurrency(localScenario.q25, localScenario.currency))}–${escapeHTML(formatCurrency(localScenario.q75, localScenario.currency))}</strong><small>${localScenario.horizon}-day range · ${evidence}</small></div>`;
  }
  return '';
}

// entering: true only on the render() call where the panel actually
// transitions closed->open (app.js tracks this the same way it already
// tracked focus-restore) -- keeps the slide-in animation from replaying on
// every incidental re-render while the panel stays open (background
// hydration, switching to a different item, etc).
export function renderQuickInspector(detail, state, { entering = false } = {}) {
  const item = detail?.item;
  if (!item) return '';
  const ref = detail.catalogRef || {};
  const canonicalId = ref.canonicalVariantId || detail.holding?.canonicalVariantId || detail.watched?.canonicalVariantId || '';
  const rawPublication = state.featureFlags?.publicPriceIntelligence && canonicalId
    ? state.intelligence?.byVariant?.[canonicalId]
    : null;
  const publication = detail.holding
    ? selectPublicationForHolding(rawPublication, detail.holding, state.settings.currency)
    : detail.watched
      ? selectPublicationForWatchlist(rawPublication, detail.watched, state.settings.currency)
      : selectPublicationForCatalogItem(rawPublication, item, state.settings.currency);
  const intelligence = publication ? normalizeIntelligencePayload(publication) : null;
  const model = searchResultViewModel({ ...item, canonicalVariantId: canonicalId }, { publication, currency: state.settings.currency });
  const localScenario = detail.holding
    ? buildHoldingLocalScenario(detail.holding, state.localValueObservations || [], state.settings?.defaultForecastHorizon || 90)
    : null;
  const watching = Boolean(findWatchedItem(state.watchlistItems, item, {
    canonicalVariantId: canonicalId,
    conditionClass: ref.conditionClass,
    marketCondition: ref.marketCondition || detail.watched?.marketCondition
  }));
  // UX declutter directive 3: the same "Pokémon / ME05: Pitch Black"
  // catalog breadcrumb the full detail page shows -- each segment
  // navigates to that game/set in browse (app.js closes the panel when a
  // crumb segment is actually clicked; see select-browse-game/open-browse-set).
  const crumb = crumbMarkup(catalogCrumb(item, ref));
  const identity = [model.setName, model.cardNumber ? `#${model.cardNumber}` : '', model.variant, model.language, model.rarity].filter(Boolean).join(' · ');
  const format = model.type || (item.productKind === 'sealed' ? 'Sealed product' : 'Card');
  const priceStats = `${pricingSummary(model)}${movementSummary(model)}`;
  const historyMarkup = inspectorHistoryMarkup(item, state);
  const outlook = outlookSummary({ intelligence, item, state, localScenario });
  const detent = detail.detent === 'expanded' ? 'expanded' : 'medium';
  return `<div class="quick-inspector-layer${entering ? ' entering' : ''}"><button class="inspector-scrim" type="button" data-action="close-detail" aria-label="Close quick view"></button><aside class="quick-inspector" data-sheet-detent="${detent}" role="complementary" aria-labelledby="quick-inspector-title">
    <div class="panel-resize-handle" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize quick view panel"></div>
    <button class="inspector-handle" type="button" data-action="toggle-inspector-detent" aria-label="${detent === 'expanded' ? 'Use medium quick view' : 'Expand quick view'}" aria-expanded="${detent === 'expanded'}"><span aria-hidden="true"></span></button>
    <header><div><p class="eyebrow">Quick view</p><h2 id="quick-inspector-title">${escapeHTML(model.name || 'Item inspector')}</h2></div><button class="icon-button" type="button" data-action="close-detail" aria-label="Close quick view">×</button></header>
    <div class="quick-inspector-body">
      ${crumb}
      <div class="inspector-art">${externalImage(item, 'inspector-image', { loading: 'eager' })}</div>
      <div class="inspector-identity">${identity ? `<strong>${escapeHTML(identity)}</strong>` : ''}<span>${escapeHTML([format, model.game || model.category].filter(Boolean).join(' · '))}</span></div>
      ${priceStats ? `<div class="inspector-stats">${priceStats}</div>` : ''}
      ${historyMarkup}
      ${outlook ? `<div class="inspector-stats inspector-outlook">${outlook}</div>` : ''}
      ${detail.holding ? `<div class="inspector-holding"><span>In your collection</span><strong>${escapeHTML(String(detail.holding.quantity || 0))} owned · ${escapeHTML(detail.holding.condition || 'Condition not set')}</strong></div>` : ''}
    </div>
    <footer><button class="button" type="button" data-action="add-from-detail">${detail.holding ? 'Add another' : 'Add to collection'}</button>${state.featureFlags?.watchlists !== false ? `<button class="button secondary" type="button" data-action="toggle-watch" data-detail-watch="true">${watching ? 'Watching' : 'Watch'}</button>` : ''}<button class="button ghost inspector-full-detail" type="button" data-action="open-full-detail">Open full details</button></footer>
  </aside></div>`;
}
