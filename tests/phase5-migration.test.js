import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clearApplicationCacheStorage, MAX_BACKUP_FILE_BYTES, readBackupFile, validateBackup, validateBackupFile } from '../app/assets/js/core/db.js';

const validBackup = () => ({
  format: 'collectfolio-backup',
  version: 2,
  stores: {
    holdings: [{ id: 'holding-one', item: { name: 'Safe card' } }],
    settings: [{ key: 'currency', value: 'USD' }]
  }
});

test('backup preflight builds a complete write plan before import', () => {
  const plan = validateBackup(validBackup());
  assert.deepEqual(plan.map(([name]) => name), ['holdings', 'settings']);
  const invalid = validBackup();
  invalid.stores.settings.push({ value: 'missing key' });
  assert.throws(() => validateBackup(invalid), /settings data section contains an invalid record/i);
});

test('legacy version-1 backups remain accepted under store-aware validation', () => {
  const legacy = validBackup();
  legacy.version = 1;
  legacy.stores.holdings[0] = {
    id: 'legacy-holding',
    item: { provider: 'custom', category: 'other', name: 'Legacy collectible', price: null },
    quantity: 1,
    purchasePrice: '',
    fees: '',
    manualMarketPrice: ''
  };
  assert.deepEqual(validateBackup(legacy).map(([name]) => name), ['holdings', 'settings']);
});

test('backup preflight rejects duplicate, unknown, and private activity records', () => {
  const duplicate = validBackup();
  duplicate.stores.holdings.push({ ...duplicate.stores.holdings[0] });
  assert.throws(() => validateBackup(duplicate), /duplicate record/i);
  assert.throws(() => validateBackup({ ...validBackup(), stores: { mystery: [] } }), /unsupported data section/i);
  assert.throws(() => validateBackup({ ...validBackup(), stores: { demandEventsQueue: [] } }), /private activity data/i);
});

test('backup preflight validates store schemas before malformed records can reach rendering', () => {
  const malformedTags = validBackup();
  malformedTags.stores.holdings[0].tags = {};
  assert.throws(() => validateBackup(malformedTags), /holdings data section contains an invalid record/i);

  const malformedScan = validBackup();
  malformedScan.stores.scans = [{ id: 'scan-one', status: 'review', crops: [{ id: 'crop-one', candidates: {} }] }];
  assert.throws(() => validateBackup(malformedScan), /scans data section contains an invalid record/i);

  const malformedWatch = validBackup();
  malformedWatch.stores.watchlistItems = [{ id: 'watch-one', watchKey: 'watch-one', catalogRef: [] }];
  assert.throws(() => validateBackup(malformedWatch), /watchlistItems data section contains an invalid record/i);

  const malformedCache = validBackup();
  malformedCache.stores.catalogCache = [{ key: 'catalog:v1:bad', expiresAt: Date.now() + 1000, value: 'bad' }];
  assert.throws(() => validateBackup(malformedCache), /catalogCache data section contains an invalid record/i);
});

test('backup files are bounded before the browser reads and parses them', async () => {
  const valid = { size: MAX_BACKUP_FILE_BYTES };
  assert.equal(validateBackupFile(valid), valid);
  assert.throws(() => validateBackupFile({ size: 0 }), /empty/i);
  assert.throws(() => validateBackupFile({ size: MAX_BACKUP_FILE_BYTES + 1 }), /128 MB or smaller/i);
  assert.throws(() => validateBackupFile(null), /valid CollectFolio backup/i);
  let read = false;
  await assert.rejects(readBackupFile({
    size: MAX_BACKUP_FILE_BYTES + 1,
    text: async () => { read = true; return '{}'; }
  }), /128 MB or smaller/i);
  assert.equal(read, false);
});

test('device clearing removes every CollectFolio CacheStorage bucket only', async () => {
  const deleted = [];
  const count = await clearApplicationCacheStorage({
    keys: async () => ['collectfolio-shell-v0.7.0', 'collectfolio-provider-images-v1', 'unrelated-site-cache'],
    delete: async (key) => { deleted.push(key); return true; }
  });
  assert.equal(count, 2);
  assert.deepEqual(deleted, ['collectfolio-shell-v0.7.0', 'collectfolio-provider-images-v1']);
});

test('cloud removal migration is auth-scoped, transactional, and retains the account', async () => {
  const sql = await readFile(new URL('../supabase/migrations/0015_remove_my_cloud_data.sql', import.meta.url), 'utf8');
  assert.match(sql, /^begin;/m);
  assert.match(sql, /current_user_id uuid := auth\.uid\(\)/);
  for (const table of ['holdings', 'holding_deletions', 'portfolio_snapshots', 'scan_sessions', 'watchlists', 'watchlist_items', 'watchlist_deletions', 'demand_events', 'artwork_pairwise_votes']) {
    assert.match(sql, new RegExp(`delete from public\\.${table} where user_id = current_user_id`));
  }
  assert.match(sql, /reject_artwork_vote_mutation_unless_erasure/);
  assert.match(sql, /current_user = erasure_function_owner/);
  assert.match(sql, /current_setting\('collectfolio\.cloud_erasure_user_id', true\) = old\.user_id::text/);
  assert.match(sql, /set_config\('collectfolio\.cloud_erasure_user_id', current_user_id::text, true\)/);
  assert.match(sql, /'artworkVotes', removed_artwork_votes/);
  assert.doesNotMatch(sql, /delete from auth\.users|delete from public\.profiles/i);
  assert.match(sql, /grant execute on function public\.remove_my_cloud_data\(\) to authenticated/);
  assert.match(sql, /revoke all on function public\.remove_my_cloud_data\(\) from public, anon, authenticated, service_role/);
  assert.match(sql, /commit;\s*$/);
});
