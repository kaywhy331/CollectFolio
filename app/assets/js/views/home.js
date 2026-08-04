import { externalImage, pageHeader } from '../core/components.js';
import { holdingMarketValue, portfolioAllocation, portfolioSummary } from '../core/calculations.js';
import { allocationChart, trendChart } from '../core/ui.js';
import { escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';

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
    <section class="card"><div class="section-heading"><div><p class="eyebrow">Performance</p><h2>Portfolio trend</h2></div><span class="muted">90 days</span></div>${trendChart(state.snapshots, currency)}</section>
    <section class="card"><div class="section-heading"><div><p class="eyebrow">Mix</p><h2>Allocation</h2></div></div>${allocationChart(portfolioAllocation(state.holdings))}</section>
    <div class="section-heading"><div><p class="eyebrow">Highest value</p><h2>Top holdings</h2></div><button class="button ghost small" type="button" data-go="portfolio">View all</button></div>
    ${top.length ? `<div class="holding-list">${top.map((holding) => `<article class="holding-card">${externalImage({ ...holding.item, userImage: holding.userImage }, 'holding-image')}<div><h3>${escapeHTML(holding.item?.name || 'Unnamed item')}</h3><p class="item-meta">${escapeHTML([holding.item?.setName, holding.item?.number].filter(Boolean).join(' · ') || 'Custom holding')}</p><p class="item-price">${escapeHTML(formatCurrency(holdingMarketValue(holding), currency))}</p><div class="pill-row"><span class="pill">${escapeHTML(holding.condition)}</span><span class="pill">Qty ${holding.quantity}</span></div></div></article>`).join('')}</div>` : `<section class="empty-state"><span class="empty-symbol">◇</span><h2>Add your first collectible</h2><p>Search a free catalog, scan items, or create a custom holding.</p><button class="button" type="button" data-go="add">Add collectible</button></section>`}
    ${state.scanDraftCount ? `<button class="button secondary" type="button" data-action="resume-scan">Resume saved scan (${state.scanDraftCount})</button>` : ''}`;
}
