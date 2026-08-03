import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSettledProviders, rankCatalogItems } from '../app/assets/js/services/catalog.js';
import { normalizePokemonCard } from '../app/assets/js/services/providers/pokemon.js';
import { normalizeScryfallCard } from '../app/assets/js/services/providers/scryfall.js';
import { normalizeYGOCard } from '../app/assets/js/services/providers/ygoprodeck.js';

test('Pokémon fixture normalizes finishes and market attribution', () => {
  const item = normalizePokemonCard({ id: 'base1-4', name: 'Charizard', number: '4', rarity: 'Rare Holo', set: { name: 'Base', releaseDate: '1999-01-09' }, images: { small: 'https://images.pokemontcg.io/base1/4.png', large: 'https://images.pokemontcg.io/base1/4_hires.png' }, tcgplayer: { url: 'https://example.test/card', updatedAt: '2026/07/31', prices: { holofoil: { market: 350.25 }, reverseHolofoil: { market: 60 } } } });
  assert.equal(item.id, 'pokemon:base1-4');
  assert.equal(item.price, 350.25);
  assert.equal(item.priceOptions.length, 2);
  assert.match(item.priceSource, /Pokémon/);
});

test('Scryfall fixture keeps a printing distinct and exposes three finish prices', () => {
  const item = normalizeScryfallCard({ id: 'abc', name: 'Sol Ring', set_name: 'Commander', collector_number: '1', rarity: 'uncommon', released_at: '2024-01-01', image_uris: { normal: 'https://cards.scryfall.io/normal/a.jpg', small: 'https://cards.scryfall.io/small/a.jpg' }, prices: { usd: '2.00', usd_foil: '5.00', usd_etched: '7.50' }, scryfall_uri: 'https://scryfall.com/card/abc' });
  assert.equal(item.id, 'scryfall:abc');
  assert.deepEqual(item.priceOptions.map((option) => option.finish), ['regular', 'foil', 'etched']);
  assert.equal(item.price, 2);
});

test('YGOPRODeck fixture expands every set-code printing', () => {
  const items = normalizeYGOCard({ id: 46986414, name: 'Dark Magician', card_images: [{ image_url: 'https://images.ygoprodeck.com/images/cards/46986414.jpg', image_url_small: 'https://images.ygoprodeck.com/images/cards_small/46986414.jpg' }], card_sets: [{ set_name: 'Legend', set_code: 'LOB-005', set_rarity: 'Ultra Rare', set_price: '25.20' }, { set_name: 'Starter', set_code: 'SDY-006', set_rarity: 'Ultra Rare', set_price: '6.00' }] });
  assert.equal(items.length, 2);
  assert.equal(items[0].number, 'LOB-005');
  assert.notEqual(items[0].id, items[1].id);
});

test('ranked merge favors name and exact number without collapsing printings', () => {
  const ranked = rankCatalogItems([
    { id: 'a', name: 'Charizard', setName: 'Base', number: '4', variant: 'Holo' },
    { id: 'b', name: 'Charizard', setName: 'Celebrations', number: '4', variant: 'Holo' },
    { id: 'c', name: 'Charmander', setName: 'Base', number: '46' }
  ], 'charizard 4');
  assert.deepEqual(ranked.slice(0, 2).map((item) => item.id).sort(), ['a', 'b']);
  assert.equal(ranked.length, 3);
});

test('provider failure isolation retains every successful provider result', () => {
  const selected = [['pokemon', { label: 'Pokémon' }], ['scryfall', { label: 'Scryfall' }], ['ygoprodeck', { label: 'YGO' }]];
  const combined = collectSettledProviders([
    { status: 'fulfilled', value: [{ id: 'pokemon:one' }] },
    { status: 'rejected', reason: new Error('offline') },
    { status: 'fulfilled', value: [{ id: 'ygo:one' }] }
  ], selected);
  assert.deepEqual(combined.results.map((item) => item.id), ['pokemon:one', 'ygo:one']);
  assert.equal(combined.warnings.length, 1);
  assert.match(combined.warnings[0], /Scryfall/);
});
