import { INSIGHTS_HORIZONS, INSIGHTS_VIEWS } from './insights.js';

const APP_ORIGIN = 'https://collectfolio.local';
const PORTFOLIO_SECTIONS = new Set(['holdings', 'sets', 'watchlist']);
const DISCOVER_CATEGORIES = new Set(['all', 'pokemon', 'magic', 'yugioh', 'sports', 'comics', 'slab', 'other']);
const DISCOVER_PROVIDERS = new Set(['all', 'pokemon', 'scryfall', 'ygoprodeck', 'tcgcsv']);
const DISCOVER_MODES = new Set(['search', 'browse']);
const BROWSE_SET_SORTS = new Set(['newest', 'alpha', 'largest']);
const BROWSE_SET_SCOPES = new Set(['all', 'main', 'supplemental']);
const BROWSE_PRODUCT_SORTS = new Set(['price-desc', 'price-asc', 'number', 'number-desc', 'name', 'name-desc']);
const BROWSE_PRODUCT_KINDS = new Set(['cards', 'sealed', 'all']);
const TCGCSV_CATEGORY = /^tcgcsv-category-\d+$/;

function asURL(input = '/') {
  if (input instanceof URL) return input;
  if (typeof input === 'object' && input) {
    return new URL(`${input.pathname || '/'}${input.search || ''}`, APP_ORIGIN);
  }
  return new URL(String(input || '/'), APP_ORIGIN);
}

function bounded(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function entityId(value) {
  try {
    return bounded(decodeURIComponent(value), 500);
  } catch {
    return '';
  }
}

function route(key, legacyView, canonicalPath, details = {}) {
  return { key, legacyView, canonicalPath, ...details };
}

function browseSegment(value, max = 120) {
  if (value === null || value === undefined || value === '') return '';
  const decoded = entityId(value);
  return decoded && !decoded.includes('/') ? bounded(decoded, max) : '';
}

function discoverCategory(value) {
  return DISCOVER_CATEGORIES.has(value) || TCGCSV_CATEGORY.test(value) ? value : 'all';
}

function browsePath(browse = {}) {
  const game = browse.game && browse.game !== 'all' ? browseSegment(browse.game, 50) : '';
  const setId = game ? browseSegment(browse.setId, 120) : '';
  const base = setId
    ? `/discover/${encodeURIComponent(game)}/${encodeURIComponent(setId)}`
    : game
      ? `/discover/${encodeURIComponent(game)}`
      : '/discover/browse';
  const params = new URLSearchParams();
  const setSort = BROWSE_SET_SORTS.has(browse.sort) ? browse.sort : 'newest';
  const setScope = BROWSE_SET_SCOPES.has(browse.scope) ? browse.scope : 'all';
  const productSort = BROWSE_PRODUCT_SORTS.has(browse.productSort) ? browse.productSort : 'price-desc';
  const productKind = BROWSE_PRODUCT_KINDS.has(browse.productKind) ? browse.productKind : 'cards';
  if (!setId && setSort !== 'newest') params.set('sort', setSort);
  if (!setId && setScope !== 'all') params.set('scope', setScope);
  if (setId && productSort !== 'price-desc') params.set('sort', productSort);
  if (setId && productKind !== 'cards') params.set('type', productKind);
  return `${base}${params.size ? `?${params}` : ''}`;
}

function discoverRoute(url, pathname = '/discover') {
  const requestedMode = bounded(url.searchParams.get('mode'), 30) || 'search';
  const suffix = pathname.slice('/discover'.length).split('/').filter(Boolean);
  const pathRequestsBrowse = suffix.length > 0;
  const mode = pathRequestsBrowse || requestedMode === 'browse' ? 'browse' : 'search';
  if (mode === 'browse') {
    const requestedPathGame = suffix[0] && suffix[0] !== 'browse' ? browseSegment(suffix[0], 50) : '';
    const pathGame = ['tcgcsv', 'full-catalog'].includes(requestedPathGame) ? '' : requestedPathGame;
    const pathSet = pathGame && suffix[1] ? browseSegment(suffix[1]) : '';
    const game = pathGame || browseSegment(url.searchParams.get('game'), 50) || 'all';
    const setId = game === 'all' ? '' : pathSet || browseSegment(url.searchParams.get('set'));
    const requestedSort = bounded(url.searchParams.get('sort'), 30);
    const requestedScope = bounded(url.searchParams.get('scope'), 30);
    const requestedType = bounded(url.searchParams.get('type'), 20);
    const sort = setId
      ? (BROWSE_PRODUCT_SORTS.has(requestedSort) ? requestedSort : 'price-desc')
      : (BROWSE_SET_SORTS.has(requestedSort) ? requestedSort : 'newest');
    const scope = BROWSE_SET_SCOPES.has(requestedScope) ? requestedScope : 'all';
    const productKind = setId && BROWSE_PRODUCT_KINDS.has(requestedType) ? requestedType : 'cards';
    const browse = { game, setId, sort: setId ? 'newest' : sort, scope, productSort: setId ? sort : 'price-desc', productKind };
    return route('discover', 'search', browsePath(browse), {
      mode: 'browse',
      browse,
      unsupported: suffix.length > 2 || (requestedMode && !DISCOVER_MODES.has(requestedMode)) ? 'discover-browse-path' : ''
    });
  }
  const query = bounded(url.searchParams.get('q'));
  const requestedCategory = bounded(url.searchParams.get('category'), 30) || 'all';
  const requestedProvider = bounded(url.searchParams.get('provider'), 30) || 'all';
  const category = discoverCategory(requestedCategory);
  const provider = DISCOVER_PROVIDERS.has(requestedProvider) ? requestedProvider : 'all';
  const params = new URLSearchParams({ mode: 'search' });
  if (query) params.set('q', query);
  if (category !== 'all') params.set('category', category);
  if (provider !== 'all') params.set('provider', provider);
  return route('discover', 'search', `/discover?${params}`, {
    mode: 'search',
    search: { query, category, provider },
    unsupported: DISCOVER_MODES.has(requestedMode) ? '' : `discover-${requestedMode}`
  });
}

function portfolioRoute(url) {
  const requested = bounded(url.searchParams.get('view'), 30) || 'holdings';
  const section = PORTFOLIO_SECTIONS.has(requested) ? requested : 'holdings';
  return route('portfolio', 'portfolio', `/portfolio?view=${section}`, {
    portfolioSection: section,
    unsupported: PORTFOLIO_SECTIONS.has(requested) ? '' : `portfolio-${requested}`
  });
}

function insightsRoute(url) {
  const requested = bounded(url.searchParams.get('view'), 40) || 'forecasts';
  const view = INSIGHTS_VIEWS.includes(requested) ? requested : 'forecasts';
  const requestedHorizon = Number(url.searchParams.get('horizon'));
  const horizon = INSIGHTS_HORIZONS.includes(requestedHorizon) ? requestedHorizon : 90;
  const params = new URLSearchParams({ view });
  if (view === 'forecasts' && horizon !== 90) params.set('horizon', String(horizon));
  return route('insights', 'insights', `/insights?${params}`, {
    insights: { view, horizon },
    unsupported: INSIGHTS_VIEWS.includes(requested) ? '' : `insights-${requested}`
  });
}

export function parseAppRoute(input = '/') {
  const url = asURL(input);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/') return route('overview', 'home', '/');
  if (pathname === '/portfolio') return portfolioRoute(url);
  if (pathname === '/discover' || pathname.startsWith('/discover/')) return discoverRoute(url, pathname);
  if (pathname === '/insights') return insightsRoute(url);
  if (pathname === '/settings') return route('settings', 'profile', '/settings');
  if (pathname === '/add') {
    const review = url.searchParams.get('step') === 'review';
    return route(review ? 'add-review' : 'add', review ? 'scan' : 'add', review ? '/add?step=review' : '/add');
  }

  const cardMatch = pathname.match(/^\/cards\/([^/]+)$/);
  if (cardMatch) {
    const id = entityId(cardMatch[1]);
    if (id) return route('card-detail', 'detail', `/cards/${encodeURIComponent(id)}`, { entityId: id, origin: 'search' });
  }
  const holdingMatch = pathname.match(/^\/holdings\/([^/]+)$/);
  if (holdingMatch) {
    const id = entityId(holdingMatch[1]);
    if (id) return route('holding-detail', 'detail', `/holdings/${encodeURIComponent(id)}`, { entityId: id, origin: 'portfolio' });
  }
  return route('overview', 'home', '/', { notFound: pathname });
}

function discoverPath(search = {}, discover = {}) {
  if (discover.mode === 'browse') return browsePath(discover);
  const params = new URLSearchParams({ mode: 'search' });
  const query = bounded(search.query);
  const category = discoverCategory(search.category);
  const provider = DISCOVER_PROVIDERS.has(search.provider) ? search.provider : 'all';
  if (query) params.set('q', query);
  if (category !== 'all') params.set('category', category);
  if (provider !== 'all') params.set('provider', provider);
  return `/discover?${params}`;
}

function detailPath(detail = {}) {
  const selected = detail || {};
  if (selected.holding?.id) return `/holdings/${encodeURIComponent(selected.holding.id)}`;
  const provider = bounded(selected.item?.provider || selected.catalogRef?.provider, 50).toLowerCase();
  const externalId = bounded(selected.item?.externalId || selected.catalogRef?.externalId, 400);
  const providerId = provider && externalId ? `${provider}:${externalId}` : '';
  const id = selected.watched?.watchKey
    || providerId
    || selected.catalogRef?.canonicalVariantId
    || selected.catalogRef?.watchKey
    || selected.item?.id;
  return id ? `/cards/${encodeURIComponent(id)}` : '/portfolio?view=holdings';
}

function insightsPath(insights = {}) {
  const view = INSIGHTS_VIEWS.includes(insights.view) ? insights.view : 'forecasts';
  const horizon = INSIGHTS_HORIZONS.includes(Number(insights.horizon)) ? Number(insights.horizon) : 90;
  const params = new URLSearchParams({ view });
  if (view === 'forecasts' && horizon !== 90) params.set('horizon', String(horizon));
  return `/insights?${params}`;
}

export function appRouteForLegacyView(view, state = {}, context = {}) {
  const portfolioSection = context.portfolioSection || state.portfolio?.section || 'holdings';
  const paths = {
    home: '/',
    search: discoverPath(context.search || state.search, context.discover || { mode: 'search' }),
    add: '/add',
    scan: '/add?step=review',
    portfolio: portfolioSection === 'forecasts'
      ? insightsPath(context.insights || state.insights)
      : `/portfolio?view=${PORTFOLIO_SECTIONS.has(portfolioSection) ? portfolioSection : 'holdings'}`,
    insights: insightsPath(context.insights || state.insights),
    profile: '/settings',
    detail: detailPath(context.detail)
  };
  const resolved = parseAppRoute(paths[view] || '/');
  return view === 'detail' && context.detail?.origin
    ? { ...resolved, origin: context.detail.origin }
    : resolved;
}

export function routeStatePatch(appRoute, state = {}) {
  const patch = { activeView: appRoute.legacyView, route: appRoute };
  if (appRoute.portfolioSection) {
    patch.portfolio = { ...state.portfolio, section: appRoute.portfolioSection };
  }
  if (appRoute.insights) {
    patch.insights = { ...state.insights, ...appRoute.insights };
  }
  if (appRoute.search) {
    const changed = ['query', 'category', 'provider'].some((key) =>
      String(state.search?.[key] ?? '') !== String(appRoute.search[key] ?? '')
    );
    patch.search = {
      ...state.search,
      ...appRoute.search,
      ...(changed ? { loading: false, results: [], warnings: [], cached: false } : {})
    };
    patch.discover = { ...state.discover, mode: 'search' };
  }
  if (appRoute.browse) {
    const current = state.discover || {};
    const gameChanged = current.game !== appRoute.browse.game;
    const setChanged = gameChanged || current.setId !== appRoute.browse.setId;
    patch.discover = {
      ...current,
      ...appRoute.browse,
      mode: 'browse',
      query: gameChanged ? '' : current.query || '',
      setLimit: gameChanged ? 120 : current.setLimit || 120,
      productQuery: setChanged ? '' : current.productQuery || '',
      limit: setChanged ? 120 : current.limit || 120,
      loading: false,
      error: '',
      warnings: [],
      ...(gameChanged ? { sets: [], loadedGame: '' } : {}),
      ...(setChanged ? { products: [], selectedSet: null, loadedSetId: '' } : {})
    };
  }
  return patch;
}

export function primaryDestination(appRoute) {
  if (appRoute.key === 'add-review') return 'add';
  if (appRoute.key === 'card-detail') return 'discover';
  if (appRoute.key === 'holding-detail') return 'portfolio';
  return appRoute.key;
}

export function currentAppPath(input = '/') {
  const url = asURL(input);
  return `${url.pathname || '/'}${url.search || ''}`;
}
