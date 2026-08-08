import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('../supabase/migrations/0014_pull_rate_unavailability_registry.sql', import.meta.url),
  'utf8'
);

test('pull-rate missing evidence is explicit, private, and append-only', () => {
  assert.match(migration, /create table public\.pull_rate_unavailability/);
  assert.match(migration, /scope in \('set', 'rarity_slot'\)/);
  assert.match(migration, /pull_rate_unavailability_append_only/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.pull_rate_unavailability from anon, authenticated/);
  assert.match(migration, /grant select, insert on public\.pull_rate_unavailability to service_role/);
  assert.match(migration, /revoke update, delete on public\.pull_rate_unavailability from service_role/);
});
