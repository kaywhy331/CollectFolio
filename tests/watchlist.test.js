import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogReferenceForItem, watchKeyForItem } from '../app/assets/js/core/catalog-identity.js';
import { createWatchlistItem, findWatchedItem, legacyProviderWatchMatch, mergeWatchlistItems, mergeWatchlistTombstones } from '../app/assets/js/services/watchlist.js';

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
  const conditioned = catalogReferenceForItem({ ...card, canonicalVariantId }, {
    marketCondition: 'Near Mint'
  });
  assert.equal(
    conditioned.watchKey,
    `variant:v2:${canonicalVariantId}:raw:near-mint`
  );
});

test('conditionless catalog lookups recognize v2 watches without crossing exact conditions', () => {
  const canonicalVariantId = '123e4567-e89b-42d3-a456-426614174000';
  const nearMint = createWatchlistItem(card, {
    canonicalVariantId,
    marketCondition: 'Near Mint'
  }, null, '2026-08-01T00:00:00.000Z');
  const lightlyPlayed = createWatchlistItem(card, {
    canonicalVariantId,
    marketCondition: 'Lightly Played'
  }, null, '2026-08-02T00:00:00.000Z');

  assert.equal(findWatchedItem([nearMint, lightlyPlayed], {
    ...card,
    canonicalVariantId
  }), lightlyPlayed);
  assert.equal(findWatchedItem([lightlyPlayed], card, {
    canonicalVariantId,
    marketCondition: 'Near Mint'
  }), null);
});

test('unmapped source and catalog identities use condition-aware v2 keys', () => {
  const sourceNearMint = catalogReferenceForItem(card, { marketCondition: 'Near Mint' });
  const sourceLightlyPlayed = catalogReferenceForItem(card, { marketCondition: 'Lightly Played' });
  assert.match(sourceNearMint.watchKey, /^source:v2:/);
  assert.notEqual(sourceNearMint.watchKey, sourceLightlyPlayed.watchKey);

  const identityOnly = { ...card, externalId: '', provider: 'custom' };
  const catalogNearMint = catalogReferenceForItem(identityOnly, { marketCondition: 'Near Mint' });
  const catalogLightlyPlayed = catalogReferenceForItem(identityOnly, { marketCondition: 'Lightly Played' });
  assert.match(catalogNearMint.watchKey, /^catalog:v2:/);
  assert.notEqual(catalogNearMint.watchKey, catalogLightlyPlayed.watchKey);
});

test('unmapped v2 lookups preserve legacy fallback without crossing conditions', () => {
  const legacy = createWatchlistItem(card);
  const nearMint = createWatchlistItem(card, { marketCondition: 'Near Mint' }, null, '2026-08-01T00:00:00.000Z');
  const lightlyPlayed = createWatchlistItem(card, { marketCondition: 'Lightly Played' }, null, '2026-08-02T00:00:00.000Z');
  assert.equal(findWatchedItem([legacy], card, { marketCondition: 'Near Mint' }), legacy);
  assert.equal(findWatchedItem([nearMint, lightlyPlayed], card), lightlyPlayed);
  assert.equal(findWatchedItem([lightlyPlayed], card, { marketCondition: 'Near Mint' }), null);
});

test('legacy mapped watches remain discoverable until a market condition is selected', () => {
  const canonicalVariantId = '123e4567-e89b-42d3-a456-426614174000';
  const legacy = createWatchlistItem(card, { canonicalVariantId });
  assert.equal(legacy.marketCondition, '');
  assert.equal(findWatchedItem([legacy], card, {
    canonicalVariantId,
    marketCondition: 'Near Mint'
  }), legacy);
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

test('catalog-v2 B3: a TCGCSV search result resolves an existing legacy-provider watch by name/set/number', () => {
  const legacyWatch = createWatchlistItem(card); // card.provider === 'pokemon' (see fixture above)
  const tcgcsvResult = {
    provider: 'tcgcsv', externalId: '3:1102:5001', category: 'pokemon', game: 'pokemon',
    name: card.name, setName: card.setName, number: card.number, variant: card.variant,
    price: 92, currency: 'USD'
  };
  assert.equal(findWatchedItem([legacyWatch], tcgcsvResult), legacyWatch);
  assert.equal(legacyProviderWatchMatch([legacyWatch], tcgcsvResult), legacyWatch);
});

test('catalog-v2 B3: the legacy-provider fallback never crosses two distinct cards', () => {
  const legacyWatch = createWatchlistItem(card);
  const differentCard = {
    provider: 'tcgcsv', externalId: '3:1102:5002', category: 'pokemon', game: 'pokemon',
    name: 'Blastoise ex', setName: card.setName, number: '199', variant: card.variant,
    price: 40, currency: 'USD'
  };
  assert.equal(findWatchedItem([legacyWatch], differentCard), null);
  assert.equal(legacyProviderWatchMatch([legacyWatch], differentCard), null);
  // A same-shaped tcgcsv item (not a legacy provider) is never a fallback source.
  const tcgcsvWatch = createWatchlistItem({ ...card, provider: 'tcgcsv', externalId: '3:1102:5001' });
  assert.equal(legacyProviderWatchMatch([tcgcsvWatch], {
    provider: 'tcgcsv', externalId: '3:1102:9999', category: 'pokemon', game: 'pokemon',
    name: card.name, setName: card.setName, number: card.number
  }), null);
});
