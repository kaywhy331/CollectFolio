import { emptyState, externalImage, pageHeader } from '../core/components.js';
import { priceFreshness } from '../core/data-freshness.js';
import { catalogPriceOptionsForDisplay } from '../core/pricing-policy.js';
import { searchResultViewModel } from '../core/view-models.js';
import { escapeAttribute, escapeHTML, formatCurrency, formatPercent, safeImageUrl } from '../core/utils.js';
import { selectPublicationForCatalogItem } from '../core/market-series.js';
import { CATALOG_GAMES, catalogGame, filterCatalogProducts, filterCatalogSets, mergeCatalogGames, catalogSetYears, groupCatalogSets } from '../services/catalog-browse.js';
import { findWatchedItem } from '../services/watchlist.js';
import { trajectoryForecastEstimates, trajectoryKeyForItem } from '../services/forecast-trajectory.js';

// Trajectory-v1 (T6): looks up a prefetched forecast packet for a TCGCSV
// catalog item (see app.js's hydrateTrajectoryForecasts) and shapes it
// into the {30, 90} estimate map searchResultViewModel already knows how
// to merge alongside cloud-published intelligence. Only an explicitly
// "published"-eligibility packet ever produces an estimate here -- a
// cold-start-confidence packet still counts as published (T6 requires it
// display, just labeled distinctly), while "excluded"/"unknown" never do.
function trajectoryEstimatesForItem(item, state) {
  const key = trajectoryKeyForItem(item);
  if (!key) return null;
  const entry = state.trajectoryForecasts?.byKey?.[key];
  if (!entry || entry.eligibility !== 'published' || !entry.packet) return null;
  return trajectoryForecastEstimates(entry.packet);
}

export const DISCOVER_VIEWS = Object.freeze(['gallery', 'list']);
export const DISCOVER_RESULTS_PAGE_SIZE = 200;
export const BROWSE_SETS_PAGE_SIZE = 24;
export const BROWSE_PRODUCTS_PAGE_SIZE = 24;

const MATCH_GROUPS = Object.freeze([
  ['exact', 'Exact matches', 'Verified exact identities'],
  ['likely', 'Likely matches', 'Strong candidates to inspect'],
  ['possible', 'Possible matches', 'Review set, number, and variant'],
  ['unmatched', 'Other results', 'Identity still needs review']
]);

function categoryOption(value, label, selected) {
  return `<option value="${escapeAttribute(value)}" ${selected === value ? 'selected' : ''}>${escapeHTML(label)}</option>`;
}

function categoryOptions(selected, games = []) {
  const mergedGames = mergeCatalogGames(games);
  // Flagship games (Pokémon/Magic/Yu-Gi-Oh!) are already listed in `standard`
  // below via CATALOG_GAMES -- exclude them here so catalog-v2 B1 doesn't
  // duplicate them into the TCGCSV optgroup too.
  const tcgcsvGames = mergedGames.filter((game) => game.provider === 'tcgcsv' && !game.flagship);
  const selectedGame = catalogGame(selected, mergedGames);
  if (selectedGame?.provider === 'tcgcsv' && !selectedGame.flagship && !tcgcsvGames.some((game) => game.id === selectedGame.id)) {
    tcgcsvGames.push(selectedGame);
  }
  const standard = [
    ['all', 'All supported TCGs'],
    ...CATALOG_GAMES.map((game) => [game.id, game.name])
  ].map(([value, label]) => categoryOption(value, label, selected)).join('');
  const tcgcsv = tcgcsvGames.length
    ? `<optgroup label="More games and categories (${tcgcsvGames.length})">${tcgcsvGames.map((game) => categoryOption(game.id, game.name, selected)).join('')}</optgroup>`
    : '';
  const custom = [['sports', 'Sports — custom'], ['comics', 'Comics — custom'], ['slab', 'Graded slab — custom'], ['other', 'Other — custom']]
    .map(([value, label]) => categoryOption(value, label, selected)).join('');
  return `${standard}${tcgcsv}${custom}`;
}

function categoryLabel(selected, games = []) {
  if (selected === 'all') return 'All supported TCGs';
  return catalogGame(selected, games)?.name
    || ({ sports: 'Sports', comics: 'Comics', slab: 'Graded slab', other: 'Other' })[selected]
    || selected;
}

function contextualFilters(category, filters = {}, formId = '') {
  const value = (name) => escapeAttribute(filters[name] || '');
  const form = formId ? ` form="${escapeAttribute(formId)}"` : '';
  if (category === 'sports') {
    return `<label>Player<input name="player"${form} value="${value('player')}" placeholder="Player name"></label><label>Year<input name="year"${form} value="${value('year')}" inputmode="numeric" placeholder="e.g. 1989"></label><label>Set / product<input name="setName"${form} value="${value('setName')}"></label><label>Grade<input name="grade"${form} value="${value('grade')}" placeholder="Raw, PSA 10…"></label>`;
  }
  if (category === 'comics') {
    return `<label>Series<input name="setName"${form} value="${value('setName')}"></label><label>Issue<input name="number"${form} value="${value('number')}"></label><label>Year<input name="year"${form} value="${value('year')}" inputmode="numeric"></label><label>Grade<input name="grade"${form} value="${value('grade')}" placeholder="Raw, CGC 9.8…"></label>`;
  }
  if (category === 'slab') {
    return `<label>Subject<input name="player"${form} value="${value('player')}" placeholder="Character or player"></label><label>Year<input name="year"${form} value="${value('year')}" inputmode="numeric"></label><label>Set / series<input name="setName"${form} value="${value('setName')}"></label><label>Grade<input name="grade"${form} value="${value('grade')}" placeholder="PSA 10…"></label>`;
  }
  return `<label>Set / series<input name="setName"${form} value="${value('setName')}" placeholder="Optional"></label><label>Card number<input name="number"${form} value="${value('number')}" placeholder="Optional"></label><label>Variant / finish<input name="variant"${form} value="${value('variant')}" placeholder="Foil, holofoil…"></label>`;
}

// catalog-v2 B3: Pokémon/Magic/Yu-Gi-Oh! now search the TCGCSV catalog
// exclusively (services/catalog.js's FLAGSHIP_GAMES) -- the old
// provider-specific "market" options never return a result for those
// games anymore, so they're removed rather than left as dead choices.
function providerOptions(selected) {
  return `<option value="all" ${selected === 'all' ? 'selected' : ''}>Automatic · all enabled sources</option><option value="tcgcsv" ${selected === 'tcgcsv' ? 'selected' : ''}>Trading card games</option>`;
}

function pricingMarkup(model, item, { compact = false } = {}) {
  const labels = {
    verified: 'Market price', delayed: 'Delayed market price', manual: 'Manual value',
    pending: 'Pricing pending', unsupported: 'Pricing not supported', unavailable: 'No verified market price', error: 'Pricing error'
  };
  const hasValue = model.currentMarketValue !== null && !['unsupported', 'unavailable', 'error'].includes(model.pricingStatus);
  const freshness = priceFreshness({ provider: item?.provider, priceUpdatedAt: model.priceUpdatedAt });
  const provenance = [labels[model.pricingStatus] || 'Market price', model.priceSource, freshness.label].filter(Boolean).join(' · ');
  return `<div class="result-pricing ${escapeAttribute(model.pricingStatus)}"><strong>${hasValue ? escapeHTML(formatCurrency(model.currentMarketValue, model.currency)) : escapeHTML(labels[model.pricingStatus] || 'No verified price')}</strong>${hasValue && !compact ? `<small>${escapeHTML(provenance || labels[model.pricingStatus] || 'Market price')}</small>` : ''}</div>`;
}

function signedPercent(value) {
  if (!Number.isFinite(value)) return '—';
  return formatPercent(value * 100);
}

// Reduced-confidence trajectory tiers (serve-all-cohorts mode, Kevin
// 2026-08-18): served and displayed, but never presented as a fully
// modeled forecast -- each carries an explicit qualifier.
const EARLY_ESTIMATE_CONFIDENCES = Object.freeze(['low-history', 'insufficient-history']);

function outlookEstimateCell(forecast, label, currency, { compact = false } = {}) {
  if (!forecast) {
    return `<div><dt>${escapeHTML(label)}</dt><dd>—<small>Not enough data yet</small></dd></div>`;
  }
  const qualifier = compact ? '' : forecast.status === 'cold-start'
    ? ' · cold start estimate'
    : EARLY_ESTIMATE_CONFIDENCES.includes(forecast.confidence)
      ? ' · early estimate'
      : ' modeled';
  return `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(formatCurrency(forecast.estimatedValue, currency))}<small class="${forecast.estimatedChange === null ? '' : forecast.estimatedChange >= 0 ? 'positive' : 'negative'}">${escapeHTML(signedPercent(forecast.estimatedChange))}${qualifier}</small></dd></div>`;
}

function marketOutlookMarkup(model, { compact = false, showNotes = true } = {}) {
  const horizons = (compact ? [
    [model.forecast30d, '1 mo est.'],
    [model.forecast90d, '3 mo est.']
  ] : [
    [model.forecast30d, '1 mo est.'],
    [model.forecast90d, '3 mo est.'],
    [model.forecast180d, '6 mo est.'],
    [model.forecast365d, '1 year est.']
  ]).filter(([forecast]) => forecast);
  if ((compact || model.change30d === null) && !horizons.length) return '';
  const trendClass = model.change30d === null ? '' : model.change30d >= 0 ? 'positive' : 'negative';
  const coldStart = horizons.some(([forecast]) => forecast?.status === 'cold-start');
  const early = horizons.some(([forecast]) => forecast && forecast.status !== 'cold-start' && EARLY_ESTIMATE_CONFIDENCES.includes(forecast.confidence));
  return `<dl class="result-market-outlook${compact ? ' compact' : ''}" aria-label="Published market trend and forecast estimates">
    ${compact || model.change30d === null ? '' : `<div><dt>30D trend</dt><dd class="${trendClass}">${escapeHTML(signedPercent(model.change30d))}<small>${model.change30d >= 0 ? 'Rolling increase' : 'Rolling decrease'}</small></dd></div>`}
    ${horizons.map(([forecast, label]) => outlookEstimateCell(forecast, label, model.currency, { compact })).join('')}
    ${showNotes && coldStart ? '<div class="result-outlook-note"><dt class="sr-only">Estimate note</dt><dd><small>Cold start estimate: built without enough observed price history for this printing. Treat as wider and less certain than a standard forecast.</small></dd></div>' : ''}
    ${showNotes && early ? '<div class="result-outlook-note"><dt class="sr-only">Estimate note</dt><dd><small>Early estimate: built from a short observed price history for this printing. Treat as wider and less certain than a standard forecast.</small></dd></div>' : ''}
  </dl>`;
}

function productFormat(item, model) {
  const name = String(item?.name || '').toLowerCase();
  if (item?.productKind !== 'sealed') return model.type || 'Card';
  if (/\bcase\b/.test(name)) return 'Case';
  if (/\b(box|display)\b/.test(name)) return 'Booster box';
  if (/\b(pack|booster)\b/.test(name)) return 'Booster pack';
  if (/\b(deck)\b/.test(name)) return 'Deck';
  if (/\b(bundle|collection)\b/.test(name)) return 'Bundle';
  if (/\btin\b/.test(name)) return 'Tin';
  return model.type || 'Sealed product';
}

function resultCard(item, index, state, view, {
  scope = 'search',
  matchBadge = true,
  compact = false,
  showForecastNotes = true
} = {}) {
  const rawPublication = item.canonicalVariantId ? state.intelligence?.byVariant?.[item.canonicalVariantId] : null;
  const publication = selectPublicationForCatalogItem(rawPublication, item, state.settings.currency);
  const model = searchResultViewModel(item, { publication, currency: state.settings.currency, trajectoryEstimates: trajectoryEstimatesForItem(item, state) });
  const watching = Boolean(findWatchedItem(state.watchlistItems, item));
  const finishes = catalogPriceOptionsForDisplay(item);
  const watchLabel = finishes.length > 1 ? 'Choose finish' : watching ? 'Watching' : 'Watch';
  const identity = (compact
    ? [model.cardNumber ? `#${model.cardNumber}` : '', model.variant, model.rarity]
    : [model.setName, model.cardNumber ? `#${model.cardNumber}` : '', model.type, model.variant, model.rarity]
  ).filter(Boolean).join(' · ');
  const format = productFormat(item, model);
  const confirmedIdentity = model.matchBucket === 'exact';
  return `<article class="result-card ${escapeAttribute(view)}${compact ? ' browse-compact' : ''}" data-action="open-detail" data-catalog-scope="${escapeAttribute(scope)}" data-index="${index}" tabindex="0" aria-label="Inspect ${escapeAttribute(model.name || 'catalog result')}">
    <div class="result-art">${externalImage(item, 'result-image', { loading: index < 12 ? 'eager' : 'lazy' })}${!compact || item.productKind === 'sealed' ? `<span class="product-format-badge">${escapeHTML(format)}</span>` : ''}${matchBadge ? `<span class="match-badge ${escapeAttribute(model.matchBucket)}">${escapeHTML(model.matchBucket === 'exact' ? 'Exact' : model.matchBucket === 'likely' ? 'Likely' : model.matchBucket === 'possible' ? 'Confirm variant' : 'Unresolved')}</span>` : ''}</div>
    <div class="result-copy"><h3>${escapeHTML(model.name || 'Unnamed collectible')}</h3><p class="item-meta">${escapeHTML(identity || 'Identity details pending')}</p>${pricingMarkup(model, item, { compact })}${marketOutlookMarkup(model, { compact, showNotes: showForecastNotes })}${compact ? '' : `<div class="result-facts"><span>${escapeHTML(model.game || model.category || 'other')}</span>${finishes.length > 1 ? `<span>${finishes.length} finishes</span>` : ''}${model.forecastStatus === 'available' ? '<span>Published outlook</span>' : ''}</div>`}</div>
    <div class="result-actions">${confirmedIdentity ? `<button class="button small" type="button" data-action="add-catalog" data-catalog-scope="${escapeAttribute(scope)}" data-index="${index}">Add to collection</button>${state.featureFlags?.watchlists !== false ? `<button class="button ghost small" type="button" data-action="toggle-watch" data-catalog-scope="${escapeAttribute(scope)}" data-index="${index}">${escapeHTML(watchLabel)}</button>` : ''}` : `<button class="button small" type="button" data-action="review-catalog-identity" data-catalog-scope="${escapeAttribute(scope)}" data-index="${index}">Confirm exact item</button>`}</div>
  </article>`;
}

function resultGroups(items, state, view) {
  if (!items.length) {
    if (state.search.query && !state.search.loading) return emptyState('No matching printings yet', 'Try fewer words, remove a filter, or search from an image.', '<div class="button-row centered"><button class="button ghost" type="button" data-action="clear-search-filters">Clear filters</button><button class="button secondary" type="button" data-action="start-single-scan">Search by image</button></div>');
    return emptyState('Find an exact printing', 'Search by card name, set, or number. You will review the exact variant before adding it.');
  }
  const indexed = items.map((item, visibleIndex) => ({
    item,
    index: state.search.results.indexOf(item) >= 0 ? state.search.results.indexOf(item) : visibleIndex,
    bucket: searchResultViewModel(item).matchBucket
  }));
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
  return `<div class="button-row centered catalog-result-paging" role="group" aria-label="More catalog results"><button class="button secondary" type="button" data-action="load-more-results">Show ${nextCount} more</button></div>`;
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

function browseGameButton(game, browse, { directory = false } = {}) {
  const name = game.shortName || game.name;
  const searchText = `${game.name || name} ${game.categoryId || ''}`.trim().toLowerCase();
  return `<button type="button" data-action="select-browse-game" data-game="${escapeAttribute(game.id)}"${directory ? ` data-game-search-text="${escapeAttribute(searchText)}"` : ''} aria-pressed="${browse.game === game.id}"><span>${escapeHTML(name)}</span>${directory ? '<small>Active</small>' : ''}</button>`;
}

function gameMark(game) {
  const label = game.shortName || game.name || 'Collectible';
  return escapeHTML(label.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase() || 'CF');
}

function browseGameTile(game, browse) {
  const name = game.shortName || game.name;
  return `<button class="discover-category-tile" type="button" data-action="select-browse-game" data-game="${escapeAttribute(game.id)}" aria-pressed="${browse.game === game.id}"><span class="category-mark" aria-hidden="true">${gameMark(game)}</span><strong>${escapeHTML(name)}</strong><small>Browse sets and items</small></button>`;
}

function categoryPickerOverlay(browse, catalogGames) {
  if (!browse.categoryPickerOpen) return '';
  const games = catalogGames.filter((game) => game.id !== 'all');
  return `<div class="category-picker-layer">
    <button class="category-picker-scrim" type="button" data-action="close-category-picker" aria-label="Close category picker"></button>
    <section class="category-picker" role="dialog" aria-modal="true" aria-labelledby="category-picker-title">
      <header><div><p class="eyebrow">Discover</p><h2 id="category-picker-title">All games and categories</h2><p>${games.length.toLocaleString()} catalog categories</p></div><button class="icon-button" type="button" data-action="close-category-picker" aria-label="Close category picker">×</button></header>
      <label class="browse-game-search"><span class="sr-only">Filter games and categories</span><input type="search" data-browse-game-query aria-controls="browse-game-options" placeholder="Find Dragon Ball, One Piece, Digimon…" autocomplete="off"></label>
      <div id="browse-game-options" class="category-picker-options" role="group" aria-label="All games and categories">${games.map((game) => browseGameButton(game, browse, { directory: true })).join('')}</div>
      <p class="browse-game-empty" data-browse-game-empty hidden>No matching category.</p>
    </section>
  </div>`;
}

function gameChooser(state, browse, catalogGames) {
  // catalog-v2 B1: flagship games (Pokémon/Magic/Yu-Gi-Oh!) are provider
  // 'tcgcsv' too now, so the primary/directory split can no longer use
  // provider alone -- `flagship` marks the fixed CATALOG_GAMES entries that
  // always stay in the quick-chip row, everything else is the searchable
  // TCGCSV category directory.
  const publicGames = catalogGames.filter((game) => game.flagship);
  const selected = catalogGame(browse.game, catalogGames);
  const quickGames = publicGames.slice(0, 6);
  if (selected?.provider === 'tcgcsv' && !selected.flagship) quickGames.push(selected);
  const categoryCount = catalogGames.filter((game) => !game.flagship).length;
  return `<section class="browse-game-chooser" aria-labelledby="browse-game-heading">
    <div class="section-heading compact"><div><p class="eyebrow">Browse</p><h2 id="browse-game-heading">Popular games</h2><p class="section-detail">Choose a game, then narrow to a set and exact printing.</p></div><button class="button ghost small" type="button" data-action="open-category-picker">View All <span aria-hidden="true">·</span> ${categoryCount}</button></div>
    <div class="discover-category-grid" role="group" aria-label="Popular games">${quickGames.map((game) => browseGameTile(game, browse)).join('')}</div>
  </section>`;
}

function discoverLanding(state) {
  const browse = { game: 'all', ...state.discover };
  const games = mergeCatalogGames(browse.games);
  const popular = games.filter((game) => game.flagship).slice(0, 6);
  const recent = Array.isArray(browse.recentlyViewed) ? browse.recentlyViewed.slice(0, 4) : [];
  const releases = [...(browse.sets || [])]
    .filter((set) => set?.externalId && set?.gameId)
    .sort((left, right) => String(right.releasedAt || right.year || '').localeCompare(String(left.releasedAt || left.year || '')))
    .slice(0, 4);
  const setShelf = (title, sets) => sets.length ? `<section class="discover-shelf"><div class="section-heading compact"><div><p class="eyebrow">Continue browsing</p><h2>${escapeHTML(title)}</h2></div></div><div class="browse-set-grid">${sets.map((set) => setTile(set, games, browse.setCovers || {})).join('')}</div></section>` : '';
  return `<section class="discover-landing" aria-labelledby="popular-games-title">
    <div class="section-heading compact"><div><p class="eyebrow">Browse</p><h2 id="popular-games-title">Popular games</h2><p class="section-detail">Start with a category, then choose the exact item.</p></div><button class="button ghost small" type="button" data-action="open-category-picker">View All</button></div>
    <div class="discover-category-grid" role="group" aria-label="Popular games">${popular.map((game) => browseGameTile(game, browse)).join('')}</div>
  </section>${setShelf('Recently viewed', recent)}${setShelf('New releases', releases)}`;
}

function setTile(set, games, covers = {}) {
  const count = Number.isFinite(Number(set.cardCount)) ? `${Number(set.cardCount).toLocaleString()} cards` : 'Card count pending';
  const identity = [set.code, set.year, count].filter(Boolean).join(' · ');
  const cover = safeImageUrl(covers[set.id] || set.image || '');
  const gameName = set.game || catalogGame(set.gameId, games)?.name || set.gameId;
  const art = externalImage({ name: `${set.name || gameName} set cover`, image: cover, game: gameName, category: 'card' }, 'browse-set-art');
  return `<button class="browse-set-tile" type="button" data-action="open-browse-set" data-game="${escapeAttribute(set.gameId)}" data-set-id="${escapeAttribute(set.externalId)}">
    ${art}
    <span class="browse-set-copy">
    <span class="browse-set-game">${escapeHTML(gameName)}</span>
    <strong>${escapeHTML(set.name)}</strong>
    <small>${escapeHTML(identity)}</small>
    ${set.series ? `<span>${escapeHTML(set.series)}</span>` : ''}
    </span>
  </button>`;
}

function browseGroupBy(browse) {
  const modes = browse.game === 'all' ? ['game', 'year', 'none'] : ['family', 'year', 'none'];
  const requested = String(browse.groupBy || '');
  return { modes, groupBy: modes.includes(requested) ? requested : modes[0] };
}

const GROUP_MODE_LABELS = Object.freeze({ family: 'Set family', game: 'Game', year: 'Year', none: 'No grouping' });

function browseYearFilter(browse) {
  const years = catalogSetYears(browse.sets || []);
  if (!years.length) return '';
  const selected = new Set((browse.years || []).map(String));
  return `<details class="browse-year-filter" ${selected.size ? 'open' : ''}><summary>Years${selected.size ? ` · ${selected.size} selected` : ''}</summary>
    <div class="browse-year-options" role="group" aria-label="Filter sets by year">${years.map((year) => `<label><input type="checkbox" data-browse-year value="${escapeAttribute(year)}" ${selected.has(year) ? 'checked' : ''}><span>${escapeHTML(year)}</span></label>`).join('')}</div>
  </details>`;
}

function browseGameHeader(browse, games) {
  const game = catalogGame(browse.game, games);
  const name = game?.name || browse.game;
  const eyebrow = game?.provider === 'tcgcsv' ? 'Catalog category' : 'Catalog';
  return `<nav class="browse-breadcrumbs" aria-label="Browse path"><button type="button" data-action="browse-all-games">Discover</button><span>/</span><strong>${escapeHTML(name)}</strong></nav>
    <div class="browse-set-heading"><div><p class="eyebrow">${escapeHTML(eyebrow)}</p><h2>${escapeHTML(name)}</h2></div><button class="button ghost small" type="button" data-action="browse-all-games">All games</button></div>`;
}

// The image representing a sub-group is the cover of its most recent set,
// chosen by the same product-derived cover rules as individual tiles.
function groupHeaderArt(group, covers) {
  const recent = [...group.sets].sort((left, right) =>
    String(right.releasedAt || right.year || '').localeCompare(String(left.releasedAt || left.year || '')))[0];
  const art = safeImageUrl(recent ? covers[recent.id] || recent.image || '' : '');
  return art ? `<img class="browse-set-group-art" src="${escapeAttribute(art)}" data-external-image alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
}

function browseSetSections(visible, games, groupBy, covers = {}) {
  const grid = (sets) => `<div class="browse-set-grid">${sets.map((set) => setTile(set, games, covers)).join('')}</div>`;
  if (groupBy === 'none') return grid(visible);
  const groups = groupCatalogSets(visible, groupBy);
  if (groups.length <= 1) return grid(visible);
  return groups.map((group) => `<details class="browse-set-group" open><summary>${groupHeaderArt(group, covers)}<strong>${escapeHTML(group.name)}</strong><span>${group.sets.length.toLocaleString()} ${group.sets.length === 1 ? 'set' : 'sets'}</span></summary>${grid(group.sets)}</details>`).join('');
}

function renderBrowseSets(state, browse) {
  const games = mergeCatalogGames(browse.games);
  if (browse.game === 'all') return gameChooser(state, browse, games);
  const sets = filterCatalogSets(browse.sets || [], { query: browse.query, sort: browse.sort, scope: browse.scope, years: browse.years });
  const limit = Math.max(BROWSE_SETS_PAGE_SIZE, Number(browse.setLimit) || BROWSE_SETS_PAGE_SIZE);
  const visible = sets.slice(0, limit);
  const remaining = sets.length - visible.length;
  const { modes, groupBy } = browseGroupBy(browse);
  const resultLabel = browse.loading
    ? 'Loading complete set indexes…'
    : remaining > 0
      ? `Showing ${visible.length.toLocaleString()} of ${sets.length.toLocaleString()} sets`
      : `${sets.length.toLocaleString()} ${sets.length === 1 ? 'set' : 'sets'}`;
  const rightsNote = 'Browse the available catalog by category, set, product, and finish. Availability and price coverage vary by item.';
  return `${browseGameHeader(browse, games)}
    <div class="browse-controls">
      <label class="browse-query"><span class="sr-only">Search sets</span><input type="search" data-browse-set-query value="${escapeAttribute(browse.query || '')}" placeholder="Search sets or codes…" autocomplete="off"></label>
      <label><span class="sr-only">Set type</span><select data-browse-set-scope><option value="all" ${browse.scope === 'all' ? 'selected' : ''}>All sets</option><option value="main" ${browse.scope === 'main' ? 'selected' : ''}>Main sets</option><option value="supplemental" ${browse.scope === 'supplemental' ? 'selected' : ''}>Supplemental</option></select></label>
      <label><span class="sr-only">Sort sets</span><select data-browse-set-sort><option value="newest" ${browse.sort === 'newest' ? 'selected' : ''}>Newest</option><option value="alpha" ${browse.sort === 'alpha' ? 'selected' : ''}>A–Z</option><option value="largest" ${browse.sort === 'largest' ? 'selected' : ''}>Largest</option></select></label>
      <label><span class="sr-only">Group sets</span><select data-browse-set-group>${modes.map((mode) => `<option value="${mode}" ${groupBy === mode ? 'selected' : ''}>${GROUP_MODE_LABELS[mode]}</option>`).join('')}</select></label>
      ${browseYearFilter(browse)}
    </div>
    ${browseWarnings(browse)}
    <div class="browse-results-head"><strong>${escapeHTML(resultLabel)}</strong><span>Every matching set remains reachable.</span></div>
    ${browse.loading ? '<div class="set-loading" role="status"><span></span><span></span><span></span><span class="sr-only">Loading sets</span></div>' : visible.length ? `${browseSetSections(visible, games, groupBy, browse.setCovers || {})}${remaining > 0 ? `<div class="button-row centered catalog-result-paging"><button class="button secondary" type="button" data-action="load-more-browse-sets">Show ${Math.min(BROWSE_SETS_PAGE_SIZE, remaining)} more</button></div>` : ''}` : emptyState('No matching sets', 'Try another name, code, game, set type, or year.', '<button class="button ghost" type="button" data-action="clear-browse-filters">Clear filters</button>')}
    <p class="fine-print browse-rights-note">${escapeHTML(rightsNote)}</p>`;
}

function browseProductKindTabs(browse, counts) {
  if (!counts.sealed || !counts.cards) return '';
  const tabs = [
    ['cards', 'Cards', counts.cards],
    ['sealed', 'Sealed & other', counts.sealed],
    ['all', 'All', counts.cards + counts.sealed]
  ];
  return `<div class="browse-product-tabs" role="group" aria-label="Product type">${tabs.map(([kind, label, count]) =>
    `<button type="button" data-action="set-browse-product-kind" data-kind="${kind}" aria-pressed="${browse.productKind === kind}">${label}<small>${count.toLocaleString()}</small></button>`).join('')}</div>`;
}

function productFamilyName(item, fallback) {
  const stripped = String(item?.name || '')
    .replace(/\b\d+\s*[-–]?\s*(?:box|pack)s?\s+case\b/gi, '')
    .replace(/\b(?:booster\s*)?(?:pack|box|display|case|bundle|deck|tin|collection)\b/gi, '')
    .replace(/[·:|\-–—]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 3 ? stripped : fallback || 'Product family';
}

function productFamilyGroups(entries, state, selectedSet) {
  const groups = new Map();
  for (const entry of entries) {
    const name = productFamilyName(entry.item, selectedSet?.name);
    const key = name.toLocaleLowerCase();
    const group = groups.get(key) || { name, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].map((group, groupIndex) => `<section class="product-family" aria-labelledby="product-family-${groupIndex}">
    <div class="product-family-heading"><div><p class="eyebrow">Product family</p><h3 id="product-family-${groupIndex}">${escapeHTML(group.name)}</h3></div><span>${group.entries.length} ${group.entries.length === 1 ? 'format' : 'formats'}</span></div>
    <div class="result-list gallery browse-product-grid">${group.entries.map(({ item, index }) => resultCard(item, index, state, 'gallery', { scope: 'browse', matchBadge: false, compact: true, showForecastNotes: false })).join('')}</div>
  </section>`).join('');
}

function browseProductSortOptions(products, selected) {
  const hasPrice = products.some((item) => item.price !== null && item.price !== '' && Number.isFinite(Number(item.price)));
  const hasNumber = products.some((item) => String(item.number || '').trim());
  const supported = new Set(['name', 'name-desc']);
  if (hasNumber) supported.add('number').add('number-desc');
  if (hasPrice) supported.add('price-desc').add('price-asc');
  const sort = supported.has(selected) ? selected : hasNumber ? 'number' : 'name';
  const options = [
    ['price-desc', 'Price high to low'], ['price-asc', 'Price low to high'],
    ['number', 'Collector # low to high'], ['number-desc', 'Collector # high to low'],
    ['name', 'Name A–Z'], ['name-desc', 'Name Z–A']
  ].filter(([value]) => supported.has(value));
  return { sort, hasPrice, options };
}

function renderBrowseProducts(state, browse) {
  const selectedSet = browse.selectedSet || (browse.sets || []).find((set) => set.externalId === browse.setId && set.gameId === browse.game);
  const products = browse.products || [];
  const counts = { sealed: products.filter((product) => product.productKind === 'sealed').length };
  counts.cards = products.length - counts.sealed;
  const kind = counts.sealed && counts.cards ? browse.productKind || 'cards' : counts.sealed ? 'sealed' : 'cards';
  const sortControl = browseProductSortOptions(products.filter((product) => kind === 'all' || (kind === 'sealed' ? product.productKind === 'sealed' : product.productKind !== 'sealed')), browse.productSort);
  const filtered = filterCatalogProducts(products, { query: browse.productQuery, sort: sortControl.sort, kind });
  const indexed = filtered.map((item) => ({ item, index: products.indexOf(item) }));
  const limit = Math.max(BROWSE_PRODUCTS_PAGE_SIZE, Number(browse.limit) || BROWSE_PRODUCTS_PAGE_SIZE);
  const visible = indexed.slice(0, limit);
  const localRemaining = indexed.length - visible.length;
  const declaredTotal = Math.max(products.length, Number(browse.productTotal) || 0);
  const remoteRemaining = browse.productNextCursor ? Math.max(1, declaredTotal - products.length) : 0;
  const remaining = localRemaining > 0 ? localRemaining : remoteRemaining;
  const title = selectedSet?.name || browse.setId;
  const game = catalogGame(browse.game, browse.games);
  const noun = kind === 'sealed'
    ? ['sealed product', 'sealed products']
    : kind === 'cards' || !counts.sealed ? ['card', 'cards'] : ['item', 'items'];
  return `<nav class="browse-breadcrumbs" aria-label="Browse path"><button type="button" data-action="browse-all-games">Discover</button><span>/</span><button type="button" data-action="select-browse-game" data-game="${escapeAttribute(browse.game)}">${escapeHTML(game?.shortName || browse.game)}</button><span>/</span><strong>${escapeHTML(title)}</strong></nav>
    <div class="browse-set-heading"><div><p class="eyebrow">${escapeHTML([selectedSet?.code, selectedSet?.year].filter(Boolean).join(' · ') || game?.name || '')}</p><h2>${escapeHTML(title)}</h2><p>${browse.loading ? 'Loading the first products…' : declaredTotal > products.length ? `${products.length.toLocaleString()} of ${declaredTotal.toLocaleString()} products loaded` : `${filtered.length.toLocaleString()} ${escapeHTML(filtered.length === 1 ? noun[0] : noun[1])}`}</p></div><button class="button ghost small" type="button" data-action="browse-back-sets">All sets</button></div>
    ${browseProductKindTabs({ ...browse, productKind: kind }, counts)}
    <div class="browse-controls products">
      <label class="browse-query"><span class="sr-only">Search this set</span><input type="search" data-browse-product-query value="${escapeAttribute(browse.productQuery || '')}" placeholder="Search this set…" autocomplete="off"></label>
      <label><span class="sr-only">Sort items</span><select data-browse-product-sort>${sortControl.options.map(([value, label]) => `<option value="${value}" ${sortControl.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    ${sortControl.hasPrice ? '' : '<p class="sort-availability">Price sorting is unavailable because these results have no verified prices.</p>'}
    ${browseWarnings(browse)}
    ${browse.loading ? '<div class="result-loading" role="status"><span></span><span></span><span></span><span class="sr-only">Loading cards</span></div>' : visible.length ? `${kind === 'sealed' ? productFamilyGroups(visible, state, selectedSet) : `<div class="result-list gallery browse-product-grid">${visible.map(({ item, index }) => resultCard(item, index, state, 'gallery', { scope: 'browse', matchBadge: false, compact: true, showForecastNotes: false })).join('')}</div>`}${remaining > 0 ? `<div class="button-row centered catalog-result-paging"><button class="button secondary" type="button" data-action="load-more-browse-products" ${browse.productsLoadingMore ? 'disabled' : ''}>${browse.productsLoadingMore ? 'Loading more…' : `Load ${Math.min(BROWSE_PRODUCTS_PAGE_SIZE, remaining)} more`}</button></div>` : ''}` : `${emptyState(`No matching ${noun[1]}`, browse.error ? 'Retry the catalog request.' : remoteRemaining ? 'Load more products or try another name, collector number, or rarity.' : 'Try another name, collector number, or rarity.', browse.error ? '<button class="button" type="button" data-action="retry-browse">Retry</button>' : '<button class="button ghost" type="button" data-action="clear-browse-product-query">Clear search</button>')}${remoteRemaining > 0 ? `<div class="button-row centered catalog-result-paging"><button class="button secondary" type="button" data-action="load-more-browse-products" ${browse.productsLoadingMore ? 'disabled' : ''}>${browse.productsLoadingMore ? 'Loading more…' : `Load ${Math.min(BROWSE_PRODUCTS_PAGE_SIZE, remoteRemaining)} more`}</button></div>` : ''}`}`;
}

function renderBrowse(state) {
  const browse = { game: 'all', setId: '', query: '', sort: 'newest', scope: 'all', years: [], groupBy: '', setLimit: BROWSE_SETS_PAGE_SIZE, productQuery: '', productSort: 'price-desc', productKind: 'cards', productNextCursor: '', productTotal: 0, productsLoadingMore: false, sets: [], products: [], warnings: [], ...state.discover };
  return `${browse.setId ? '' : discoverHeader(state, 'browse')}${browse.setId ? renderBrowseProducts(state, browse) : renderBrowseSets(state, browse)}${categoryPickerOverlay(browse, mergeCatalogGames(browse.games))}`;
}

const FILTER_LABELS = Object.freeze({
  setName: 'Set or series', number: 'Card number', variant: 'Variant or finish',
  player: 'Player or character', year: 'Year', grade: 'Grade'
});

function activeSearchFilters(search, games) {
  const active = [];
  if (search.category && search.category !== 'all') active.push({ key: 'category', label: categoryLabel(search.category, games) });
  for (const [key, value] of Object.entries(search.filters || {})) {
    if (String(value || '').trim()) active.push({ key, label: `${FILTER_LABELS[key] || key}: ${value}` });
  }
  if (search.provider && search.provider !== 'all') active.push({ key: 'provider', label: 'Trading card data' });
  return active;
}

function hiddenSearchFilters(search) {
  const fields = [
    ['category', search.category || 'all'], ['provider', search.provider || 'all'],
    ...Object.entries(search.filters || {})
  ];
  return fields.map(([name, value]) => `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`).join('');
}

function searchFilterOverlay(search, state, count) {
  if (!state.discover?.searchFiltersOpen) return '';
  return `<div class="search-filter-layer">
    <button class="search-filter-scrim" type="button" data-action="close-search-filters" aria-label="Close filters"></button>
    <section class="search-filter-panel" role="dialog" aria-modal="true" aria-labelledby="search-filter-title">
      <header><div><p class="eyebrow">Discover</p><h2 id="search-filter-title">Filters${count ? ` · ${count} active` : ''}</h2></div><button class="icon-button" type="button" data-action="close-search-filters" aria-label="Close filters">×</button></header>
      <div class="discover-filter-grid"><label>Category<select name="category" form="catalog-search">${categoryOptions(search.category, state.discover?.games)}</select></label>${contextualFilters(search.category, search.filters, 'catalog-search')}<details class="data-source-control"><summary>Data source</summary><label>Market source<select name="provider" form="catalog-search">${providerOptions(search.provider)}</select></label><p>Automatic selection searches every enabled source and keeps partial results if one is unavailable.</p></details></div>
      <footer><button class="button ghost" type="button" data-action="clear-search-filters">Clear all</button><button class="button" type="submit" form="catalog-search">Show results</button></footer>
    </section>
  </div>`;
}

function searchSortContract(items, requested = 'relevance') {
  const hasPrice = items.some((item) => item.price !== null && item.price !== '' && Number.isFinite(Number(item.price)));
  const hasRelease = items.length > 0 && items.every((item) => Number.isFinite(Number(item.year || String(item.releasedAt || '').slice(0, 4))));
  const supported = new Set(['relevance', 'name', 'name-desc']);
  if (hasPrice) supported.add('price-desc').add('price-asc');
  if (hasRelease) supported.add('newest');
  const sort = supported.has(requested) ? requested : 'relevance';
  const options = [
    ['relevance', 'Best match'], ['name', 'Name A–Z'], ['name-desc', 'Name Z–A'],
    ['price-desc', 'Price high to low'], ['price-asc', 'Price low to high'], ['newest', 'Newest release']
  ].filter(([value]) => supported.has(value));
  return { sort, hasPrice, options };
}

function sortSearchResults(items, sort) {
  if (sort === 'relevance') return [...items];
  const price = (item) => item.price !== null && item.price !== '' && Number.isFinite(Number(item.price)) ? Number(item.price) : null;
  return [...items].sort((left, right) => {
    if (sort === 'name' || sort === 'name-desc') {
      const compared = String(left.name || '').localeCompare(String(right.name || ''));
      return sort === 'name-desc' ? -compared : compared;
    }
    if (sort === 'newest') return Number(right.year || String(right.releasedAt || '').slice(0, 4)) - Number(left.year || String(left.releasedAt || '').slice(0, 4));
    const leftPrice = price(left);
    const rightPrice = price(right);
    if (leftPrice === null) return 1;
    if (rightPrice === null) return -1;
    return sort === 'price-asc' ? leftPrice - rightPrice : rightPrice - leftPrice;
  });
}

function searchToolbar(search, state, view, sortContract, activeFilters) {
  return `<section class="discover-toolbar" aria-label="Search result controls">
    <div class="discover-toolbar-row"><button class="button secondary filter-trigger" type="button" data-action="open-search-filters">Filters <span>${activeFilters.length}</span></button>
      <label class="search-sort"><span class="sr-only">Sort results</span><select data-search-sort>${sortContract.options.map(([value, label]) => `<option value="${value}" ${sortContract.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <div class="view-toggle" role="group" aria-label="Result view"><button type="button" data-discover-view="gallery" aria-pressed="${view === 'gallery'}" aria-label="Gallery view">▦</button><button type="button" data-discover-view="list" aria-pressed="${view === 'list'}" aria-label="List view">☷</button></div>
    </div>
    ${activeFilters.length ? `<div class="active-filter-chips" aria-label="Applied filters">${activeFilters.map((filter) => `<button type="button" data-action="remove-search-filter" data-filter="${escapeAttribute(filter.key)}">${escapeHTML(filter.label)} <span aria-hidden="true">×</span><span class="sr-only">Remove filter</span></button>`).join('')}<button class="clear-filters" type="button" data-action="clear-search-filters">Clear all</button></div>` : ''}
    ${sortContract.hasPrice || !search.results.length ? '' : '<p class="sort-availability">Price sorting is unavailable because these results have no verified prices.</p>'}
  </section>`;
}

export function renderSearch(state) {
  if (state.featureFlags?.setBrowsing !== false && state.discover?.mode === 'browse') return renderBrowse(state);
  const search = { filters: {}, results: [], warnings: [], ...state.search };
  const manualCategory = ['sports', 'comics', 'slab', 'other'].includes(search.category);
  const view = DISCOVER_VIEWS.includes(search.view || state.settings?.discoverView) ? (search.view || state.settings.discoverView) : 'gallery';
  const activeFilters = activeSearchFilters(search, state.discover?.games);
  const hasIntent = Boolean(String(search.query || '').trim() || activeFilters.length || search.loading || search.results.length);
  const sortContract = searchSortContract(search.results, search.sort);
  const sortedResults = sortSearchResults(search.results, sortContract.sort);
  const resultLimit = Math.max(DISCOVER_RESULTS_PAGE_SIZE, Math.trunc(Number(search.limit) || DISCOVER_RESULTS_PAGE_SIZE));
  const visibleResults = sortedResults.slice(0, resultLimit);
  const resultCount = search.results.length > visibleResults.length
    ? `Showing ${visibleResults.length.toLocaleString()} of ${search.results.length.toLocaleString()} results`
    : `${search.results.length.toLocaleString()} result${search.results.length === 1 ? '' : 's'}`;
  return `${discoverHeader(state, 'search')}
    <form id="catalog-search" class="discover-search">
      <div class="search-command"><button class="search-image-button" type="button" data-action="start-single-scan" aria-label="Search from an image">▣</button><label class="sr-only" for="catalog-query">Search catalog</label><input id="catalog-query" name="query" type="search" required minlength="2" value="${escapeAttribute(search.query)}" placeholder="Search cards, sets, players, products, or set codes" autocomplete="off"><button class="search-clear" type="button" data-action="clear-search" aria-label="Clear search" ${search.query ? '' : 'hidden'}>×</button><button class="button" ${search.loading ? 'disabled' : ''}>${search.loading ? 'Searching…' : 'Search'}</button></div>
      ${recentSearches({ ...state, search })}
      ${state.discover?.searchFiltersOpen ? '' : hiddenSearchFilters(search)}
    </form>
    ${hasIntent ? searchToolbar(search, state, view, sortContract, activeFilters) : discoverLanding(state)}
    ${search.cached ? '<p class="fine-print search-status">Showing a recent result cached on this device.</p>' : ''}
    ${search.warnings.length ? `<div class="search-warning" role="status"><strong>Some sources were unavailable.</strong>${search.warnings.map((warning) => `<span>${escapeHTML(warning)}</span>`).join('')}<small>Your search and filters are unchanged.</small><button class="button ghost small" type="button" data-action="retry-search">Retry search</button></div>` : ''}
    ${!hasIntent ? '' : manualCategory ? `${emptyState(`Create a precise ${search.category} record`, 'There is no universal rights-cleared catalog for this category. Add the identity and value you can verify.', `<button class="button" type="button" data-action="custom-holding" data-category="${escapeAttribute(search.category)}">Create custom item</button>`)}` : `<div class="discover-results-head"><div><strong>${search.loading ? 'Searching sources…' : resultCount}</strong><span>${search.query ? `for “${escapeHTML(search.query)}”` : 'filtered catalog'}</span></div></div>${search.loading ? '<div class="result-loading" role="status"><span></span><span></span><span></span><span class="sr-only">Searching catalog sources</span></div>' : `${resultGroups(visibleResults, { ...state, search }, view)}${resultPaging(search, visibleResults.length)}`}`}${searchFilterOverlay(search, state, activeFilters.length)}${categoryPickerOverlay(state.discover || {}, mergeCatalogGames(state.discover?.games))}`;
}
