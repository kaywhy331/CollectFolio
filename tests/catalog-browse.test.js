import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_GAMES, filterCatalogProducts, filterCatalogSets } from '../app/assets/js/services/catalog-browse.js';
import { normalizePokemonSet } from '../app/assets/js/services/providers/pokemon.js';
import { normalizeScryfallSet } from '../app/assets/js/services/providers/scryfall.js';
import { normalizeYGOSet } from '../app/assets/js/services/providers/ygoprodeck.js';
import {
  normalizeTCGCSVGroup,
  normalizeTCGCSVProduct,
  preferredTCGCSVPrice,
  requestTCGCSVCatalog,
  tcgcsvCategory
} from '../app/assets/js/services/providers/tcgcsv.js';

test('browse catalog exposes provider-neutral games and normalized set identity', () => {
  assert.deepEqual(CATALOG_GAMES.map((game) => game.id), ['pokemon', 'magic', 'yugioh', 'tcgcsv']);
  assert.deepEqual(normalizePokemonSet({ id: 'swsh12', name: 'Silver Tempest', series: 'Sword & Shield', printedTotal: 195, releaseDate: '2022-11-11', ptcgoCode: 'SIT' }), {
    id: 'pokemon:swsh12', pokemonId: 'swsh12', externalId: 'swsh12', provider: 'pokemon', gameId: 'pokemon', game: 'Pokémon',
    name: 'Silver Tempest', code: 'SIT', series: 'Sword & Shield', printedTotal: 195, releaseDate: '2022-11-11', ptcgoCode: 'SIT', releasedAt: '2022-11-11',
    year: '2022', productCount: 195, cardCount: 195, setType: 'expansion', supplemental: false
  });
  assert.equal(normalizeScryfallSet({ code: 'mkm', name: 'Murders at Karlov Manor', set_type: 'expansion', card_count: 286, released_at: '2024-02-09' }).id, 'magic:mkm');
  assert.equal(normalizeYGOSet({ set_code: 'LOB', set_name: 'Legend of Blue Eyes', num_of_cards: 126, tcg_date: '2002-03-08' }).cardCount, 126);
});

test('full TCGCSV mapping retains finishes, raw price fields, and unavailable products', () => {
  assert.deepEqual(preferredTCGCSVPrice({
    lowPrice: '1.00', midPrice: '2.00', highPrice: '4.00', marketPrice: '3.00', directLowPrice: '0.50'
  }), { field: 'marketPrice', label: 'market', value: 3 });
  assert.deepEqual(tcgcsvCategory(1), { category: 'magic', game: 'Magic: The Gathering' });
  assert.deepEqual(tcgcsvCategory(85), { category: 'pokemon', game: 'Pokémon' });
  assert.equal(tcgcsvCategory(42, 'Test category').category, 'full-catalog');

  const group = {
    categoryId: 3, groupId: 604, name: 'Base Set', abbreviation: 'BS',
    publishedOn: '1999-01-09', productCount: 2, groupSha256: 'a'.repeat(64)
  };
  const set = normalizeTCGCSVGroup(group, [{ categoryId: 3, displayName: 'Pokémon' }]);
  assert.equal(set.externalId, '3:604');
  assert.equal(set.cardCount, 2);
  const product = normalizeTCGCSVProduct({
    categoryId: 3, groupId: 604, productId: 1, name: 'Alakazam', cardNumber: '001/102',
    rarity: 'Holo Rare', cardType: 'Psychic', productSha256: 'b'.repeat(64),
    extendedData: [{ name: 'HP', value: '80' }],
    prices: [
      { subtypeName: 'Holofoil', lowPrice: '10', midPrice: '12', highPrice: '20', marketPrice: '15', directLowPrice: '9' },
      { subtypeName: 'Reverse Holofoil', lowPrice: null, midPrice: null, highPrice: null, marketPrice: null, directLowPrice: null }
    ]
  }, {
    category: { categoryId: 3, displayName: 'Pokémon' }, group,
    publicationId: 'c'.repeat(64), sourceUpdatedAt: '2026-08-15T20:05:57.000Z'
  });
  assert.equal(product.price, 15);
  assert.equal(product.priceOptions.length, 2);
  assert.equal(product.priceOptions[0].directLowPrice, 9);
  assert.equal(product.priceOptions[1].price, null);
  assert.deepEqual(product.extendedData, [{ name: 'HP', value: '80' }]);
  assert.equal(product.tcgcsvPrices[0].marketPrice, '15');

  const unavailable = normalizeTCGCSVProduct({
    categoryId: 3, groupId: 604, productId: 2, name: 'Unpriced card', prices: []
  }, { category: { categoryId: 3 }, group });
  assert.equal(unavailable.price, null);
  assert.deepEqual(unavailable.priceOptions, []);
  assert.equal(unavailable.pricingStatus, 'unavailable');
});

test('full TCGCSV requests use the signed-in bearer token and preserve query filters', async () => {
  const priorWindow = globalThis.window;
  globalThis.window = {
    COLLECTFOLIO_CONFIG: { TCGCSV_CATALOG_URL: 'https://catalog.example/' }
  };
  try {
    let captured;
    const payload = await requestTCGCSVCatalog('/catalog/search', {
      params: { q: 'Black Lotus', category_id: 1, omitted: null },
      session: { access_token: 'private-test-token' },
      fetchImpl: async (url, options) => {
        captured = { url: String(url), options };
        return new Response(JSON.stringify({ products: [] }), {
          headers: { 'content-length': '15', 'content-type': 'application/json' }
        });
      }
    });
    const requested = new URL(captured.url);
    assert.equal(requested.origin, 'https://catalog.example');
    assert.equal(requested.pathname, '/catalog/search');
    assert.equal(requested.searchParams.get('q'), 'Black Lotus');
    assert.equal(requested.searchParams.get('category_id'), '1');
    assert.equal(requested.searchParams.has('omitted'), false);
    assert.equal(captured.options.headers.authorization, 'Bearer private-test-token');
    assert.deepEqual(payload, { products: [] });

    await assert.rejects(() => requestTCGCSVCatalog('/catalog/summary', {
      session: { access_token: 'expired-token' },
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }), /Sign in to use the full TCGCSV test catalog/);
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test('set browsing keeps every match while relevance and explicit sorts only change order', () => {
  const sets = [
    { id: 'pokemon:old', name: 'Silver Classics', code: 'OLD', series: '', releasedAt: '2020-01-01', cardCount: 300, supplemental: true },
    { id: 'pokemon:sit', name: 'Silver Tempest', code: 'SIT', series: 'Sword & Shield', releasedAt: '2022-11-11', cardCount: 195, supplemental: false },
    { id: 'pokemon:new', name: 'Newest Set', code: 'NEW', series: '', releasedAt: '2026-01-01', cardCount: 100, supplemental: false }
  ];
  assert.deepEqual(filterCatalogSets(sets, { query: 'SIT' }).map((set) => set.id), ['pokemon:sit']);
  assert.deepEqual(filterCatalogSets(sets, { sort: 'newest' }).map((set) => set.id), ['pokemon:new', 'pokemon:sit', 'pokemon:old']);
  assert.deepEqual(filterCatalogSets(sets, { sort: 'largest' }).map((set) => set.id), ['pokemon:old', 'pokemon:sit', 'pokemon:new']);
  assert.deepEqual(filterCatalogSets(sets, { scope: 'main' }).map((set) => set.id), ['pokemon:new', 'pokemon:sit']);
});

test('set products use natural collector-number ordering without dropping unpriced cards', () => {
  const products = [
    { id: 'ten', name: 'Card 10', number: '10', price: null },
    { id: 'two', name: 'Card 2', number: '2', price: 2 },
    { id: 'one', name: 'Card 1', number: '1', price: 1 }
  ];
  assert.deepEqual(filterCatalogProducts(products).map((product) => product.id), ['one', 'two', 'ten']);
  assert.equal(filterCatalogProducts(products, { query: 'card' }).length, 3);
  assert.deepEqual(filterCatalogProducts(products, { sort: 'price-desc' }).map((product) => product.id), ['two', 'one', 'ten']);
});
