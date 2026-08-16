import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appRouteForLegacyView,
  currentAppPath,
  parseAppRoute,
  primaryDestination,
  routeStatePatch
} from '../app/assets/js/core/router.js';

test('recommended routes resolve to dedicated renderers and expose only supported sections', () => {
  assert.deepEqual(
    ['/', '/portfolio?view=holdings', '/portfolio?view=watchlist', '/discover?mode=search', '/insights?view=forecasts', '/add', '/add?step=review', '/settings']
      .map((path) => parseAppRoute(path).legacyView),
    ['home', 'portfolio', 'portfolio', 'search', 'insights', 'add', 'scan', 'profile']
  );
  assert.equal(parseAppRoute('/portfolio?view=sets').canonicalPath, '/portfolio?view=sets');
  assert.equal(parseAppRoute('/portfolio?view=sets').portfolioSection, 'sets');
  assert.equal(parseAppRoute('/portfolio?view=sold').unsupported, 'portfolio-sold');
  assert.equal(parseAppRoute('/insights?view=alerts').canonicalPath, '/insights?view=alerts');
  assert.equal(parseAppRoute('/insights?view=track-record').unsupported, '');
  assert.equal(parseAppRoute('/insights?view=forecasts&horizon=365').canonicalPath, '/insights?view=forecasts&horizon=365');
  assert.equal(parseAppRoute('/insights?view=unknown').unsupported, 'insights-unknown');
});

test('discover route restores bounded supported search state in canonical order', () => {
  const route = parseAppRoute('/discover?provider=scryfall&q=Black%20Lotus&category=magic&mode=search');
  assert.deepEqual(route.search, { query: 'Black Lotus', category: 'magic', provider: 'scryfall' });
  assert.equal(route.canonicalPath, '/discover?mode=search&q=Black+Lotus&category=magic&provider=scryfall');
  assert.equal(parseAppRoute('/discover?mode=market&provider=unknown').unsupported, 'discover-market');
});

test('browse routes preserve progressive game and set identity without hard-coding providers', () => {
  const root = parseAppRoute('/discover?mode=browse');
  assert.equal(root.mode, 'browse');
  assert.equal(root.canonicalPath, '/discover/browse');
  assert.deepEqual(root.browse, { game: 'all', setId: '', sort: 'newest', scope: 'all', productSort: 'number' });

  const game = parseAppRoute('/discover/pokemon?sort=alpha&scope=main');
  assert.equal(game.canonicalPath, '/discover/pokemon?sort=alpha&scope=main');
  assert.deepEqual(game.browse, { game: 'pokemon', setId: '', sort: 'alpha', scope: 'main', productSort: 'number' });

  const set = parseAppRoute('/discover/magic/mkm?sort=name');
  assert.equal(set.canonicalPath, '/discover/magic/mkm?sort=name');
  assert.deepEqual(set.browse, { game: 'magic', setId: 'mkm', sort: 'newest', scope: 'all', productSort: 'name' });

  const dynamic = parseAppRoute('/discover/future-game/set%3A1');
  assert.equal(dynamic.browse.game, 'future-game');
  assert.equal(dynamic.browse.setId, 'set:1');
});

test('detail routes preserve safe opaque identities and map to their underlying destination', () => {
  const card = parseAppRoute('/cards/source%3Av1%3Ascryfall%3Aabc');
  const holding = parseAppRoute('/holdings/holding%3A1');
  assert.equal(card.entityId, 'source:v1:scryfall:abc');
  assert.equal(card.canonicalPath, '/cards/source%3Av1%3Ascryfall%3Aabc');
  assert.equal(primaryDestination(card), 'discover');
  assert.equal(holding.entityId, 'holding:1');
  assert.equal(primaryDestination(holding), 'portfolio');
});

test('legacy view mappings create restorable route state', () => {
  const state = {
    search: { query: 'Mew', category: 'pokemon', provider: 'pokemon' },
    portfolio: { section: 'watchlist', query: '', category: 'all', sort: 'value-desc' }
  };
  assert.equal(appRouteForLegacyView('search', state).canonicalPath, '/discover?mode=search&q=Mew&category=pokemon&provider=pokemon');
  assert.equal(appRouteForLegacyView('search', state, { discover: { mode: 'browse', game: 'pokemon', setId: 'swsh12' } }).canonicalPath, '/discover/pokemon/swsh12');
  assert.equal(appRouteForLegacyView('search', state, { detail: null }).canonicalPath, '/discover?mode=search&q=Mew&category=pokemon&provider=pokemon');
  assert.equal(appRouteForLegacyView('portfolio', state).canonicalPath, '/portfolio?view=watchlist');
  assert.equal(appRouteForLegacyView('portfolio', { ...state, portfolio: { ...state.portfolio, section: 'sets' } }).canonicalPath, '/portfolio?view=sets');
  assert.equal(appRouteForLegacyView('insights', { ...state, insights: { view: 'alerts', horizon: 90 } }).canonicalPath, '/insights?view=alerts');
  assert.equal(appRouteForLegacyView('detail', state, { detail: { holding: { id: 'h 1' } } }).canonicalPath, '/holdings/h%201');
  assert.equal(appRouteForLegacyView('detail', state, { detail: {
    item: { provider: 'scryfall', externalId: 'card/id' },
    catalogRef: { provider: 'scryfall', externalId: 'card/id', canonicalVariantId: '123e4567-e89b-42d3-a456-426614174000' }
  } }).canonicalPath, '/cards/scryfall%3Acard%2Fid');
  assert.equal(appRouteForLegacyView('detail', state, { detail: {
    item: { provider: 'scryfall', externalId: 'card/id' },
    watched: { watchKey: 'variant:v2:123e4567-e89b-42d3-a456-426614174000:raw:near-mint' }
  } }).canonicalPath, '/cards/variant%3Av2%3A123e4567-e89b-42d3-a456-426614174000%3Araw%3Anear-mint');
  const route = parseAppRoute('/portfolio?view=watchlist');
  assert.equal(routeStatePatch(route, state).portfolio.section, 'watchlist');
  const restored = routeStatePatch(parseAppRoute('/discover?mode=search&q=Different'), {
    ...state,
    search: { ...state.search, results: [{ id: 'stale' }], warnings: ['stale'] }
  });
  assert.deepEqual(restored.search.results, []);
  assert.deepEqual(restored.search.warnings, []);
  const browsed = routeStatePatch(parseAppRoute('/discover/pokemon/swsh12'), {
    ...state,
    discover: { mode: 'browse', game: 'magic', setId: 'mkm', sets: [{ id: 'stale' }], products: [{ id: 'stale' }], query: 'old', productQuery: 'old' }
  });
  assert.equal(browsed.discover.mode, 'browse');
  assert.equal(browsed.discover.game, 'pokemon');
  assert.deepEqual(browsed.discover.sets, []);
  assert.deepEqual(browsed.discover.products, []);
  const insights = routeStatePatch(parseAppRoute('/insights?view=forecasts&horizon=180'), {
    ...state, insights: { view: 'alerts', horizon: 90, alertFilter: 'unread' }
  });
  assert.deepEqual(insights.insights, { view: 'forecasts', horizon: 180, alertFilter: 'unread' });
});

test('unknown locations fail closed to Overview', () => {
  const route = parseAppRoute('/not-a-real-capability?view=alerts');
  assert.equal(route.key, 'overview');
  assert.equal(route.notFound, '/not-a-real-capability');
  assert.equal(currentAppPath({ pathname: '/discover', search: '?mode=search' }), '/discover?mode=search');
});
