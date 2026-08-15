import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_GAMES, filterCatalogProducts, filterCatalogSets } from '../app/assets/js/services/catalog-browse.js';
import { normalizePokemonSet } from '../app/assets/js/services/providers/pokemon.js';
import { normalizeScryfallSet } from '../app/assets/js/services/providers/scryfall.js';
import { normalizeYGOSet } from '../app/assets/js/services/providers/ygoprodeck.js';

test('browse catalog exposes provider-neutral games and normalized set identity', () => {
  assert.deepEqual(CATALOG_GAMES.map((game) => game.id), ['pokemon', 'magic', 'yugioh']);
  assert.deepEqual(normalizePokemonSet({ id: 'swsh12', name: 'Silver Tempest', series: 'Sword & Shield', printedTotal: 195, releaseDate: '2022-11-11', ptcgoCode: 'SIT' }), {
    id: 'pokemon:swsh12', pokemonId: 'swsh12', externalId: 'swsh12', provider: 'pokemon', gameId: 'pokemon', game: 'Pokémon',
    name: 'Silver Tempest', code: 'SIT', series: 'Sword & Shield', printedTotal: 195, releaseDate: '2022-11-11', ptcgoCode: 'SIT', releasedAt: '2022-11-11',
    year: '2022', productCount: 195, cardCount: 195, setType: 'expansion', supplemental: false
  });
  assert.equal(normalizeScryfallSet({ code: 'mkm', name: 'Murders at Karlov Manor', set_type: 'expansion', card_count: 286, released_at: '2024-02-09' }).id, 'magic:mkm');
  assert.equal(normalizeYGOSet({ set_code: 'LOB', set_name: 'Legend of Blue Eyes', num_of_cards: 126, tcg_date: '2002-03-08' }).cardCount, 126);
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
