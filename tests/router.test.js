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
    ['/home', '/collection/items', '/collection/watchlist', '/discover', '/insights/scenarios', '/scan', '/scan/review', '/settings']
      .map((path) => parseAppRoute(path).legacyView),
    ['home', 'portfolio', 'portfolio', 'search', 'insights', 'add', 'scan', 'profile']
  );
  assert.equal(parseAppRoute('/collection/sets').canonicalPath, '/collection/sets');
  assert.equal(parseAppRoute('/collection/sets').portfolioSection, 'sets');
  assert.equal(parseAppRoute('/portfolio?view=sets').canonicalPath, '/collection/sets');
  assert.equal(parseAppRoute('/portfolio?view=sold').unsupported, 'portfolio-sold');
  assert.equal(parseAppRoute('/insights/alerts').canonicalPath, '/insights/alerts');
  assert.equal(parseAppRoute('/insights/track-record').unsupported, '');
  assert.equal(parseAppRoute('/insights?view=forecasts&horizon=365').canonicalPath, '/insights/scenarios?horizon=365');
  assert.equal(parseAppRoute('/insights?view=unknown').unsupported, 'insights-unknown');
});

test('discover route restores bounded supported search state in canonical order', () => {
  const route = parseAppRoute('/discover?provider=scryfall&q=Black%20Lotus&category=magic&mode=search');
  assert.deepEqual(route.search, { query: 'Black Lotus', category: 'magic', provider: 'scryfall' });
  assert.equal(route.canonicalPath, '/discover/search?q=Black+Lotus&category=magic&provider=scryfall');
  assert.equal(parseAppRoute('/discover?mode=market&provider=unknown').unsupported, 'discover-market');
  const tcgcsv = parseAppRoute('/discover?mode=search&q=Luffy&category=tcgcsv-category-68&provider=tcgcsv');
  assert.deepEqual(tcgcsv.search, { query: 'Luffy', category: 'tcgcsv-category-68', provider: 'tcgcsv' });
  assert.equal(tcgcsv.canonicalPath, '/discover/search?q=Luffy&category=tcgcsv-category-68&provider=tcgcsv');
  assert.equal(parseAppRoute('/discover?mode=search&category=full-catalog').search.category, 'all');
});

test('browse routes preserve progressive game and set identity without hard-coding providers', () => {
  const root = parseAppRoute('/discover?mode=browse');
  assert.equal(root.mode, 'browse');
  assert.equal(root.canonicalPath, '/discover/browse');
  assert.deepEqual(root.browse, { game: 'all', setId: '', setSlug: '', sort: 'newest', scope: 'all', productSort: 'price-desc', productKind: 'cards' });

  const game = parseAppRoute('/discover/pokemon?sort=alpha&scope=main');
  assert.equal(game.canonicalPath, '/games/pokemon?sort=alpha&scope=main');
  assert.deepEqual(game.browse, { game: 'pokemon', setId: '', setSlug: '', sort: 'alpha', scope: 'main', productSort: 'price-desc', productKind: 'cards' });

  const set = parseAppRoute('/discover/magic/mkm?sort=name');
  assert.equal(set.canonicalPath, '/sets/mkm?game=magic&sort=name');
  assert.deepEqual(set.browse, { game: 'magic', setId: 'mkm', setSlug: '', sort: 'newest', scope: 'all', productSort: 'name', productKind: 'cards' });

  const sealed = parseAppRoute('/discover/tcgcsv-category-3/3%3A100?type=sealed');
  assert.equal(sealed.canonicalPath, '/sets/3%3A100?game=tcgcsv-category-3&type=sealed');
  assert.equal(sealed.browse.productKind, 'sealed');
  assert.equal(parseAppRoute('/discover/magic/mkm?type=cards').canonicalPath, '/sets/mkm?game=magic');
  assert.equal(parseAppRoute('/discover/magic/mkm?type=bogus').browse.productKind, 'cards');
  assert.equal(parseAppRoute('/discover/pokemon?type=sealed').browse.productKind, 'cards');
  assert.equal(parseAppRoute('/discover/pokemon?type=sealed').canonicalPath, '/games/pokemon');

  const dynamic = parseAppRoute('/discover/future-game/set%3A1');
  assert.equal(dynamic.browse.game, 'future-game');
  assert.equal(dynamic.browse.setId, 'set:1');
  assert.equal(parseAppRoute('/games/pokemon').browse.game, 'pokemon');
  assert.equal(parseAppRoute('/sets/3-1442?game=pokemon').browse.setId, '3:1442');
  assert.equal(parseAppRoute('/discover/tcgcsv').canonicalPath, '/discover/browse');
  assert.equal(parseAppRoute('/discover/full-catalog').canonicalPath, '/discover/browse');
});

test('detail routes preserve safe opaque identities and map to their underlying destination', () => {
  const card = parseAppRoute('/cards/source%3Av1%3Ascryfall%3Aabc');
  const holding = parseAppRoute('/holdings/holding%3A1');
  assert.equal(card.entityId, 'source:v1:scryfall:abc');
  assert.equal(card.canonicalPath, '/items/source%3Av1%3Ascryfall%3Aabc');
  assert.equal(primaryDestination(card), 'discover');
  assert.equal(holding.entityId, 'holding:1');
  assert.equal(primaryDestination(holding), 'collection');
});

test('legacy view mappings create restorable route state', () => {
  const state = {
    search: { query: 'Mew', category: 'pokemon', provider: 'pokemon' },
    portfolio: { section: 'watchlist', query: '', category: 'all', sort: 'value-desc' }
  };
  assert.equal(appRouteForLegacyView('search', state).canonicalPath, '/discover/search?q=Mew&category=pokemon&provider=pokemon');
  assert.equal(appRouteForLegacyView('search', state, { discover: { mode: 'browse', game: 'pokemon', setId: 'swsh12' } }).canonicalPath, '/sets/swsh12?game=pokemon');
  assert.equal(appRouteForLegacyView('search', state, { detail: null }).canonicalPath, '/discover/search?q=Mew&category=pokemon&provider=pokemon');
  assert.equal(appRouteForLegacyView('portfolio', state).canonicalPath, '/collection/watchlist');
  assert.equal(appRouteForLegacyView('portfolio', { ...state, portfolio: { ...state.portfolio, section: 'sets' } }).canonicalPath, '/collection/sets');
  assert.equal(appRouteForLegacyView('insights', { ...state, insights: { view: 'alerts', horizon: 90 } }).canonicalPath, '/insights/alerts');
  assert.equal(appRouteForLegacyView('detail', state, { detail: { holding: { id: 'h 1' } } }).canonicalPath, '/holdings/h%201');
  assert.equal(appRouteForLegacyView('detail', state, { detail: {
    item: { provider: 'scryfall', externalId: 'card/id' },
    catalogRef: { provider: 'scryfall', externalId: 'card/id', canonicalVariantId: '123e4567-e89b-42d3-a456-426614174000' }
  } }).canonicalPath, '/items/scryfall%3Acard%2Fid');
  assert.equal(appRouteForLegacyView('detail', state, { detail: {
    item: { provider: 'scryfall', externalId: 'card/id' },
    watched: { watchKey: 'variant:v2:123e4567-e89b-42d3-a456-426614174000:raw:near-mint' }
  } }).canonicalPath, '/items/variant%3Av2%3A123e4567-e89b-42d3-a456-426614174000%3Araw%3Anear-mint');
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

test('unknown locations fail closed to Home', () => {
  const route = parseAppRoute('/not-a-real-capability?view=alerts');
  assert.equal(route.key, 'overview');
  assert.equal(route.notFound, '/not-a-real-capability');
  assert.equal(currentAppPath({ pathname: '/discover', search: '?mode=search' }), '/discover?mode=search');
});

test('card routes accept SEO slug URLs and resolve the numeric identity triple', () => {
  const slugged = parseAppRoute('/cards/pop-series-2-pikachu-3-1447-88081');
  assert.equal(slugged.key, 'card-detail');
  assert.equal(slugged.entityId, 'tcgcsv:3:1447:88081');
  assert.equal(slugged.canonicalPath, '/items/pop-series-2-pikachu-3-1447-88081');
  // legacy provider ids and watch keys (always containing ':') still resolve
  assert.equal(parseAppRoute('/cards/tcgcsv%3A3%3A1447%3A88081').entityId, 'tcgcsv:3:1447:88081');
  assert.equal(parseAppRoute('/cards/variant%3A123e4567-e89b-42d3-a456-426614174000').entityId, 'variant:123e4567-e89b-42d3-a456-426614174000');
});

test('detail routes generate SEO slug paths for catalog items', () => {
  const route = appRouteForLegacyView('detail', {}, { detail: { item: { provider: 'tcgcsv', externalId: '3:1447:88081', name: 'Pikachu', setName: 'POP Series 2' } } });
  assert.equal(route.canonicalPath, '/items/pop-series-2-pikachu-3-1447-88081');
  const bare = appRouteForLegacyView('detail', {}, { detail: { item: { provider: 'tcgcsv', externalId: '3:1447:88081' } } });
  assert.equal(bare.canonicalPath, '/items/3-1447-88081');
});

test('browse set routes accept SEO slug URLs and resolve the category:group identity', () => {
  const slugged = parseAppRoute('/discover/pokemon/stellar-crown-3-1442?sort=name');
  assert.equal(slugged.mode, 'browse');
  assert.equal(slugged.browse.setId, '3:1442');
  assert.equal(slugged.browse.setSlug, 'stellar-crown-3-1442');
  // Round-trips: the canonical path keeps the decorative slug.
  assert.equal(slugged.canonicalPath, '/sets/stellar-crown-3-1442?game=pokemon&sort=name');
  // Bare numeric pair (no name prefix) also resolves.
  const bare = parseAppRoute('/discover/pokemon/3-1442');
  assert.equal(bare.browse.setId, '3:1442');
  // Legacy colon ids keep resolving and stay raw when no name is known.
  const legacy = parseAppRoute('/discover/pokemon/3%3A1442');
  assert.equal(legacy.browse.setId, '3:1442');
  assert.equal(legacy.browse.setSlug, '');
  assert.equal(legacy.canonicalPath, '/sets/3%3A1442?game=pokemon');
});
