import { externalImage, pageHeader } from '../core/components.js';
import { watchKeyForItem } from '../core/catalog-identity.js';
import { normalizeIntelligencePayload, trendLabel } from '../core/intelligence-contract.js';
import { filterAndSortHoldings, holdingCostBasis, holdingGain, holdingMarketValue, portfolioSummary, returnPercent } from '../core/calculations.js';
import { catalogPriceDisclosure, catalogPriceForValuation } from '../core/pricing-policy.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';

export function renderPortfolio(state) {
  const watchlistsEnabled = state.featureFlags?.watchlists !== false;
  const section = watchlistsEnabled ? state.portfolio.section || 'holdings' : 'holdings';
  const labels = {
    holdings: ['Collection analytics', 'Portfolio', `${state.holdings.length} unique holdings across your collection.`],
    watchlist: ['Cards you follow', 'Watchlist', `${state.watchlistItems.length} exact variants saved on this device.`],
    forecasts: ['Evidence before prediction', 'Forecasts', 'Model output stays gated until its data rights and validation requirements pass.']
  };
  const [eyebrow, title, subtitle] = labels[section] || labels.holdings;
  const refresh = section === 'holdings'
    ? '<button class="icon-button" type="button" data-action="refresh-prices" aria-label="Refresh prices">↻</button>'
    : '';
  return `${pageHeader(eyebrow, title, subtitle, refresh)}
    ${watchlistsEnabled ? segmentedControl(section) : ''}
    ${section === 'watchlist' ? watchlistSection(state) : section === 'forecasts' ? forecastSection(state) : holdingsSection(state)}`;
}

function segmentedControl(section) {
  return `<div class="segmented-control" role="tablist" aria-label="Portfolio sections">
    ${[['holdings','Holdings'],['watchlist','Watchlist'],['forecasts','Forecasts']].map(([value, label]) => `<button type="button" role="tab" class="segment-button ${section === value ? 'active' : ''}" aria-selected="${section === value}" data-portfolio-section="${value}">${label}</button>`).join('')}
  </div>`;
}

function holdingsSection(state) {
  const currency = state.settings.currency || 'USD';
  const summary = portfolioSummary(state.holdings);
  const shown = filterAndSortHoldings(state.holdings, state.portfolio);
  return `<section class="metric-grid">
      <article class="card metric-card wide"><p class="metric-label">Market value</p><strong class="metric-value">${escapeHTML(formatCurrency(summary.marketValue, currency))}</strong><span class="metric-detail">${summary.uniqueItems} items</span></article>
      <article class="card metric-card"><p class="metric-label">Cost basis</p><strong class="metric-value">${escapeHTML(formatCurrency(summary.costBasis, currency))}</strong><span class="metric-detail">Recorded acquisitions</span></article>
      <article class="card metric-card"><p class="metric-label">Return</p><strong class="metric-value ${summary.gain >= 0 ? 'positive' : 'negative'}">${escapeHTML(formatPercent(summary.returnPercent))}</strong><span class="metric-detail">${escapeHTML(formatCurrency(summary.gain, currency))}</span></article>
    </section>
    ${portfolioFilters(state, 'Filter portfolio')}
    <div class="section-heading"><div><p class="eyebrow">${shown.length} results</p><h2>Your holdings</h2></div><button class="button secondary small" type="button" data-action="export-csv">↓ CSV</button></div>
    ${shown.length ? `<div class="holding-list">${shown.map((holding) => holdingCard(holding, currency, state.watchlistItems, state.intelligence?.byVariant?.[holding.canonicalVariantId])).join('')}</div>` : `<section class="empty-state"><span class="empty-symbol">◇</span><h2>No holdings found</h2><p>Adjust filters or add a collectible.</p><button class="button" type="button" data-go="add">Add collectible</button></section>`}`;
}

function watchlistSection(state) {
  const currency = state.settings.currency || 'USD';
  const needle = String(state.portfolio.query || '').trim().toLowerCase();
  const category = state.portfolio.category || 'all';
  const shown = state.watchlistItems.filter((entry) => {
    const ref = entry.catalogRef || {};
    const matchesCategory = category === 'all' || ref.category === category;
    const haystack = [ref.name, ref.setName, ref.number, ref.rarity, ref.finish, entry.notes].join(' ').toLowerCase();
    return matchesCategory && (!needle || haystack.includes(needle));
  }).sort((left, right) => {
    if (state.portfolio.sort === 'name-asc') return String(left.catalogRef?.name || '').localeCompare(String(right.catalogRef?.name || ''));
    if (state.portfolio.sort === 'value-desc') return Number(catalogPriceForValuation(right.catalogRef) || 0) - Number(catalogPriceForValuation(left.catalogRef) || 0);
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
  });
  const mapped = state.watchlistItems.filter((entry) => entry.canonicalVariantId).length;
  const activeAlerts = (state.alerts || []).filter((entry) => !entry.readAt && state.watchlistItems.some((item) => item.watchKey === entry.watchKey));
  return `<section class="metric-grid compact-metrics">
      <article class="card metric-card"><p class="metric-label">Watched</p><strong class="metric-value">${state.watchlistItems.length}</strong><span class="metric-detail">Exact variants</span></article>
      <article class="card metric-card"><p class="metric-label">Canonically mapped</p><strong class="metric-value">${mapped}</strong><span class="metric-detail">${state.watchlistItems.length - mapped} awaiting mapping</span></article>
      <article class="card metric-card"><p class="metric-label">Signals</p><strong class="metric-value">${activeAlerts.length}</strong><span class="metric-detail">Approved intelligence alerts</span></article>
    </section>
    ${portfolioFilters(state, 'Filter watchlist')}
    <div class="section-heading"><div><p class="eyebrow">${shown.length} results</p><h2>Watched cards</h2></div></div>
    ${shown.length ? `<div class="holding-list">${shown.map((entry) => watchlistCard(entry, currency, state.intelligence?.byVariant?.[entry.canonicalVariantId], activeAlerts.filter((alert) => alert.watchKey === entry.watchKey))).join('')}</div>` : `<section class="empty-state"><span class="empty-symbol">☆</span><h2>${state.watchlistItems.length ? 'No watched cards match' : 'Your watchlist is empty'}</h2><p>${state.watchlistItems.length ? 'Adjust the filters to see more cards.' : 'Watch an exact printing from Search, a holding, or scan review.'}</p><button class="button" type="button" data-go="search">Search cards</button></section>`}`;
}

function forecastSection(state) {
  const publicEnabled = Boolean(state.featureFlags?.publicPriceIntelligence);
  if (!publicEnabled) return `<section class="card intelligence-gate" role="status">
    <span class="support-badge ${publicEnabled ? 'supported' : 'restricted'}">${publicEnabled ? 'Publication enabled' : 'Research gate active'}</span>
    <h2>Forecasts are not publicly available</h2>
    <p>Watchlists work now. Public price intelligence remains disabled until source rights, mapping, and walk-forward model gates pass.</p>
    <ul class="evidence-list"><li>No fabricated estimates for unsupported cards.</li><li>Past predictions will remain immutable once forecasting launches.</li><li>Observed price, trend, fair value, and forecast will remain separate outputs.</li></ul>
  </section>`;

  const publications = Object.values(state.intelligence?.byVariant || {}).map(normalizeIntelligencePayload);
  const forecastRows = publications.flatMap((publication) => Object.values(publication.forecasts).map((forecast) => ({ publication, forecast })));
  const status = `${state.intelligence?.loading ? '<p class="fine-print" role="status">Refreshing approved publications…</p>' : ''}${state.intelligence?.error ? `<p class="fine-print negative" role="status">${escapeHTML(state.intelligence.error)}</p>` : ''}`;
  if (!forecastRows.length) return `${status}<section class="card intelligence-gate" role="status"><span class="support-badge supported">Publication enabled</span><h2>No approved forecasts published yet</h2><p>Cards appear here only after a rights-cleared model run passes horizon-specific baseline, leakage, and calibration gates.</p></section>`;
  return `${status}<div class="section-heading"><div><p class="eyebrow">${forecastRows.length} approved outlooks</p><h2>Published forecasts</h2></div></div><div class="forecast-list">${forecastRows.sort((a, b) => a.forecast.horizon - b.forecast.horizon).map(({ publication, forecast }) => forecastCard(state, publication, forecast)).join('')}</div>`;
}

function portfolioFilters(state, placeholder) {
  return `<div class="search-bar"><label class="sr-only" for="portfolio-query">${escapeHTML(placeholder)}</label><input id="portfolio-query" type="search" value="${escapeAttribute(state.portfolio.query)}" placeholder="⌕  ${escapeAttribute(placeholder)}" data-portfolio-query></div>
    <div class="filter-grid"><label>Category<select data-portfolio-category>${['all','pokemon','magic','yugioh','sports','comics','slab','other'].map((value) => `<option value="${value}" ${state.portfolio.category === value ? 'selected' : ''}>${escapeHTML(value === 'all' ? 'All' : value[0].toUpperCase() + value.slice(1))}</option>`).join('')}</select></label><label>Sort<select data-portfolio-sort><option value="value-desc" ${state.portfolio.sort === 'value-desc' ? 'selected' : ''}>Highest value</option><option value="gain-desc" ${state.portfolio.sort === 'gain-desc' ? 'selected' : ''}>Highest gain</option><option value="name-asc" ${state.portfolio.sort === 'name-asc' ? 'selected' : ''}>Name A–Z</option><option value="recent-desc" ${state.portfolio.sort === 'recent-desc' ? 'selected' : ''}>Recently updated</option></select></label></div>`;
}

function holdingCard(holding, currency, watchlistItems, publication) {
  const value = holdingMarketValue(holding);
  const cost = holdingCostBasis(holding);
  const gain = holdingGain(holding);
  const providerPrice = holding.item?.price;
  const restrictedDisclosure = catalogPriceDisclosure(holding.item);
  const source = holding.manualMarketPrice !== '' && holding.manualMarketPrice != null
    ? providerPrice == null ? 'Manual value · provider has no price' : restrictedDisclosure ? `Manual value · ${restrictedDisclosure}` : `Manual override · provider retained at ${formatCurrency(providerPrice, currency)}`
    : restrictedDisclosure || holding.item?.priceSource || 'Manual value';
  const key = watchKeyForItem(holding.item, { canonicalVariantId: holding.canonicalVariantId, conditionClass: holding.grade ? 'graded' : 'raw' });
  const watching = watchlistItems.some((entry) => entry.watchKey === key);
  return `<article class="holding-card">${externalImage({ ...holding.item, userImage: holding.userImage }, 'holding-image')}<div><h3>${escapeHTML(holding.item?.name || 'Unnamed item')}</h3><p class="item-meta">${escapeHTML([holding.item?.setName, holding.item?.number].filter(Boolean).join(' · ') || 'Custom catalog entry')}</p><p class="item-price">${escapeHTML(formatCurrency(value, currency))}</p><p class="price-source">${escapeHTML(source)}</p><p class="${gain >= 0 ? 'positive' : 'negative'} fine-print">${escapeHTML(formatCurrency(gain, currency))} · ${escapeHTML(formatPercent(returnPercent(value, cost)))}</p>${publication ? intelligenceSummary(normalizeIntelligencePayload(publication), currency, true) : ''}<div class="pill-row"><span class="pill">${escapeHTML(holding.condition)}</span><span class="pill">Qty ${holding.quantity}</span>${holding.folder ? `<span class="pill">${escapeHTML(holding.folder)}</span>` : ''}</div><div class="item-actions"><button class="button ghost small" data-action="toggle-watch" data-holding-id="${escapeAttribute(holding.id)}">${watching ? '★ Watching' : '☆ Watch'}</button><button class="button ghost small" data-action="edit-holding" data-id="${escapeAttribute(holding.id)}">Edit</button><button class="button ghost small" data-action="delete-holding" data-id="${escapeAttribute(holding.id)}">Delete</button></div></div></article>`;
}

function watchlistCard(entry, currency, publication, alerts = []) {
  const ref = entry.catalogRef || {};
  const intelligence = publication ? normalizeIntelligencePayload(publication) : null;
  const observed = intelligence?.observed;
  const catalogPrice = catalogPriceForValuation(ref);
  const price = observed ? formatCurrency(observed.price, observed.currency) : catalogPrice === null ? 'Price unavailable' : formatCurrency(catalogPrice, ref.currency || currency);
  const support = entry.canonicalVariantId ? 'Canonical identity mapped · intelligence not published' : ref.mappingStatus === 'source_exact' ? 'Exact source identity · awaiting canonical mapping' : 'Identity only · mapping required';
  const signals = alerts.slice(0, 2).map((alert) => `<p class="fine-print positive" role="status">● ${escapeHTML(alert.message)}</p>`).join('');
  return `<article class="holding-card">${externalImage(ref, 'holding-image')}<div><h3>${escapeHTML(ref.name || 'Unnamed watched card')}</h3><p class="item-meta">${escapeHTML([ref.setName, ref.number, ref.rarity, ref.finish].filter(Boolean).join(' · '))}</p><p class="item-price">${escapeHTML(price)}</p><p class="price-source">${escapeHTML(observed?.source || catalogPriceDisclosure(ref) || ref.priceSource || 'No approved observed-price source')}</p>${intelligence ? intelligenceSummary(intelligence, observed?.currency || ref.currency || currency) : `<span class="support-badge unsupported">Tier 0 · ${escapeHTML(support)}</span>`}${signals}${entry.targetPrice !== '' ? `<p class="fine-print">Target: ${escapeHTML(formatCurrency(entry.targetPrice, ref.currency || currency))}</p>` : ''}<div class="item-actions"><button class="button secondary small" type="button" data-action="add-watched" data-watch-key="${escapeAttribute(entry.watchKey)}">Add to portfolio</button><button class="button ghost small" type="button" data-action="edit-watch" data-watch-key="${escapeAttribute(entry.watchKey)}">Alerts & notes</button><button class="button ghost small" type="button" data-action="remove-watch" data-watch-key="${escapeAttribute(entry.watchKey)}">Remove</button></div></div></article>`;
}

function intelligenceSummary(intelligence, currency, compact = false) {
  const tone = intelligence.supportTier >= 4 ? 'supported' : intelligence.supportTier >= 2 ? 'partial' : 'unsupported';
  const trend = intelligence.supportTier >= 2 && intelligence.trend.return30d !== null
    ? `<span class="intelligence-stat ${intelligence.trend.return30d >= 0 ? 'positive' : 'negative'}">${escapeHTML(formatPercent(intelligence.trend.return30d * 100))} / 30D · ${escapeHTML(trendLabel(intelligence.trend.status))}</span>`
    : '';
  const fair = !compact && intelligence.supportTier >= 3 && intelligence.fairValue
    ? `<span class="intelligence-stat">Fair range ${escapeHTML(formatCurrency(intelligence.fairValue.q10, currency))}–${escapeHTML(formatCurrency(intelligence.fairValue.q90, currency))}</span>`
    : '';
  return `<div class="intelligence-summary"><span class="support-badge ${tone}">Tier ${intelligence.supportTier} · Approved publication</span>${trend}${fair}</div>`;
}

function forecastCard(state, publication, forecast) {
  const holding = state.holdings.find((entry) => entry.canonicalVariantId === publication.variantId);
  const watched = state.watchlistItems.find((entry) => entry.canonicalVariantId === publication.variantId);
  const item = holding?.item || watched?.catalogRef || {};
  const currency = publication.observed?.currency || item.currency || state.settings.currency || 'USD';
  const source = publication.sourceAttributions.map((entry) => entry.name).filter(Boolean).join(', ');
  return `<article class="card forecast-card"><div class="section-heading"><div><p class="eyebrow">${forecast.horizon}-day outlook</p><h2>${escapeHTML(item.name || 'Mapped card')}</h2><p class="item-meta">${escapeHTML([item.setName, item.number, item.finish || item.variant].filter(Boolean).join(' · '))}</p></div><span class="support-badge supported">Tier ${publication.supportTier}</span></div><div class="forecast-grid"><div><span>Median modeled outcome</span><strong>${escapeHTML(formatCurrency(forecast.q50, currency))}</strong></div><div><span>50% interval</span><strong>${escapeHTML(formatCurrency(forecast.q25, currency))}–${escapeHTML(formatCurrency(forecast.q75, currency))}</strong></div><div><span>80% interval</span><strong>${escapeHTML(formatCurrency(forecast.q10, currency))}–${escapeHTML(formatCurrency(forecast.q90, currency))}</strong></div><div><span>Probability of gain</span><strong>${forecast.probabilityUp === null ? '—' : `${Math.round(forecast.probabilityUp * 100)}%`}</strong></div><div><span>Evidence confidence</span><strong>${forecast.confidence === null ? '—' : `${Math.round(forecast.confidence)}/100`}</strong></div></div><p class="fine-print">Origin ${escapeHTML(forecast.origin || 'not disclosed')} · Matures ${escapeHTML(forecast.maturesAt || 'not disclosed')} · Model ${escapeHTML(forecast.modelVersion || 'not disclosed')}</p>${source ? `<p class="price-source">Sources: ${escapeHTML(source)}</p>` : ''}</article>`;
}
