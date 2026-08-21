import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  accountBoundSyncContext,
  accountOwnedRows,
  authRedirectPath,
  chunkRecords,
  forEachInBatches,
  mergeHoldings,
  mergePortfolioSnapshots,
  mergeTombstones,
  normalizeIntelligencePublication,
  normalizePortfolioSnapshot,
  portfolioSnapshotRow,
  request,
  requestAllPages,
  requestWatchlistItems,
  remotePortfolioSnapshot,
  remoteWatchlistItem,
  sessionUserId,
  upsertInBatches,
  upsertHoldingRows,
  watchlistRow
} from '../app/assets/js/services/supabase.js';
import { PRICING_POLICY_VERSION } from '../app/assets/js/core/pricing-policy.js';

const snapshot = (overrides = {}) => ({
  id: 'portfolio:USD:2026-07-31',
  date: '2026-07-31',
  pricingPolicyVersion: PRICING_POLICY_VERSION,
  currency: 'USD',
  marketValue: 24,
  costBasis: 17,
  uniqueItems: 1,
  totalQuantity: 2,
  updatedAt: '2026-07-31T12:00:00.000Z',
  ...overrides
});

function sessionFor(userId, claimedUserId = userId) {
  const payload = Buffer.from(JSON.stringify({ sub: userId })).toString('base64url');
  return {
    access_token: `header.${payload}.signature`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: claimedUserId ? { id: claimedUserId } : undefined
  };
}

test('auth email flows return to the current application URL', () => {
  assert.equal(
    authRedirectPath('/auth/v1/otp', { origin: 'https://collectfolio.example', pathname: '/app/' }),
    '/auth/v1/otp?redirect_to=https%3A%2F%2Fcollectfolio.example%2Fapp%2F'
  );
});

test('sync identity comes from the access token and rejects conflicting session metadata', async () => {
  const userA = '30000000-0000-4000-8000-000000000001';
  const userB = '30000000-0000-4000-8000-000000000002';
  assert.equal(sessionUserId(sessionFor(userA)), userA);
  assert.throws(() => sessionUserId(sessionFor(userA, userB)), /does not match/i);
  assert.throws(() => sessionUserId({ access_token: 'not-a-jwt', user: { id: userA } }), /invalid/i);

  const context = await accountBoundSyncContext(sessionFor(userA), {
    claimOwner: async (candidate) => candidate
  });
  assert.equal(context.userId, userA);
  await assert.rejects(accountBoundSyncContext(sessionFor(userB), {
    claimOwner: async () => userA
  }), (error) => error.code === 'SYNC_ACCOUNT_MISMATCH' && /different account/i.test(error.message));
});

test('remote synchronization rows must repeat the signed-in owner', () => {
  const userA = '30000000-0000-4000-8000-000000000001';
  const userB = '30000000-0000-4000-8000-000000000002';
  const rows = [{ user_id: userA, id: 'one' }];
  assert.equal(accountOwnedRows(rows, userA, 'holdings'), rows);
  assert.throws(() => accountOwnedRows([{ user_id: userB, id: 'two' }], userA, 'holdings'), /outside the signed-in account/i);
  assert.throws(() => accountOwnedRows([{ id: 'missing-owner' }], userA, 'holdings'), /outside the signed-in account/i);
});

test('holding upserts prefer account-owned keys and only fall back for a pending migration', async () => {
  const paths = [];
  await upsertHoldingRows([{ user_id: 'user-a', id: 'holding-a' }], { access_token: 'token' }, {
    upsert: async (path) => { paths.push(path); }
  });
  assert.deepEqual(paths, ['/rest/v1/holdings?on_conflict=user_id,id']);

  paths.length = 0;
  await upsertHoldingRows([{ user_id: 'user-a', id: 'holding-a' }], { access_token: 'token' }, {
    upsert: async (path) => {
      paths.push(path);
      if (paths.length === 1) throw Object.assign(new Error('missing composite key'), { code: '42P10' });
    }
  });
  assert.deepEqual(paths, [
    '/rest/v1/holdings?on_conflict=user_id,id',
    '/rest/v1/holdings?on_conflict=id'
  ]);

  await assert.rejects(upsertHoldingRows([], {}, {
    upsert: async () => { throw Object.assign(new Error('forbidden'), { code: '42501' }); }
  }), /forbidden/);
});

test('database synchronization keys include account ownership', async () => {
  const sql = await readFile(new URL('../supabase/migrations/0021_account_owned_sync_keys.sql', import.meta.url), 'utf8');
  assert.match(sql, /holdings_pkey primary key \(user_id, id\)/i);
  assert.match(sql, /scan_sessions_pkey primary key \(user_id, id\)/i);
  assert.doesNotMatch(sql, /delete from public\.(?:holdings|scan_sessions)/i);
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

test('portfolio snapshot LWW accepts the newest valid side for each day', () => {
  const local = [
    snapshot({ marketValue: 30, updatedAt: '2026-07-31T13:00:00.000Z' }),
    snapshot({ id: 'portfolio:USD:2026-08-01', date: '2026-08-01', marketValue: 31, updatedAt: '2026-08-01T12:00:00.000Z' })
  ];
  const remote = [
    snapshot({ marketValue: 29, updatedAt: '2026-07-31T12:30:00.000Z' }),
    snapshot({ id: 'portfolio:USD:2026-08-01', date: '2026-08-01', marketValue: 32, updatedAt: '2026-08-01T13:00:00.000Z' })
  ];
  const merged = mergePortfolioSnapshots(local, remote);
  assert.deepEqual(merged.map(({ date, marketValue }) => ({ date, marketValue })), [
    { date: '2026-07-31', marketValue: 30 },
    { date: '2026-08-01', marketValue: 32 }
  ]);
});

test('portfolio snapshot remote conversion and row serialization preserve hosted identity', () => {
  const remote = remotePortfolioSnapshot({
    id: 'portfolio:USD:2026-07-31',
    data: snapshot({ updatedAt: '2026-07-31T11:00:00.000Z' }),
    snapshot_date: '2026-07-31',
    updated_at: '2026-07-31T12:00:00Z'
  });
  assert.equal(remote.updatedAt, '2026-07-31T12:00:00.000Z');
  assert.deepEqual(portfolioSnapshotRow(remote, 'user-id'), {
    user_id: 'user-id',
    id: remote.id,
    data: remote,
    snapshot_date: remote.date,
    updated_at: remote.updatedAt
  });
});

test('portfolio snapshot sync excludes legacy policy and mismatched date identities', () => {
  const priorRightsAware = snapshot({ pricingPolicyVersion: 'rights-aware-v1' });
  assert.equal(normalizePortfolioSnapshot(priorRightsAware)?.pricingPolicyVersion, 'rights-aware-v1');
  assert.equal(normalizePortfolioSnapshot(snapshot({ pricingPolicyVersion: 'legacy-v0' })), null);
  assert.equal(normalizePortfolioSnapshot(snapshot({ date: '2026-08-01' })), null);
  assert.equal(normalizePortfolioSnapshot(snapshot({ id: 'portfolio:USD:2026-02-30', date: '2026-02-30' })), null);
  assert.equal(normalizePortfolioSnapshot(snapshot({ id: 'portfolio:CAD:2026-07-31' })), null);
  assert.equal(remotePortfolioSnapshot({
    id: 'portfolio:USD:2026-07-31',
    data: snapshot(),
    snapshot_date: '2026-08-01',
    updated_at: '2026-07-31T12:00:00.000Z'
  }), null);
  assert.deepEqual(mergePortfolioSnapshots([snapshot(), snapshot({ pricingPolicyVersion: 'legacy-v0' })]), [snapshot()]);
});

test('legacy daily snapshot IDs canonicalize without losing parallel currencies', () => {
  const legacyUsd = normalizePortfolioSnapshot(snapshot({ id: 'portfolio:2026-07-31' }));
  const cad = normalizePortfolioSnapshot(snapshot({
    id: 'portfolio:CAD:2026-07-31', currency: 'CAD', marketValue: 31
  }));
  assert.equal(legacyUsd.id, 'portfolio:USD:2026-07-31');
  assert.deepEqual(mergePortfolioSnapshots([legacyUsd], [cad]).map((entry) => entry.id), [
    'portfolio:CAD:2026-07-31',
    'portfolio:USD:2026-07-31'
  ]);
  assert.equal(remotePortfolioSnapshot({
    id: 'portfolio:2026-07-31',
    data: snapshot({ id: 'portfolio:2026-07-31' }),
    snapshot_date: '2026-07-31',
    updated_at: '2026-07-31T12:00:00.000Z'
  }).id, 'portfolio:USD:2026-07-31');
});

test('portfolio snapshot sync rejects negative, non-finite, and fractional values', () => {
  for (const invalid of [
    { marketValue: -1 },
    { marketValue: Number.NaN },
    { costBasis: Number.POSITIVE_INFINITY },
    { uniqueItems: -1 },
    { uniqueItems: 1.5 },
    { totalQuantity: -1 },
    { totalQuantity: 2.5 }
  ]) assert.equal(normalizePortfolioSnapshot(snapshot(invalid)), null);
});

test('portfolio snapshot merge is deterministic with one row per currency and day', () => {
  const lowTie = snapshot({ marketValue: 20 });
  const highTie = snapshot({ marketValue: 30 });
  const forward = mergePortfolioSnapshots([lowTie], [highTie]);
  const reverse = mergePortfolioSnapshots([highTie], [lowTie]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 1);
  assert.equal(forward[0].marketValue, 30);
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
  assert.equal(local.targetCurrency, 'USD');
  assert.equal(local.catalogRef.finish, 'holofoil');

  const row = watchlistRow(local, 'user-id', '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(row.target_price, null);
  assert.equal(row.catalog_variant_id, null);
  assert.equal(row.watch_key, local.watchKey);
  assert.equal(row.catalog_snapshot.targetCurrency, 'USD');

  const conditioned = {
    ...local,
    marketCondition: 'near-mint',
    catalogRef: { ...local.catalogRef, marketCondition: '' }
  };
  const exactRow = watchlistRow(conditioned, 'user-id', '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(exactRow.market_condition, 'near-mint');
  assert.equal(exactRow.catalog_snapshot.marketCondition, 'near-mint');
  const legacyRow = watchlistRow(conditioned, 'user-id', '123e4567-e89b-42d3-a456-426614174000', {
    includeMarketCondition: false
  });
  assert.equal(Object.hasOwn(legacyRow, 'market_condition'), false);
  assert.equal(legacyRow.catalog_snapshot.marketCondition, 'near-mint');
});

test('watchlist reads fall back safely when migration 0016 is pending', async () => {
  const paths = [];
  const result = await requestWatchlistItems('watchlist-id', {
    session: { access_token: 'token' },
    requester: async (path) => {
      paths.push(path);
      if (path.includes('market_condition')) {
        throw Object.assign(new Error('column watchlist_items.market_condition does not exist'), {
          code: '42703', status: 400
        });
      }
      return [{ watch_key: 'legacy-watch' }];
    }
  });
  assert.equal(result.supportsMarketCondition, false);
  assert.deepEqual(result.rows, [{ watch_key: 'legacy-watch' }]);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /market_condition/);
  assert.doesNotMatch(paths[1], /market_condition/);

  await assert.rejects(requestWatchlistItems('watchlist-id', {
    requester: async () => {
      throw Object.assign(new Error('permission denied'), { code: '42501', status: 403 });
    }
  }), /permission denied/);
});

test('cloud request errors retain PostgREST status and code', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { COLLECTFOLIO_CONFIG: { SUPABASE_URL: 'https://cloud.example.test', SUPABASE_ANON_KEY: 'public-key' } };
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ code: '42703', message: 'column is missing' })
  });
  try {
    await assert.rejects(request('/rest/v1/watchlist_items'), (error) =>
      error.status === 400 && error.code === '42703' && /column is missing/.test(error.message));
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('cloud requests abort at their bounded deadline', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { COLLECTFOLIO_CONFIG: { SUPABASE_URL: 'https://cloud.example.test', SUPABASE_ANON_KEY: 'public-key' } };
  globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  try {
    await assert.rejects(request('/rest/v1/slow', { timeout: 5 }), (error) => error.name === 'TimeoutError' && /timed out/i.test(error.message));
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('cloud collection reads continue across deterministic range pages', async () => {
  const source = Array.from({ length: 1_205 }, (_, id) => ({ id }));
  const ranges = [];
  const rows = await requestAllPages('/rest/v1/holdings?select=id&order=id.asc', {
    pageSize: 500,
    requester: async (_path, options) => {
      ranges.push(options.headers.Range);
      const [start, end] = options.headers.Range.split('-').map(Number);
      return {
        value: source.slice(start, end + 1),
        contentRange: `${start}-${Math.min(end, source.length - 1)}/${source.length}`
      };
    }
  });
  assert.deepEqual(ranges, ['0-499', '500-999', '1000-1499']);
  assert.equal(rows.length, source.length);
  assert.equal(rows.at(-1).id, 1_204);
});

test('cloud collection pagination fails closed at its record safety limit', async () => {
  await assert.rejects(requestAllPages('/rest/v1/holdings?select=id', {
    pageSize: 2,
    maximumRecords: 3,
    requester: async (_path, options) => {
      const start = Number(options.headers.Range.split('-')[0]);
      return { value: [{ id: start }, { id: start + 1 }], contentRange: `${start}-${start + 1}/*` };
    }
  }), /3-record safety limit/i);
});

test('cloud collection pagination rejects an oversized exact count after one page', async () => {
  let requests = 0;
  await assert.rejects(requestAllPages('/rest/v1/holdings?select=id', {
    pageSize: 2,
    maximumRecords: 3,
    requester: async () => {
      requests += 1;
      return { value: [{ id: 0 }, { id: 1 }], contentRange: '0-1/4' };
    }
  }), /3-record safety limit/i);
  assert.equal(requests, 1);
});

test('cloud collection pagination detects a smaller undeclared server row cap', async () => {
  const source = Array.from({ length: 1_205 }, (_, id) => ({ id }));
  const ranges = [];
  const rows = await requestAllPages('/rest/v1/holdings?select=id&order=id.asc', {
    pageSize: 500,
    requester: async (_path, options) => {
      ranges.push(options.headers.Range);
      assert.equal(options.headers.Prefer, 'count=exact');
      const start = Number(options.headers.Range.split('-')[0]);
      return {
        value: source.slice(start, start + 200),
        contentRange: `${start}-${Math.min(start + 199, source.length - 1)}/${source.length}`
      };
    }
  });
  assert.equal(rows.length, source.length);
  assert.deepEqual(ranges.slice(0, 3), ['0-499', '200-699', '400-899']);
});

test('cloud upserts and delete work are split into bounded batches', async () => {
  assert.deepEqual(chunkRecords([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const bodies = [];
  await upsertInBatches('/rest/v1/holdings', [1, 2, 3, 4, 5], {
    batchSize: 2,
    requester: async (_path, options) => { bodies.push(options.body); }
  });
  assert.deepEqual(bodies, [[1, 2], [3, 4], [5]]);

  let active = 0;
  let maximumActive = 0;
  const visited = [];
  await forEachInBatches([1, 2, 3, 4, 5], async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    visited.push(value);
    active -= 1;
  }, 2);
  assert.equal(maximumActive, 2);
  assert.deepEqual(visited.sort((left, right) => left - right), [1, 2, 3, 4, 5]);
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
