import { externalImage, pageHeader } from '../core/components.js';
import { filterAndSortHoldings, holdingCostBasis, holdingGain, holdingMarketValue, portfolioSummary, returnPercent } from '../core/calculations.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';

export function renderPortfolio(state) {
  const currency = state.settings.currency || 'USD';
  const summary = portfolioSummary(state.holdings);
  const shown = filterAndSortHoldings(state.holdings, state.portfolio);
  return `${pageHeader('Collection analytics', 'Portfolio', `${state.holdings.length} unique holdings across your collection.`, '<button class="icon-button" type="button" data-action="refresh-prices" aria-label="Refresh prices">↻</button>')}
    <section class="metric-grid">
      <article class="card metric-card wide"><p class="metric-label">Market value</p><strong class="metric-value">${escapeHTML(formatCurrency(summary.marketValue, currency))}</strong><span class="metric-detail">${summary.uniqueItems} items</span></article>
      <article class="card metric-card"><p class="metric-label">Cost basis</p><strong class="metric-value">${escapeHTML(formatCurrency(summary.costBasis, currency))}</strong><span class="metric-detail">Recorded acquisitions</span></article>
      <article class="card metric-card"><p class="metric-label">Return</p><strong class="metric-value ${summary.gain >= 0 ? 'positive' : 'negative'}">${escapeHTML(formatPercent(summary.returnPercent))}</strong><span class="metric-detail">${escapeHTML(formatCurrency(summary.gain, currency))}</span></article>
    </section>
    <div class="search-bar"><label class="sr-only" for="portfolio-query">Filter portfolio</label><input id="portfolio-query" type="search" value="${escapeAttribute(state.portfolio.query)}" placeholder="⌕  Filter portfolio" data-portfolio-query></div>
    <div class="filter-grid"><label>Category<select data-portfolio-category>${['all','pokemon','magic','yugioh','sports','comics','slab','other'].map((value) => `<option value="${value}" ${state.portfolio.category === value ? 'selected' : ''}>${escapeHTML(value === 'all' ? 'All' : value[0].toUpperCase() + value.slice(1))}</option>`).join('')}</select></label><label>Sort<select data-portfolio-sort><option value="value-desc" ${state.portfolio.sort === 'value-desc' ? 'selected' : ''}>Highest value</option><option value="gain-desc" ${state.portfolio.sort === 'gain-desc' ? 'selected' : ''}>Highest gain</option><option value="name-asc" ${state.portfolio.sort === 'name-asc' ? 'selected' : ''}>Name A–Z</option><option value="recent-desc" ${state.portfolio.sort === 'recent-desc' ? 'selected' : ''}>Recently updated</option></select></label></div>
    <div class="section-heading"><div><p class="eyebrow">${shown.length} results</p><h2>Your holdings</h2></div><button class="button secondary small" type="button" data-action="export-csv">↓ CSV</button></div>
    ${shown.length ? `<div class="holding-list">${shown.map((holding) => holdingCard(holding, currency)).join('')}</div>` : `<section class="empty-state"><span class="empty-symbol">◇</span><h2>No holdings found</h2><p>Adjust filters or add a collectible.</p><button class="button" type="button" data-go="add">Add collectible</button></section>`}`;
}

function holdingCard(holding, currency) {
  const value = holdingMarketValue(holding);
  const cost = holdingCostBasis(holding);
  const gain = holdingGain(holding);
  const providerPrice = holding.item?.price;
  const source = holding.manualMarketPrice !== '' && holding.manualMarketPrice != null
    ? providerPrice == null ? 'Manual override · provider has no price' : `Manual override · provider retained at ${formatCurrency(providerPrice, currency)}`
    : holding.item?.priceSource || 'Manual value';
  return `<article class="holding-card">${externalImage({ ...holding.item, userImage: holding.userImage }, 'holding-image')}<div><h3>${escapeHTML(holding.item?.name || 'Unnamed item')}</h3><p class="item-meta">${escapeHTML([holding.item?.setName, holding.item?.number].filter(Boolean).join(' · ') || 'Custom catalog entry')}</p><p class="item-price">${escapeHTML(formatCurrency(value, currency))}</p><p class="price-source">${escapeHTML(source)}</p><p class="${gain >= 0 ? 'positive' : 'negative'} fine-print">${escapeHTML(formatCurrency(gain, currency))} · ${escapeHTML(formatPercent(returnPercent(value, cost)))}</p><div class="pill-row"><span class="pill">${escapeHTML(holding.condition)}</span><span class="pill">Qty ${holding.quantity}</span>${holding.folder ? `<span class="pill">${escapeHTML(holding.folder)}</span>` : ''}</div><div class="item-actions"><button class="button ghost small" data-action="edit-holding" data-id="${escapeAttribute(holding.id)}">Edit</button><button class="button ghost small" data-action="delete-holding" data-id="${escapeAttribute(holding.id)}">Delete</button></div></div></article>`;
}
