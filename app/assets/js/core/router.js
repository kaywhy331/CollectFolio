import { INSIGHTS_HORIZONS, INSIGHTS_VIEWS } from './insights.js';

const APP_ORIGIN = 'https://collectfolio.local';
const PORTFOLIO_SECTIONS = new Set(['holdings', 'watchlist']);
const DISCOVER_CATEGORIES = new Set(['all', 'pokemon', 'magic', 'yugioh', 'sports', 'comics', 'slab', 'other']);
const DISCOVER_PROVIDERS = new Set(['all', 'pokemon', 'scryfall', 'ygoprodeck']);

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

function discoverRoute(url) {
  const requestedMode = bounded(url.searchParams.get('mode'), 30) || 'search';
  const query = bounded(url.searchParams.get('q'));
  const requestedCategory = bounded(url.searchParams.get('category'), 30) || 'all';
  const requestedProvider = bounded(url.searchParams.get('provider'), 30) || 'all';
  const category = DISCOVER_CATEGORIES.has(requestedCategory) ? requestedCategory : 'all';
  const provider = DISCOVER_PROVIDERS.has(requestedProvider) ? requestedProvider : 'all';
  const params = new URLSearchParams({ mode: 'search' });
  if (query) params.set('q', query);
  if (category !== 'all') params.set('category', category);
  if (provider !== 'all') params.set('provider', provider);
  return route('discover', 'search', `/discover?${params}`, {
    mode: 'search',
    search: { query, category, provider },
    unsupported: requestedMode === 'search' ? '' : `discover-${requestedMode}`
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
  if (pathname === '/discover') return discoverRoute(url);
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

function discoverPath(search = {}) {
  const params = new URLSearchParams({ mode: 'search' });
  const query = bounded(search.query);
  const category = DISCOVER_CATEGORIES.has(search.category) ? search.category : 'all';
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
  const id = providerId
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
    search: discoverPath(context.search || state.search),
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
