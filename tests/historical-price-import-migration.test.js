import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL(
  '../supabase/migrations/0019_centralized_historical_price_imports.sql', import.meta.url
), 'utf8');

test('centralized history migration seals exact multi-series import membership', () => {
  assert.match(migration, /create table public\.centralized_historical_price_imports/);
  assert.match(migration, /create table public\.centralized_historical_price_import_observations/);
  for (const field of [
    'dataset_sha256', 'series_set_sha256', 'observation_set_sha256',
    'stored_rows_sha256', 'quality_policy_hash', 'expected_series_count',
    'expected_observation_count', 'expected_accepted_count', 'observed_from',
    'observed_through', 'available_from', 'available_through', 'first_seen_from',
    'first_seen_through', 'availability_semantics', 'point_in_time_eligible'
  ]) assert.match(migration, new RegExp(`\\b${field}\\b`));
  assert.match(migration, /deferrable initially deferred/);
  assert.match(migration, /membership\.import_id = new\.id/);
  assert.match(migration, /actual_observation_set_sha256/);
  assert.match(migration, /actual_stored_rows_sha256/);
  assert.match(migration, /A sealed centralized-history import cannot gain observations/);
});

test('centralized history makes database first-seen time effective everywhere', () => {
  assert.match(migration, /add column source_available_at timestamptz/);
  assert.match(migration, /add column collectfolio_first_seen_at timestamptz/);
  assert.match(migration, /database_first_seen timestamptz := clock_timestamp\(\)/);
  assert.match(migration, /new\.source_available_at := new\.available_at/);
  assert.match(migration, /new\.available_at := greatest\(new\.available_at, database_first_seen\)/);
  assert.match(migration, /price_observations_000_guard_centralized_history/);
  assert.match(migration, /Centralized-history observations require an open unsealed ingestion run/);
  assert.match(migration, /from public\.source_ingestion_runs[\s\S]+for share/);
});

test('sealing serializes with inserts and freezes terminal run provenance', () => {
  assert.match(migration, /from public\.source_ingestion_runs[\s\S]+for update/);
  assert.match(migration, /source_ingestion_runs_protect_sealed_history/);
  assert.match(migration, /A sealed centralized-history ingestion run is immutable/);
  assert.match(migration, /ingestion\.status is distinct from \(case[\s\S]+end\) then/);
  assert.match(migration, /centralized_historical_price_imports_append_only/);
  assert.match(migration, /centralized_history_observation_membership_append_only/);
  assert.match(migration, /ingestion\.metadata->>'historyImportId' <> new\.id::text/);
  assert.match(migration, /ingestion\.metadata->>'availabilitySemantics' <> new\.availability_semantics/);
  assert.match(migration, /ingestion\.metadata->>'qualityPolicyHash' <> new\.quality_policy_hash/);
});

test('sealing rechecks mapping approval when rolling archives reuse stored rows', () => {
  assert.match(migration, /rolling archive may consist entirely of observations and series inserted/);
  assert.match(migration, /left join public\.external_card_mappings mapping/);
  assert.match(migration, /mapping\.review_status <> 'approved'/);
  assert.match(migration, /mapping\.mapping_confidence < 0\.98/);
  assert.match(migration, /mapping\.superseded_at is not null/);
  assert.match(migration, /mapping\.external_product_id <> series\.provider_product_id/);
  assert.match(migration, /for share of source, review/);
  assert.match(migration, /for share of mapping/);
  assert.match(migration, /Historical import requires current exact approved mappings/);
});

test('availability proxy is stored but cannot masquerade as point-in-time evidence', () => {
  assert.match(
    migration,
    /point_in_time_eligible = \(availability_semantics <> 'observed_at_proxy'\)/
  );
  assert.match(migration, /observed_at_proxy history must label its availability proxy explicitly/);
  assert.match(migration, /source_available_at is distinct from observation\.observed_at/);
  assert.match(migration, /new\.available_at := greatest\(new\.available_at, database_first_seen\)/);
  assert.match(migration, /create view public\.centralized_history_publication_evidence/);
  assert.match(migration, /with \(security_invoker = true\)/);
  assert.match(migration, /and history_import\.point_in_time_eligible/);
  assert.match(migration, /First eligibility is immutable/);
  assert.match(migration, /order by history_import\.created_at asc, history_import\.id/);
  assert.doesNotMatch(migration, /order by history_import\.created_at desc/);
  assert.match(migration, /grant select on public\.centralized_history_publication_evidence to service_role/);
});

test('centralized history remains private and installs no forecast publication path', () => {
  for (const table of [
    'centralized_historical_price_imports',
    'centralized_historical_price_import_observations'
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on public\\.${table}`));
  }
  assert.match(migration, /grant select, insert on public\.centralized_historical_price_imports to service_role/);
  assert.doesNotMatch(migration, /grant (?:select|insert|update|delete)[^;]+to (?:anon|authenticated)/i);
  assert.doesNotMatch(migration, /update\s+public\.product_feature_flags/i);
  assert.doesNotMatch(migration, /create or replace function public\.publish_forecast_intelligence/);
  assert.match(migration, /must not install a forecast publisher/);
});
