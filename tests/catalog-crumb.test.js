import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogCrumb, crumbMarkup } from '../app/assets/js/core/catalog-crumb.js';

// UX declutter directive 3 (Kevin, 2026-08-26): a "Pokémon / ME05: Pitch
// Black" style breadcrumb on product pages and the quick view, each segment
// navigating to that game or that set in browse. Id semantics must match
// app.js's select-browse-game / open-browse-set handlers and
// services/catalog-browse.js's CATALOG_GAMES exactly, or a crumb click
// silently lands on the wrong (or an empty) browse page.

test('a flagship TCGCSV category (Pokémon) resolves to the fixed browse game id and a colon-joined set id', () => {
  const item = {
    provider: 'tcgcsv', categoryId: 3, groupId: 604, productId: 97847,
    game: 'Pokemon', setName: 'Pitch Black', setCode: 'ME05'
  };
  const crumb = catalogCrumb(item);
  assert.deepEqual(crumb, { gameId: 'pokemon', gameLabel: 'Pokemon', setId: '3:604', setLabel: 'ME05: Pitch Black' });
});

test('a non-flagship TCGCSV category resolves to the generic tcgcsv-category-<id> browse game id', () => {
  const item = { provider: 'tcgcsv', categoryId: 85, groupId: 9, productId: 111, game: 'Digimon', setName: 'Booster' };
  const crumb = catalogCrumb(item);
  assert.equal(crumb.gameId, 'tcgcsv-category-85');
  assert.equal(crumb.setId, '85:9');
});

test('the set label omits a code that is already spelled out in the set name', () => {
  const item = { provider: 'tcgcsv', categoryId: 3, groupId: 1, game: 'Pokemon', setName: 'ME05 Pitch Black', setCode: 'ME05' };
  assert.equal(catalogCrumb(item).setLabel, 'ME05 Pitch Black');
});

test('a TCGCSV item with no setName renders a game-only crumb (no set segment)', () => {
  const item = { provider: 'tcgcsv', categoryId: 3, groupId: 604, game: 'Pokemon' };
  const crumb = catalogCrumb(item);
  assert.equal(crumb.setId, '');
  assert.equal(crumb.setLabel, '');
  assert.doesNotMatch(crumbMarkup(crumb), /open-browse-set/);
});

test('categoryId/groupId are recovered from externalId when the item does not carry them directly', () => {
  // A watched-only entity reopened from its watch key spreads catalogRef,
  // which never carries categoryId/groupId/tcgcsvGroup, only externalId.
  const item = { provider: 'tcgcsv', externalId: '3:604:97847', game: 'Pokemon', setName: 'Obsidian Flames' };
  assert.deepEqual(catalogCrumb(item), { gameId: 'pokemon', gameLabel: 'Pokemon', setId: '3:604', setLabel: 'Obsidian Flames' });
});

test('a non-TCGCSV (custom/manual) item gets a game-only, non-navigating crumb', () => {
  const item = { provider: 'custom', category: 'pokemon' };
  const crumb = catalogCrumb(item);
  assert.deepEqual(crumb, { gameId: '', gameLabel: 'Pokémon', setId: '', setLabel: '' });
  const markup = crumbMarkup(crumb);
  assert.match(markup, /<span class="catalog-crumb-segment">Pokémon<\/span>/);
  assert.doesNotMatch(markup, /<button/);
});

test('an item with no derivable game at all produces no crumb', () => {
  assert.equal(catalogCrumb({ provider: 'custom' }), null);
  assert.equal(crumbMarkup(null), '');
});

test('crumbMarkup escapes labels and wires the exact data-action/data-game/data-set-id contract app.js reads', () => {
  const markup = crumbMarkup({ gameId: 'pokemon', gameLabel: 'Pokémon <hack>', setId: '3:604', setLabel: 'Set <hack>' });
  assert.doesNotMatch(markup, /<hack>/);
  assert.match(markup, /&lt;hack&gt;/);
  assert.match(markup, /data-action="select-browse-game" data-game="pokemon"/);
  assert.match(markup, /data-action="open-browse-set" data-game="pokemon" data-set-id="3:604"/);
});
