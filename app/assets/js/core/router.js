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

// SEO-friendly card URLs (Kevin 2026-08-18): catalog cards address as
// /cards/<set-name-product-name>-<categoryId>-<groupId>-<productId>. The
// trailing numeric triple is the identity; the slug prefix is decorative
// and never trusted. Legacy /cards/tcgcsv:c:g:p links (and watch-key /
// variant-UUID links, which always contain ':') keep resolving unchanged.
const CARD_SLUG_ID = /^(?:[^:]*-)?(\d+)-(\d+)-(\d+)$/;

// SEO-friendly browse-set URLs (Kevin 2026-08-18): TCGCSV sets address as
// /discover/<game>/<set-name>-<categoryId>-<groupId>. The trailing numeric
// pair is the identity; the slug prefix is decorative and never trusted.
// Legacy /discover/<game>/<categoryId>:<groupId> links (which always
// contain ':') keep resolving unchanged.
const SET_SLUG_ID = /^(?:[^:]*-)?(\d+)-(\d+)$/;
const TCGCSV_SET_ID = /^\d+:\d+$/;

export function cardSlug(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
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

// The path segment for a selected set: a decorated slug for TCGCSV
// category:group ids when a set name is available (from an already-parsed
// slug, the selected set, or the loaded sets list), otherwise the raw id.
export function browseSetSegment(browse = {}, setId = '') {
  if (!TCGCSV_SET_ID.test(setId)) return encodeURIComponent(setId);
  const idTail = setId.replace(':', '-');
  const slug = bounded(browse.setSlug, 160);
  if (slug && (slug === idTail || slug.endsWith(`-${idTail}`)) && SET_SLUG_ID.test(slug)) return encodeURIComponent(slug);
  const named = browse.selectedSet?.externalId === setId
    ? browse.selectedSet
    : (Array.isArray(browse.sets) ? browse.sets.find((set) => set.externalId === setId) : null);
  const prefix = cardSlug(named?.name || '');
  return encodeURIComponent(prefix ? `${prefix}-${idTail}` : setId);
}

export function browsePath(browse = {}) {
  const game = browse.game && browse.game !== 'all' ? browseSegment(browse.game, 50) : '';
  const setId = game ? browseSegment(browse.setId, 120) : '';
  const base = setId
    ? `/sets/${browseSetSegment(browse, setId)}`
    : game
      ? `/games/${encodeURIComponent(game)}`
      : '/discover/browse';
  const params = new URLSearchParams();
  const setSort = BROWSE_SET_SORTS.has(browse.sort) ? browse.sort : 'newest';
  const setScope = BROWSE_SET_SCOPES.has(browse.scope) ? browse.scope : 'all';
  const productSort = BROWSE_PRODUCT_SORTS.has(browse.productSort) ? browse.productSort : 'price-desc';
  const productKind = BROWSE_PRODUCT_KINDS.has(browse.productKind) ? browse.productKind : 'all';
  if (setId) params.set('game', game);
  if (!setId && setSort !== 'newest') params.set('sort', setSort);
  if (!setId && setScope !== 'all') params.set('scope', setScope);
  if (setId && productSort !== 'price-desc') params.set('sort', productSort);
  if (setId && productKind !== 'all') params.set('type', productKind);
  return `${base}${params.size ? `?${params}` : ''}`;
}

function discoverRoute(url, pathname = '/discover') {
  const requestedMode = bounded(url.searchParams.get('mode'), 30) || 'search';
  const suffix = pathname === '/discover/search'
    ? []
    : pathname.slice('/discover'.length).split('/').filter(Boolean);
  const pathRequestsBrowse = suffix.length > 0;
  const mode = pathRequestsBrowse || requestedMode === 'browse' ? 'browse' : 'search';
  if (mode === 'browse') {
    const requestedPathGame = suffix[0] && suffix[0] !== 'browse' ? browseSegment(suffix[0], 50) : '';
    const pathGame = ['tcgcsv', 'full-catalog'].includes(requestedPathGame) ? '' : requestedPathGame;
    const rawPathSet = pathGame && suffix[1] ? browseSegment(suffix[1], 160) : '';
    const setMatch = rawPathSet && !rawPathSet.includes(':') ? SET_SLUG_ID.exec(rawPathSet) : null;
    const pathSet = setMatch ? `${setMatch[1]}:${setMatch[2]}` : rawPathSet;
    const game = pathGame || browseSegment(url.searchParams.get('game'), 50) || 'all';
    const setId = game === 'all' ? '' : pathSet || browseSegment(url.searchParams.get('set'));
    const setSlug = setMatch && setId === pathSet ? rawPathSet : '';
    const requestedSort = bounded(url.searchParams.get('sort'), 30);
    const requestedScope = bounded(url.searchParams.get('scope'), 30);
    const requestedType = bounded(url.searchParams.get('type'), 20);
    const sort = setId
      ? (BROWSE_PRODUCT_SORTS.has(requestedSort) ? requestedSort : 'price-desc')
      : (BROWSE_SET_SORTS.has(requestedSort) ? requestedSort : 'newest');
    const scope = BROWSE_SET_SCOPES.has(requestedScope) ? requestedScope : 'all';
    const productKind = setId && BROWSE_PRODUCT_KINDS.has(requestedType) ? requestedType : 'all';
    const browse = { game, setId, setSlug, sort: setId ? 'newest' : sort, scope, productSort: setId ? sort : 'price-desc', productKind };
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
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (category !== 'all') params.set('category', category);
  if (provider !== 'all') params.set('provider', provider);
  const searchPath = params.size ? `/discover/search?${params}` : '/discover';
  return route('discover', 'search', searchPath, {
    mode: 'search',
    search: { query, category, provider },
    unsupported: DISCOVER_MODES.has(requestedMode) ? '' : `discover-${requestedMode}`
  });
}

function collectionPath(section = 'holdings') {
  return `/collection/${section === 'holdings' ? 'items' : section}`;
}

function portfolioRoute(url, pathname = '/collection') {
  const pathSection = pathname.startsWith('/collection/')
    ? pathname.slice('/collection/'.length).split('/')[0]
    : '';
  const requested = pathSection === 'items'
    ? 'holdings'
    : pathSection || bounded(url.searchParams.get('view'), 30) || 'holdings';
  const section = PORTFOLIO_SECTIONS.has(requested) ? requested : 'holdings';
  return route('portfolio', 'portfolio', collectionPath(section), {
    portfolioSection: section,
    unsupported: PORTFOLIO_SECTIONS.has(requested) ? '' : `portfolio-${requested}`
  });
}

function insightsPath(insights = {}) {
  const view = INSIGHTS_VIEWS.includes(insights.view) ? insights.view : 'performance';
  const horizon = INSIGHTS_HORIZONS.includes(Number(insights.horizon)) ? Number(insights.horizon) : 90;
  const suffix = view === 'performance' ? '' : view === 'forecasts' ? '/scenarios' : `/${view}`;
  const params = new URLSearchParams();
  if (view === 'forecasts' && horizon !== 90) params.set('horizon', String(horizon));
  return `/insights${suffix}${params.size ? `?${params}` : ''}`;
}

function insightsRoute(url, pathname = '/insights') {
  const pathView = pathname.slice('/insights'.length).split('/').filter(Boolean)[0] || '';
  const mappedPathView = pathView === 'scenarios' ? 'forecasts' : pathView;
  const requested = mappedPathView || bounded(url.searchParams.get('view'), 40) || 'performance';
  const view = INSIGHTS_VIEWS.includes(requested) ? requested : 'performance';
  const requestedHorizon = Number(url.searchParams.get('horizon'));
  const horizon = INSIGHTS_HORIZONS.includes(requestedHorizon) ? requestedHorizon : 90;
  return route('insights', 'insights', insightsPath({ view, horizon }), {
    insights: { view, horizon },
    unsupported: INSIGHTS_VIEWS.includes(requested) ? '' : `insights-${requested}`
  });
}

export function parseAppRoute(input = '/') {
  const url = asURL(input);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/' || pathname === '/home') return route('overview', 'home', '/home');
  if (pathname === '/portfolio' || pathname === '/collection' || pathname.startsWith('/collection/')) return portfolioRoute(url, pathname);
  if (pathname === '/discover' || pathname.startsWith('/discover/')) return discoverRoute(url, pathname);
  if (pathname.startsWith('/games/')) {
    const game = browseSegment(pathname.slice('/games/'.length), 50);
    if (game) return discoverRoute(new URL(`/discover/${encodeURIComponent(game)}${url.search}`, APP_ORIGIN), `/discover/${encodeURIComponent(game)}`);
  }
  if (pathname.startsWith('/sets/')) {
    const setSegment = browseSegment(pathname.slice('/sets/'.length), 160);
    const setMatch = setSegment && !setSegment.includes(':') ? SET_SLUG_ID.exec(setSegment) : null;
    const fallbackGame = setMatch ? `tcgcsv-category-${setMatch[1]}` : '';
    const game = browseSegment(url.searchParams.get('game'), 50) || fallbackGame;
    if (game && setSegment) {
      const translated = new URL(`/discover/${encodeURIComponent(game)}/${encodeURIComponent(setSegment)}${url.search}`, APP_ORIGIN);
      translated.searchParams.delete('game');
      return discoverRoute(translated, translated.pathname);
    }
  }
  if (pathname === '/insights' || pathname.startsWith('/insights/')) return insightsRoute(url, pathname);
  if (pathname === '/settings' || pathname === '/settings/data') {
    const settingsSection = pathname === '/settings/data' ? 'data' : 'general';
    return route('settings', 'profile', pathname, { settingsSection });
  }
  if (pathname === '/add' || pathname === '/scan' || pathname === '/scan/review') {
    const review = pathname === '/scan/review' || url.searchParams.get('step') === 'review';
    return route(review ? 'add-review' : 'add', review ? 'scan' : 'add', review ? '/scan/review' : '/scan');
  }

  const cardMatch = pathname.match(/^\/(?:cards|items)\/([^/]+)$/);
  if (cardMatch) {
    const id = entityId(cardMatch[1]);
    const slugged = id && !id.includes(':') ? CARD_SLUG_ID.exec(id) : null;
    if (slugged) {
      return route('card-detail', 'detail', `/items/${encodeURIComponent(id)}`, {
        entityId: `tcgcsv:${slugged[1]}:${slugged[2]}:${slugged[3]}`,
        origin: 'search'
      });
    }
    if (id) return route('card-detail', 'detail', `/items/${encodeURIComponent(id)}`, { entityId: id, origin: 'search' });
  }
  const holdingMatch = pathname.match(/^\/holdings\/([^/]+)$/);
  if (holdingMatch) {
    const id = entityId(holdingMatch[1]);
    if (id) return route('holding-detail', 'detail', `/holdings/${encodeURIComponent(id)}`, { entityId: id, origin: 'portfolio' });
  }
  return route('overview', 'home', '/home', { notFound: pathname });
}

function discoverPath(search = {}, discover = {}) {
  if (discover.mode === 'browse') return browsePath(discover);
  const params = new URLSearchParams();
  const query = bounded(search.query);
  const category = discoverCategory(search.category);
  const provider = DISCOVER_PROVIDERS.has(search.provider) ? search.provider : 'all';
  if (query) params.set('q', query);
  if (category !== 'all') params.set('category', category);
  if (provider !== 'all') params.set('provider', provider);
  return params.size ? `/discover/search?${params}` : '/discover';
}

function detailPath(detail = {}) {
  const selected = detail || {};
  if (selected.holding?.id) return `/holdings/${encodeURIComponent(selected.holding.id)}`;
  const provider = bounded(selected.item?.provider || selected.catalogRef?.provider, 50).toLowerCase();
  const externalId = bounded(selected.item?.externalId || selected.catalogRef?.externalId, 400);
  if (provider === 'tcgcsv' && /^\d+:\d+:\d+$/.test(externalId)) {
    const slug = cardSlug(`${selected.item?.setName || selected.catalogRef?.setName || ''} ${selected.item?.name || selected.catalogRef?.name || ''}`);
    return `/items/${slug ? `${slug}-` : ''}${externalId.replace(/:/g, '-')}`;
  }
  const providerId = provider && externalId ? `${provider}:${externalId}` : '';
  const id = selected.watched?.watchKey
    || providerId
    || selected.catalogRef?.canonicalVariantId
    || selected.catalogRef?.watchKey
    || selected.item?.id;
  return id ? `/items/${encodeURIComponent(id)}` : '/collection/items';
}

export function appRouteForLegacyView(view, state = {}, context = {}) {
  const portfolioSection = context.portfolioSection || state.portfolio?.section || 'holdings';
  const paths = {
    home: '/home',
    search: discoverPath(context.search || state.search, context.discover || { mode: 'search' }),
    add: '/scan',
    scan: '/scan/review',
    portfolio: portfolioSection === 'forecasts'
      ? insightsPath(context.insights || state.insights)
      : collectionPath(PORTFOLIO_SECTIONS.has(portfolioSection) ? portfolioSection : 'holdings'),
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
      ...(changed ? { page: 1, loading: false, results: [], warnings: [], cached: false } : {})
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
      categoryPickerOpen: false,
      query: gameChanged ? '' : current.query || '',
      setPage: gameChanged ? 1 : current.setPage || 1,
      setLimit: 48,
      productQuery: setChanged ? '' : current.productQuery || '',
      productPage: setChanged ? 1 : current.productPage || 1,
      limit: 48,
      loading: false,
      productsLoadingMore: false,
      error: '',
      warnings: [],
      ...(gameChanged ? { sets: [], loadedGame: '' } : {}),
      ...(setChanged ? { products: [], selectedSet: null, loadedSetId: '' } : {})
    };
  }
  return patch;
}

export function primaryDestination(appRoute) {
  if (['add', 'add-review'].includes(appRoute.key)) return 'scan';
  if (appRoute.key === 'card-detail') return 'discover';
  if (['portfolio', 'holding-detail'].includes(appRoute.key)) return 'collection';
  if (appRoute.key === 'overview') return 'home';
  return appRoute.key;
}

export function currentAppPath(input = '/') {
  const url = asURL(input);
  return `${url.pathname || '/'}${url.search || ''}`;
}
