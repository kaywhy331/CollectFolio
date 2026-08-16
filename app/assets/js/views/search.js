import { emptyState, externalImage, pageHeader } from '../core/components.js';
import { catalogPriceOptionsForDisplay } from '../core/pricing-policy.js';
import { searchResultViewModel } from '../core/view-models.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent } from '../core/utils.js';
import { selectPublicationForCatalogItem } from '../core/market-series.js';
import { CATALOG_GAMES, catalogGame, filterCatalogProducts, filterCatalogSets } from '../services/catalog-browse.js';
import { findWatchedItem } from '../services/watchlist.js';

export const DISCOVER_VIEWS = Object.freeze(['gallery', 'list']);
export const DISCOVER_RESULTS_PAGE_SIZE = 200;
export const BROWSE_SETS_PAGE_SIZE = 120;
export const BROWSE_PRODUCTS_PAGE_SIZE = 120;

const MATCH_GROUPS = Object.freeze([
  ['exact', 'Exact matches', 'Verified exact identities'],
  ['likely', 'Likely matches', 'Strong candidates to inspect'],
  ['possible', 'Possible matches', 'Review set, number, and variant'],
  ['unmatched', 'Other results', 'Identity still needs review']
]);

function categoryOptions(selected) {
  return [['all', 'All supported TCGs'], ['pokemon', 'Pokémon'], ['magic', 'Magic'], ['yugioh', 'Yu-Gi-Oh!'], ['full-catalog', 'Full TCGCSV catalog'], ['sports', 'Sports — custom'], ['comics', 'Comics — custom'], ['slab', 'Graded slab — custom'], ['other', 'Other — custom']]
    .map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${escapeHTML(label)}</option>`).join('');
}

function contextualFilters(category, filters = {}) {
  const value = (name) => escapeAttribute(filters[name] || '');
  if (category === 'sports') {
    return `<label>Player<input name="player" value="${value('player')}" placeholder="Player name"></label><label>Year<input name="year" value="${value('year')}" inputmode="numeric" placeholder="e.g. 1989"></label><label>Set / product<input name="setName" value="${value('setName')}"></label><label>Grade<input name="grade" value="${value('grade')}" placeholder="Raw, PSA 10…"></label>`;
  }
  if (category === 'comics') {
    return `<label>Series<input name="setName" value="${value('setName')}"></label><label>Issue<input name="number" value="${value('number')}"></label><label>Year<input name="year" value="${value('year')}" inputmode="numeric"></label><label>Grade<input name="grade" value="${value('grade')}" placeholder="Raw, CGC 9.8…"></label>`;
  }
  if (category === 'slab') {
    return `<label>Subject<input name="player" value="${value('player')}" placeholder="Character or player"></label><label>Year<input name="year" value="${value('year')}" inputmode="numeric"></label><label>Set / series<input name="setName" value="${value('setName')}"></label><label>Grade<input name="grade" value="${value('grade')}" placeholder="PSA 10…"></label>`;
  }
  return `<label>Set / series<input name="setName" value="${value('setName')}" placeholder="Optional"></label><label>Card number<input name="number" value="${value('number')}" placeholder="Optional"></label><label>Variant / finish<input name="variant" value="${value('variant')}" placeholder="Foil, holofoil…"></label>`;
}

function providerOptions(selected) {
  return `<option value="all" ${selected === 'all' ? 'selected' : ''}>Automatic · all enabled sources</option><option value="tcgcsv" ${selected === 'tcgcsv' ? 'selected' : ''}>Full TCGCSV catalog · signed-in test</option><option value="pokemon" ${selected === 'pokemon' ? 'selected' : ''}>Pokémon market</option><option value="scryfall" ${selected === 'scryfall' ? 'selected' : ''}>Magic market</option><option value="ygoprodeck" ${selected === 'ygoprodeck' ? 'selected' : ''}>Yu-Gi-Oh! market</option>`;
}

function pricingMarkup(model) {
  const labels = {
    verified: 'Market price', delayed: 'Delayed market price', manual: 'Manual value',
    pending: 'Pricing pending', unsupported: 'Pricing not supported', unavailable: 'Pricing unavailable', error: 'Pricing error'
  };
  const hasValue = model.currentMarketValue !== null && !['unsupported', 'unavailable', 'error'].includes(model.pricingStatus);
  return `<div class="result-pricing ${escapeAttribute(model.pricingStatus)}"><strong>${hasValue ? escapeHTML(formatCurrency(model.currentMarketValue, model.currency)) : escapeHTML(labels[model.pricingStatus] || 'Pricing pending')}</strong>${hasValue ? `<small>${escapeHTML(labels[model.pricingStatus] || 'Pricing pending')}</small>` : ''}</div>`;
}

function signedPercent(value) {
  if (!Number.isFinite(value)) return '—';
  return formatPercent(value * 100);
}

function marketOutlookMarkup(model) {
  const horizons = [
    [model.forecast30d, '1 mo est.'],
    [model.forecast90d, '3 mo est.'],
    [model.forecast180d, '6 mo est.'],
    [model.forecast365d, '1 year est.']
  ].filter(([forecast]) => forecast);
  if (model.change30d === null && !horizons.length) return '';
  const trendClass = model.change30d === null ? '' : model.change30d >= 0 ? 'positive' : 'negative';
  return `<dl class="result-market-outlook" aria-label="Published market trend and forecast estimates">
    <div><dt>30D trend</dt><dd class="${trendClass}">${escapeHTML(signedPercent(model.change30d))}</dd><small>${model.change30d === null ? 'Not enough history' : model.change30d >= 0 ? 'Rolling increase' : 'Rolling decrease'}</small></div>
    ${horizons.map(([forecast, label]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(formatCurrency(forecast.estimatedValue, model.currency))}</dd><small class="${forecast.estimatedChange === null ? '' : forecast.estimatedChange >= 0 ? 'positive' : 'negative'}">${escapeHTML(signedPercent(forecast.estimatedChange))} modeled</small></div>`).join('')}
  </dl>`;
}

function resultCard(item, index, state, view, { scope = 'search', matchBadge = true } = {}) {
  const rawPublication = item.canonicalVariantId ? state.intelligence?.byVariant?.[item.canonicalVariantId] : null;
  const publication = selectPublicationForCatalogItem(rawPublication, item, state.settings.currency);
  const model = searchResultViewModel(item, { publication, currency: state.settings.currency });
  const watching = Boolean(findWatchedItem(state.watchlistItems, item));
  const finishes = catalogPriceOptionsForDisplay(item);
  const watchLabel = finishes.length > 1 ? 'Choose finish' : watching ? 'Watching' : 'Watch';
  const identity = [model.setName, model.cardNumber ? `#${model.cardNumber}` : '', model.type, model.variant, model.rarity].filter(Boolean).join(' · ');
  return `<article class="result-card ${escapeAttribute(view)}" data-action="open-detail" data-catalog-scope="${escapeAttribute(scope)}" data-index="${index}" tabindex="0" aria-label="Inspect ${escapeAttribute(model.name || 'catalog result')}">
    <div class="result-art">${externalImage(item, 'result-image', { loading: index < 12 ? 'eager' : 'lazy' })}${matchBadge ? `<span class="match-badge ${escapeAttribute(model.matchBucket)}">${escapeHTML(model.matchBucket === 'exact' ? 'Exact' : model.matchBucket === 'likely' ? 'Likely' : model.matchBucket === 'possible' ? 'Possible' : 'Review')}</span>` : ''}</div>
    <div class="result-copy"><h3>${escapeHTML(model.name || 'Unnamed collectible')}</h3><p class="item-meta">${escapeHTML(identity || 'Identity details pending')}</p>${pricingMarkup(model)}${marketOutlookMarkup(model)}<div class="result-facts"><span>${escapeHTML(model.category || 'other')}</span>${finishes.length > 1 ? `<span>${finishes.length} finishes</span>` : ''}<span>${model.forecastStatus === 'available' ? 'Published outlook' : 'No published outlook'}</span></div></div>
    <div class="result-actions"><button class="button small" type="button" data-action="add-catalog" data-catalog-scope="${escapeAttribute(scope)}" data-index="${index}">Add</button>${state.featureFlags?.watchlists !== false ? `<button class="button ghost small" type="button" data-action="toggle-watch" data-catalog-scope="${escapeAttribute(scope)}" data-index="${index}">${escapeHTML(watchLabel)}</button>` : ''}</div>
  </article>`;
}

function resultGroups(items, state, view) {
  if (!items.length) {
    if (state.search.query && !state.search.loading) return emptyState('No matching printings yet', 'Try fewer words, remove a filter, or search from an image.', '<div class="button-row centered"><button class="button ghost" type="button" data-action="clear-search-filters">Clear filters</button><button class="button secondary" type="button" data-action="start-single-scan">Search by image</button></div>');
    return emptyState('Find an exact printing', 'Search by card name, set, or number. You will review the exact variant before adding it.');
  }
  const indexed = items.map((item, index) => ({ item, index, bucket: searchResultViewModel(item).matchBucket }));
  return MATCH_GROUPS.map(([bucket, title, detail]) => {
    const group = indexed.filter((entry) => entry.bucket === bucket);
    if (!group.length) return '';
    return `<section class="result-group" aria-labelledby="result-group-${bucket}"><div class="section-heading compact"><div><p class="eyebrow">${group.length} ${group.length === 1 ? 'result' : 'results'}</p><h2 id="result-group-${bucket}">${escapeHTML(title)}</h2><p class="section-detail">${escapeHTML(detail)}</p></div></div><div class="result-list ${escapeAttribute(view)}">${group.map(({ item, index }) => resultCard(item, index, state, view)).join('')}</div></section>`;
  }).join('');
}

function recentSearches(state) {
  const recent = Array.isArray(state.settings?.recentSearches) ? state.settings.recentSearches.slice(0, 5) : [];
  if (!recent.length || state.search.query) return '';
  return `<div class="recent-searches" aria-label="Recent searches"><span>Recent</span>${recent.map((query) => `<button type="button" data-action="recent-search" data-query="${escapeAttribute(query)}">${escapeHTML(query)}</button>`).join('')}</div>`;
}

function resultPaging(search, visibleCount) {
  const remaining = search.results.length - visibleCount;
  if (remaining <= 0) return '';
  const nextCount = Math.min(DISCOVER_RESULTS_PAGE_SIZE, remaining);
  return `<div class="button-row centered catalog-result-paging" role="group" aria-label="More catalog results"><button class="button secondary" type="button" data-action="load-more-results">Show ${nextCount} more</button><button class="button ghost" type="button" data-action="show-all-results">Show all ${search.results.length}</button></div>`;
}

function discoverHeader(state, mode) {
  const description = mode === 'browse'
    ? 'Move from game to set to exact card without losing the complete catalog.'
    : 'Find the exact printing first; add ownership details only after you select it.';
  const switcher = state.featureFlags?.setBrowsing === false ? '' : `<nav class="discover-mode-switch" aria-label="Discover mode">
    <button type="button" data-action="set-discover-mode" data-mode="search" aria-pressed="${mode === 'search'}">Search cards</button>
    <button type="button" data-action="set-discover-mode" data-mode="browse" aria-pressed="${mode === 'browse'}">Browse sets</button>
  </nav>`;
  return `${pageHeader('Catalog', 'Discover', description)}${switcher}`;
}

function browseWarnings(browse) {
  const messages = [...(browse.warnings || []), browse.error].filter(Boolean);
  if (!messages.length) return '';
  return `<div class="search-warning" role="status"><strong>${browse.error ? 'Catalog browsing is temporarily unavailable.' : 'Some catalogs were unavailable.'}</strong>${messages.map((warning) => `<span>${escapeHTML(warning)}</span>`).join('')}<button class="button ghost small" type="button" data-action="retry-browse">Retry</button></div>`;
}

function gameChips(browse) {
  const games = [{ id: 'all', shortName: 'All games' }, ...CATALOG_GAMES];
  return `<div class="browse-game-chips" role="list" aria-label="Card games">${games.map((game) => `<button type="button" role="listitem" data-action="select-browse-game" data-game="${escapeAttribute(game.id)}" aria-pressed="${browse.game === game.id}">${escapeHTML(game.shortName)}</button>`).join('')}</div>`;
}

function setTile(set) {
  const count = Number.isFinite(Number(set.cardCount)) ? `${Number(set.cardCount).toLocaleString()} cards` : 'Card count pending';
  const identity = [set.code, set.year, count].filter(Boolean).join(' · ');
  return `<button class="browse-set-tile" type="button" data-action="open-browse-set" data-game="${escapeAttribute(set.gameId)}" data-set-id="${escapeAttribute(set.externalId)}">
    <span class="browse-set-game">${escapeHTML(set.game || catalogGame(set.gameId)?.name || set.gameId)}</span>
    <strong>${escapeHTML(set.name)}</strong>
    <small>${escapeHTML(identity)}</small>
    ${set.series ? `<span>${escapeHTML(set.series)}</span>` : ''}
  </button>`;
}

function renderBrowseSets(state, browse) {
  const sets = filterCatalogSets(browse.sets || [], { query: browse.query, sort: browse.sort, scope: browse.scope });
  const limit = Math.max(BROWSE_SETS_PAGE_SIZE, Number(browse.setLimit) || BROWSE_SETS_PAGE_SIZE);
  const visible = sets.slice(0, limit);
  const remaining = sets.length - visible.length;
  const resultLabel = browse.loading
    ? 'Loading complete set indexes…'
    : remaining > 0
      ? `Showing ${visible.length.toLocaleString()} of ${sets.length.toLocaleString()} sets`
      : `${sets.length.toLocaleString()} ${sets.length === 1 ? 'set' : 'sets'}`;
  const rightsNote = browse.game === 'tcgcsv'
    ? 'Full TCGCSV coverage is available only after sign-in for authenticated personal integration testing. It is not an anonymous redistribution feed.'
    : 'Browse includes every set available from the currently approved public catalogs. More games will appear as coverage expands.';
  return `${gameChips(browse)}
    <div class="browse-controls">
      <label class="browse-query"><span class="sr-only">Search sets</span><input type="search" data-browse-set-query value="${escapeAttribute(browse.query || '')}" placeholder="Search sets or codes…" autocomplete="off"></label>
      <label><span class="sr-only">Set type</span><select data-browse-set-scope><option value="all" ${browse.scope === 'all' ? 'selected' : ''}>All sets</option><option value="main" ${browse.scope === 'main' ? 'selected' : ''}>Main sets</option><option value="supplemental" ${browse.scope === 'supplemental' ? 'selected' : ''}>Supplemental</option></select></label>
      <label><span class="sr-only">Sort sets</span><select data-browse-set-sort><option value="newest" ${browse.sort === 'newest' ? 'selected' : ''}>Newest</option><option value="alpha" ${browse.sort === 'alpha' ? 'selected' : ''}>A–Z</option><option value="largest" ${browse.sort === 'largest' ? 'selected' : ''}>Largest</option></select></label>
    </div>
    ${browseWarnings(browse)}
    <div class="browse-results-head"><strong>${escapeHTML(resultLabel)}</strong><span>Every matching set remains reachable.</span></div>
    ${browse.loading ? '<div class="set-loading" role="status"><span></span><span></span><span></span><span class="sr-only">Loading sets</span></div>' : visible.length ? `<div class="browse-set-grid">${visible.map(setTile).join('')}</div>${remaining > 0 ? `<div class="button-row centered catalog-result-paging"><button class="button secondary" type="button" data-action="load-more-browse-sets">Show ${Math.min(BROWSE_SETS_PAGE_SIZE, remaining)} more</button><button class="button ghost" type="button" data-action="show-all-browse-sets">Show all ${sets.length}</button></div>` : ''}` : emptyState('No matching sets', 'Try another name, code, game, or set type.', '<button class="button ghost" type="button" data-action="clear-browse-filters">Clear filters</button>')}
    <p class="fine-print browse-rights-note">${escapeHTML(rightsNote)}</p>`;
}

function renderBrowseProducts(state, browse) {
  const selectedSet = browse.selectedSet || (browse.sets || []).find((set) => set.externalId === browse.setId && set.gameId === browse.game);
  const filtered = filterCatalogProducts(browse.products || [], { query: browse.productQuery, sort: browse.productSort });
  const indexed = filtered.map((item) => ({ item, index: (browse.products || []).indexOf(item) }));
  const limit = Math.max(BROWSE_PRODUCTS_PAGE_SIZE, Number(browse.limit) || BROWSE_PRODUCTS_PAGE_SIZE);
  const visible = indexed.slice(0, limit);
  const remaining = indexed.length - visible.length;
  const title = selectedSet?.name || browse.setId;
  const game = catalogGame(browse.game);
  return `<nav class="browse-breadcrumbs" aria-label="Browse path"><button type="button" data-action="browse-all-games">Discover</button><span>/</span><button type="button" data-action="select-browse-game" data-game="${escapeAttribute(browse.game)}">${escapeHTML(game?.shortName || browse.game)}</button><span>/</span><strong>${escapeHTML(title)}</strong></nav>
    <div class="browse-set-heading"><div><p class="eyebrow">${escapeHTML([selectedSet?.code, selectedSet?.year].filter(Boolean).join(' · ') || game?.name || '')}</p><h2>${escapeHTML(title)}</h2><p>${browse.loading ? 'Loading every card printing…' : `${filtered.length.toLocaleString()} ${filtered.length === 1 ? 'card' : 'cards'}`}</p></div><button class="button ghost small" type="button" data-action="browse-back-sets">All sets</button></div>
    <div class="browse-product-tabs" role="group" aria-label="Product type"><button type="button" aria-pressed="true">Cards</button><span>Sealed &amp; other will activate with the approved public baseline.</span></div>
    <div class="browse-controls products">
      <label class="browse-query"><span class="sr-only">Search this set</span><input type="search" data-browse-product-query value="${escapeAttribute(browse.productQuery || '')}" placeholder="Search this set…" autocomplete="off"></label>
      <label><span class="sr-only">Sort cards</span><select data-browse-product-sort><option value="number" ${browse.productSort === 'number' ? 'selected' : ''}>Collector #</option><option value="name" ${browse.productSort === 'name' ? 'selected' : ''}>Name</option><option value="price-desc" ${browse.productSort === 'price-desc' ? 'selected' : ''}>Price</option></select></label>
    </div>
    ${browseWarnings(browse)}
    ${browse.loading ? '<div class="result-loading" role="status"><span></span><span></span><span></span><span class="sr-only">Loading cards</span></div>' : visible.length ? `<div class="result-list gallery browse-product-grid">${visible.map(({ item, index }) => resultCard(item, index, state, 'gallery', { scope: 'browse', matchBadge: false })).join('')}</div>${remaining > 0 ? `<div class="button-row centered catalog-result-paging"><button class="button secondary" type="button" data-action="load-more-browse-products">Show ${Math.min(BROWSE_PRODUCTS_PAGE_SIZE, remaining)} more</button><button class="button ghost" type="button" data-action="show-all-browse-products">Show all ${indexed.length}</button></div>` : ''}` : emptyState('No matching cards', browse.error ? 'Retry the catalog request.' : 'Try another name, collector number, or rarity.', browse.error ? '<button class="button" type="button" data-action="retry-browse">Retry</button>' : '<button class="button ghost" type="button" data-action="clear-browse-product-query">Clear search</button>')}`;
}

function renderBrowse(state) {
  const browse = { game: 'all', setId: '', query: '', sort: 'newest', scope: 'all', setLimit: BROWSE_SETS_PAGE_SIZE, productQuery: '', productSort: 'number', sets: [], products: [], warnings: [], ...state.discover };
  return `${discoverHeader(state, 'browse')}${browse.setId ? renderBrowseProducts(state, browse) : renderBrowseSets(state, browse)}`;
}

export function renderSearch(state) {
  if (state.featureFlags?.setBrowsing !== false && state.discover?.mode === 'browse') return renderBrowse(state);
  const search = { filters: {}, results: [], warnings: [], ...state.search };
  const manualCategory = ['sports', 'comics', 'slab', 'other'].includes(search.category);
  const view = DISCOVER_VIEWS.includes(search.view || state.settings?.discoverView) ? (search.view || state.settings.discoverView) : 'gallery';
  const resultLimit = Math.max(DISCOVER_RESULTS_PAGE_SIZE, Math.trunc(Number(search.limit) || DISCOVER_RESULTS_PAGE_SIZE));
  const visibleResults = search.results.slice(0, resultLimit);
  const resultCount = search.results.length > visibleResults.length
    ? `Showing ${visibleResults.length} of ${search.results.length} results`
    : `${search.results.length} result${search.results.length === 1 ? '' : 's'}`;
  return `${discoverHeader(state, 'search')}
    <form id="catalog-search" class="discover-search">
      <div class="search-command"><button class="search-image-button" type="button" data-action="start-single-scan" aria-label="Search from an image">▣</button><label class="sr-only" for="catalog-query">Search catalog</label><input id="catalog-query" name="query" type="search" required minlength="2" value="${escapeAttribute(search.query)}" placeholder="Card, set, number, character, or player" autocomplete="off"><button class="search-clear" type="button" data-action="clear-search" aria-label="Clear search" ${search.query ? '' : 'hidden'}>×</button><button class="button" ${search.loading ? 'disabled' : ''}>${search.loading ? 'Searching…' : 'Search'}</button></div>
      ${recentSearches({ ...state, search })}
      <details class="discover-filters" ${Object.values(search.filters || {}).some(Boolean) ? 'open' : ''}><summary><span>Filters</span><span>${escapeHTML(search.category === 'all' ? 'All supported TCGs' : search.category)}</span></summary><div class="discover-filter-grid"><label>Category<select name="category">${categoryOptions(search.category)}</select></label>${contextualFilters(search.category, search.filters)}<details class="data-source-control"><summary>Data source</summary><label>Market source<select name="provider">${providerOptions(search.provider)}</select></label><p>Automatic selection searches every enabled source and keeps partial results if one is unavailable.</p></details></div></details>
    </form>
    ${search.cached ? '<p class="fine-print search-status">Showing a recent result cached on this device.</p>' : ''}
    ${search.warnings.length ? `<div class="search-warning" role="status"><strong>Some sources were unavailable.</strong>${search.warnings.map((warning) => `<span>${escapeHTML(warning)}</span>`).join('')}<small>Your search and filters are unchanged.</small></div>` : ''}
    ${manualCategory ? `${emptyState(`Create a precise ${search.category} record`, 'There is no universal rights-cleared catalog for this category. Add the identity and value you can verify.', `<button class="button" type="button" data-action="custom-holding" data-category="${escapeAttribute(search.category)}">Create custom item</button>`)}` : `<div class="discover-results-head"><div><strong>${search.loading ? 'Searching sources…' : resultCount}</strong><span>${search.query ? `for “${escapeHTML(search.query)}”` : 'ready to search'}</span></div><div class="view-toggle" role="group" aria-label="Result view"><button type="button" data-discover-view="gallery" aria-pressed="${view === 'gallery'}" aria-label="Gallery view">▦</button><button type="button" data-discover-view="list" aria-pressed="${view === 'list'}" aria-label="List view">☷</button></div></div>${search.loading ? '<div class="result-loading" role="status"><span></span><span></span><span></span><span class="sr-only">Searching catalog sources</span></div>' : `${resultGroups(visibleResults, { ...state, search }, view)}${resultPaging(search, visibleResults.length)}`}`}`;
}
