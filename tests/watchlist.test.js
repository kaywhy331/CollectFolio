import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferenceForItem, watchKeyForItem } from '../app/assets/js/core/catalog-identity.js';
import { createWatchlistItem, mergeWatchlistItems, mergeWatchlistTombstones } from '../app/assets/js/services/watchlist.js';

const card = {
  provider: 'pokemon', externalId: 'sv3-223', category: 'pokemon', game: 'Pokémon',
  name: 'Charizard ex', setName: 'Obsidian Flames', number: '223', variant: 'holofoil',
  price: 90, currency: 'USD'
};

test('watch identity distinguishes exact finishes and condition classes', () => {
  const base = watchKeyForItem(card);
  assert.notEqual(base, watchKeyForItem({ ...card, variant: 'reverse holofoil' }));
  assert.notEqual(base, watchKeyForItem(card, { conditionClass: 'graded' }));
  assert.equal(base, watchKeyForItem({ ...card }));
});

test('approved canonical UUID supersedes provider-scoped identity', () => {
  const canonicalVariantId = '123e4567-e89b-42d3-a456-426614174000';
  const reference = catalogReferenceForItem({ ...card, canonicalVariantId });
  assert.equal(reference.watchKey, `variant:${canonicalVariantId}`);
  assert.equal(reference.mappingStatus, 'mapped');
});

test('watchlist item snapshots identity and preserves created time on edits', () => {
  const first = createWatchlistItem(card, { targetPrice: 75 }, null, '2026-08-01T00:00:00.000Z');
  const edited = createWatchlistItem(card, { targetPrice: 80 }, first, '2026-08-02T00:00:00.000Z');
  assert.equal(edited.id, first.watchKey);
  assert.equal(edited.createdAt, first.createdAt);
  assert.equal(edited.updatedAt, '2026-08-02T00:00:00.000Z');
  assert.equal(edited.targetPrice, 80);
  assert.equal(edited.targetCurrency, 'USD');
  assert.equal(edited.catalogRef.name, card.name);
});

test('watchlist targets retain an explicit currency across edits', () => {
  const first = createWatchlistItem(card, { targetPrice: 75, targetCurrency: 'EUR' }, null, '2026-08-01T00:00:00.000Z');
  const edited = createWatchlistItem(card, { targetPrice: 70 }, first, '2026-08-02T00:00:00.000Z');
  assert.equal(edited.targetCurrency, 'EUR');
});

test('watchlist merge uses last write and tombstones always win', () => {
  const local = [{ id: 'one', watchKey: 'one', notes: 'local', updatedAt: '2026-08-02T00:00:00.000Z' }];
  const remote = [
    { id: 'one', watchKey: 'one', notes: 'remote', updatedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'two', watchKey: 'two', updatedAt: '2026-08-03T00:00:00.000Z' }
  ];
  assert.deepEqual(mergeWatchlistItems(local, remote, new Set(['two'])), [local[0]]);
});

test('watchlist tombstones retain the newest deletion per exact key', () => {
  const merged = mergeWatchlistTombstones(
    [{ id: 'one', deletedAt: '2026-08-01T00:00:00.000Z' }],
    [{ id: 'one', deletedAt: '2026-08-02T00:00:00.000Z' }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].deletedAt, '2026-08-02T00:00:00.000Z');
});
