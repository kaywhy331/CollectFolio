import { externalImage, pageHeader } from '../core/components.js';
import { holdingMarketValue, portfolioAllocation, portfolioSummary } from '../core/calculations.js';
import { normalizeIntelligencePayload, trendLabel } from '../core/intelligence-contract.js';
import { allocationChart, trendChart } from '../core/ui.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';

// PRD Sec 10.3 compact Home modules. Both render nothing at all when no
// approved intelligence or alert data exists, so the dormant (pre-activation)
// app gains no empty chrome.
export function portfolioMovers(holdings = [], byVariant = {}) {
  return holdings
    .filter((holding) => holding.canonicalVariantId && byVariant[holding.canonicalVariantId])
    .map((holding) => ({ holding, intelligence: normalizeIntelligencePayload(byVariant[holding.canonicalVariantId]) }))
    .filter(({ intelligence }) => intelligence.supportTier >= 2 && intelligence.trend.return30d !== null)
    .sort((left, right) => Math.abs(right.intelligence.trend.return30d) - Math.abs(left.intelligence.trend.return30d))
    .slice(0, 3);
}

export function watchlistSignals(alerts = [], watchlistItems = []) {
  const watchedKeys = new Set(watchlistItems.map((entry) => entry.watchKey));
  return alerts
    .filter((alert) => !alert.readAt && watchedKeys.has(alert.watchKey))
    .slice(0, 3);
}

function moversModule(state) {
  const movers = portfolioMovers(state.holdings, state.intelligence?.byVariant);
  if (!movers.length) return '';
  return `<section class="card"><div class="section-heading"><div><p class="eyebrow">Approved intelligence</p><h2>Portfolio movers</h2></div><button class="button ghost small" type="button" data-go="portfolio">Portfolio →</button></div>
    <div class="holding-list">${movers.map(({ holding, intelligence }) => {
      const change = intelligence.trend.return30d;
      return `<article class="holding-card"><div><h3>${escapeHTML(holding.item?.name || 'Mapped card')}</h3><p class="item-meta">${escapeHTML([holding.item?.setName, holding.item?.number].filter(Boolean).join(' · '))}</p><p class="${change >= 0 ? 'positive' : 'negative'}">${escapeHTML(formatPercent(change * 100))} / 30D · ${escapeHTML(trendLabel(intelligence.trend.status))}</p><div class="item-actions"><button class="button ghost small" type="button" data-action="open-detail" data-holding-id="${escapeAttribute(holding.id)}">Details</button></div></div></article>`;
    }).join('')}</div></section>`;
}

function signalsModule(state) {
  const signals = watchlistSignals(state.alerts, state.watchlistItems);
  if (!signals.length) return '';
  return `<section class="card"><div class="section-heading"><div><p class="eyebrow">Watchlist</p><h2>Watchlist signals</h2></div><button class="button ghost small" type="button" data-go="portfolio" data-portfolio-target="watchlist">Watchlist →</button></div>
    ${signals.map((alert) => `<p class="fine-print positive" role="status">● ${escapeHTML(alert.message)}</p>`).join('')}</section>`;
}

export function renderHome(state) {
  const currency = state.settings.currency || 'USD';
  const summary = portfolioSummary(state.holdings);
  const gainTone = summary.gain >= 0 ? 'positive' : 'negative';
  const top = [...state.holdings].sort((a, b) => holdingMarketValue(b) - holdingMarketValue(a)).slice(0, 4);
  return `${pageHeader('Portfolio overview', state.holdings.length ? 'Your collection is moving.' : 'Your collection starts here.', `${summary.uniqueItems} unique items · ${summary.totalQuantity} total pieces`, '<button class="icon-button" type="button" data-action="refresh-prices" aria-label="Refresh prices">↻</button>')}
    <section class="metric-grid" aria-label="Portfolio summary">
      <article class="card metric-card wide"><p class="metric-label">Estimated market value</p><strong class="metric-value">${escapeHTML(formatCurrency(summary.marketValue, currency))}</strong><span class="metric-detail ${gainTone}">${escapeHTML(formatCurrency(summary.gain, currency))} (${escapeHTML(formatPercent(summary.returnPercent))}) all time</span><button class="button secondary" type="button" data-go="portfolio">Open portfolio →</button></article>
      <article class="card metric-card"><p class="metric-label">Cost basis</p><strong class="metric-value">${escapeHTML(formatCurrency(summary.costBasis, currency))}</strong><span class="metric-detail">Purchase price + fees</span></article>
      <article class="card metric-card"><p class="metric-label">Unique items</p><strong class="metric-value">${summary.uniqueItems}</strong><span class="metric-detail">${summary.totalQuantity} total quantity</span></article>
      <article class="card metric-card"><p class="metric-label">Unrealized gain</p><strong class="metric-value ${gainTone}">${escapeHTML(formatCurrency(summary.gain, currency))}</strong><span class="metric-detail">${escapeHTML(formatPercent(summary.returnPercent))}</span></article>
    </section>
    ${moversModule(state)}
    ${signalsModule(state)}
    <section class="card"><div class="section-heading"><div><p class="eyebrow">Performance</p><h2>Portfolio trend</h2></div><span class="muted">90 days</span></div>${trendChart(state.snapshots, currency)}</section>
    <section class="card"><div class="section-heading"><div><p class="eyebrow">Mix</p><h2>Allocation</h2></div></div>${allocationChart(portfolioAllocation(state.holdings))}</section>
    <div class="section-heading"><div><p class="eyebrow">Highest value</p><h2>Top holdings</h2></div><button class="button ghost small" type="button" data-go="portfolio">View all</button></div>
    ${top.length ? `<div class="holding-list">${top.map((holding) => `<article class="holding-card">${externalImage({ ...holding.item, userImage: holding.userImage }, 'holding-image')}<div><h3>${escapeHTML(holding.item?.name || 'Unnamed item')}</h3><p class="item-meta">${escapeHTML([holding.item?.setName, holding.item?.number].filter(Boolean).join(' · ') || 'Custom holding')}</p><p class="item-price">${escapeHTML(formatCurrency(holdingMarketValue(holding), currency))}</p><div class="pill-row"><span class="pill">${escapeHTML(holding.condition)}</span><span class="pill">Qty ${holding.quantity}</span></div></div></article>`).join('')}</div>` : `<section class="empty-state"><span class="empty-symbol">◇</span><h2>Add your first collectible</h2><p>Search a free catalog, scan items, or create a custom holding.</p><button class="button" type="button" data-go="add">Add collectible</button></section>`}
    ${state.scanDraftCount ? `<button class="button secondary" type="button" data-action="resume-scan">Resume saved scan (${state.scanDraftCount})</button>` : ''}`;
}
