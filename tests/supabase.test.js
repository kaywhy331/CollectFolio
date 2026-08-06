import test from 'node:test';
import assert from 'node:assert/strict';
import { authRedirectPath, mergeHoldings, mergeTombstones, normalizeIntelligencePublication, remoteWatchlistItem, watchlistRow } from '../app/assets/js/services/supabase.js';

test('auth email flows return to the current application URL', () => {
  assert.equal(
    authRedirectPath('/auth/v1/otp', { origin: 'https://collectfolio.example', pathname: '/app/' }),
    '/auth/v1/otp?redirect_to=https%3A%2F%2Fcollectfolio.example%2Fapp%2F'
  );
});

test('tombstones merge by holding ID and retain newest ISO deletion', () => {
  const merged = mergeTombstones(
    [{ id: 'one', deletedAt: '2026-01-01T00:00:00.000Z' }],
    [{ id: 'one', deletedAt: '2026-02-01T00:00:00.000Z' }, { id: 'two', deletedAt: '2026-01-15T00:00:00.000Z' }]
  ).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(merged.map(({ id, deletedAt }) => ({ id, deletedAt })), [
    { id: 'one', deletedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'two', deletedAt: '2026-01-15T00:00:00.000Z' }
  ]);
});

test('last-write-wins merge uses ISO updatedAt at holding granularity', () => {
  const local = [{ id: 'same', notes: 'local', updatedAt: '2026-03-02T00:00:00.000Z' }, { id: 'local-only', updatedAt: '2026-01-01T00:00:00.000Z' }];
  const remote = [{ id: 'same', notes: 'remote', updatedAt: '2026-03-01T00:00:00.000Z' }, { id: 'remote-only', updatedAt: '2026-01-01T00:00:00.000Z' }];
  const merged = mergeHoldings(local, remote);
  assert.equal(merged.find((holding) => holding.id === 'same').notes, 'local');
  assert.deepEqual(new Set(merged.map((holding) => holding.id)), new Set(['same', 'local-only', 'remote-only']));
});

test('remote LWW updates retain images that intentionally stay on this device', () => {
  const local = [{ id: 'same', notes: 'local', userImage: 'data:image/jpeg;base64,local-only', updatedAt: '2026-03-01T00:00:00.000Z' }];
  const remote = [{ id: 'same', notes: 'remote', userImage: '', updatedAt: '2026-03-02T00:00:00.000Z' }];
  const [merged] = mergeHoldings(local, remote);
  assert.equal(merged.notes, 'remote');
  assert.equal(merged.userImage, local[0].userImage);
});

test('two-client deletion tombstone wins over newer holding copies', () => {
  const clientA = [{ id: 'deleted', updatedAt: '2026-04-02T00:00:00.000Z' }, { id: 'kept', updatedAt: '2026-04-01T00:00:00.000Z' }];
  const clientB = [{ id: 'deleted', updatedAt: '2026-04-03T00:00:00.000Z' }];
  const tombstones = mergeTombstones([{ id: 'deleted', deletedAt: '2026-04-01T12:00:00.000Z' }]);
  const merged = mergeHoldings(clientA, clientB, new Set(tombstones.map((entry) => entry.id)));
  assert.deepEqual(merged.map((holding) => holding.id), ['kept']);
});

test('watchlist cloud rows preserve exact catalog identity and blank optional alerts', () => {
  const local = remoteWatchlistItem({
    watch_key: 'source:v1:pokemon:sv3-223:en:standard:holofoil:raw',
    catalog_variant_id: null,
    catalog_snapshot: { name: 'Charizard ex', finish: 'holofoil' },
    target_price: null,
    alert_percent_change: null,
    notes: '',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z'
  });
  assert.equal(local.targetPrice, '');
  assert.equal(local.catalogRef.finish, 'holofoil');

  const row = watchlistRow(local, 'user-id', '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(row.target_price, null);
  assert.equal(row.catalog_variant_id, null);
  assert.equal(row.watch_key, local.watchKey);
});

test('public intelligence normalization clamps support tier and rejects malformed payload shapes', () => {
  const normalized = normalizeIntelligencePublication({
    catalog_variant_id: '123e4567-e89b-42d3-a456-426614174000',
    support_tier: 99,
    publication_status: 'published',
    reason_codes: ['fresh'],
    payload: ['not', 'an', 'object'],
    source_attributions: [{ name: 'Approved source' }]
  });
  assert.equal(normalized.supportTier, 5);
  assert.deepEqual(normalized.payload, {});
  assert.equal(normalized.sourceAttributions[0].name, 'Approved source');
});
