import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL(
    "../supabase/migrations/0020_tcgcsv_market_universe.sql",
    import.meta.url,
  ),
  "utf8",
);
const adapter = await readFile(
  new URL(
    "../analytics/src/collectfolio_analytics/tcgcsv_universe_io.py",
    import.meta.url,
  ),
  "utf8",
);
const cli = await readFile(
  new URL(
    "../analytics/src/collectfolio_analytics/tcgcsv_universe_cli.py",
    import.meta.url,
  ),
  "utf8",
);
const workflow = await readFile(
  new URL("../.github/workflows/tcgcsv-market-universe.yml", import.meta.url),
  "utf8",
);
const analyticsWorkflow = await readFile(
  new URL("../.github/workflows/analytics-check.yml", import.meta.url),
  "utf8",
);

test("TCGCSV universe migration separates immutable history from current state", () => {
  for (const table of [
    "tcgcsv_archive_runs",
    "tcgcsv_archive_group_receipts",
    "tcgcsv_price_stage",
    "tcgcsv_price_current",
    "tcgcsv_market_features_current",
    "tcgcsv_set_features_current",
    "tcgcsv_catalog_runs",
    "tcgcsv_categories_current",
    "tcgcsv_groups_current",
    "tcgcsv_products_current",
    "tcgcsv_unresolved_products",
    "tcgcsv_sync_state",
  ])
    assert.match(migration, new RegExp(`create table public\\.${table}`));

  assert.match(migration, /object_uri text not null/);
  assert.match(migration, /parquet_uri text not null/);
  assert.match(migration, /feature_object_uri text not null/);
  assert.match(migration, /set_feature_object_uri text not null/);
  const privateObjectUriContract = "^s3://[^/?#@]+/[^?#@]+$";
  assert.equal(
    migration.split(`~ '${privateObjectUriContract}'`).length - 1,
    4,
  );
  assert.doesNotMatch(migration, /object_uri ~ '\^\[a-z\]/);
  assert.match(migration, /archive_sha256 text not null/);
  assert.match(migration, /source_available_at timestamptz not null/);
  assert.match(migration, /check \(source_available_at >= source_updated_at\)/);
  assert.match(migration, /parquet_sha256 text not null/);
  assert.match(migration, /normalized_csv_sha256 text not null/);
  assert.match(migration, /feature_csv_sha256 text not null/);
  assert.match(migration, /set_feature_csv_sha256 text not null/);
  assert.match(migration, /catalog_content_sha256 text not null/);
  assert.equal(
    (migration.match(/current_state_applied boolean/g) ?? []).length,
    2,
  );
  assert.match(migration, /unique \(source_id, archive_date\)/);
  assert.match(migration, /unique \(source_id, source_updated_at\)/);
});

test("TCGCSV archive finalize is count-bound, idempotent, and all-series", () => {
  assert.match(
    migration,
    /create or replace function public\.begin_tcgcsv_archive_run/,
  );
  assert.match(
    migration,
    /create or replace function public\.finalize_tcgcsv_archive_run/,
  );
  assert.match(
    migration,
    /archive date already exists with different identity/,
  );
  assert.match(migration, /actual_feature_count <> actual_price_count/);
  assert.match(migration, /actual_set_feature_count <> actual_group_count/);
  assert.match(migration, /group receipts do not cover the staged price rows/);
  assert.match(migration, /staged price tuple hash is invalid/);
  assert.match(
    migration,
    /source timestamp already exists with different content/,
  );
  assert.match(
    migration,
    /on conflict \(source_id, category_id, group_id, product_id, subtype_name\)/,
  );
  assert.match(
    migration,
    /delete from public\.tcgcsv_price_current current_price/,
  );
  assert.match(migration, /insert into public\.tcgcsv_unresolved_products/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.equal(
    (migration.match(/if apply_current_state then/g) ?? []).length,
    2,
  );
  assert.equal((migration.match(/'currentStateApplied',/g) ?? []).length, 4);
  assert.match(migration, /state\.latest_archive_date > run_row\.archive_date/);
  assert.match(
    migration,
    /state\.latest_source_updated_at > run_row\.source_updated_at/,
  );
  assert.match(migration, /current_state_applied = apply_current_state/);
  assert.doesNotMatch(adapter, /on conflict do nothing/i);
  assert.match(adapter, /unsafe partial retry and fail closed/);
  assert.match(adapter, /def _verify_packet_file/);
  assert.match(adapter, /label="normalized CSV"/);
  assert.match(adapter, /catalog packet content hash changed/);
  assert.match(workflow, /source_updated_at=.*GITHUB_OUTPUT/);
  assert.match(workflow, /--source-updated-at/);
  assert.match(cli, /sourceAvailableAt/);
  assert.match(adapter, /packet\["sourceAvailableAt"\]/);
  assert.match(adapter, /features\["featureObjectUri"\]/);
  assert.match(adapter, /features\["setFeatureObjectUri"\]/);
  assert.match(workflow, /market-features\.csv/);
  assert.match(workflow, /set-features\.csv/);
  assert.match(
    cli,
    /if not args\.archive_file:[\s\S]+TCGCSV changed during archive preparation/,
  );
});

test("TCGCSV catalog refresh is independent and can complete partially", () => {
  assert.match(
    migration,
    /create or replace function public\.begin_tcgcsv_catalog_run/,
  );
  assert.match(
    migration,
    /create or replace function public\.finalize_tcgcsv_catalog_run/,
  );
  assert.match(migration, /completed_with_gaps boolean default false/);
  assert.match(
    migration,
    /when completed_with_gaps then 'partial' else 'sealed'/,
  );
  assert.match(
    migration,
    /update public\.tcgcsv_unresolved_products unresolved/,
  );
  assert.match(
    migration,
    /state\.latest_catalog_updated_at > run_row\.source_updated_at/,
  );
  assert.match(adapter, /def export_catalog_snapshot/);
  assert.match(adapter, /set transaction isolation level repeatable read/);
  assert.match(adapter, /catalogAvailableAt/);
  assert.match(adapter, /catalogSnapshotContentSha256/);
  assert.match(cli, /export-catalog-snapshot/);
  assert.match(workflow, /TCGCSV_STRUCTURAL_GAP_LAB_ENABLED == 'true'/);
  assert.match(workflow, /collectfolio_analytics\.structural_gap_cli/);
  assert.match(workflow, /origin_at=\$\(jq -r '\.catalogAvailableAt'/);
  assert.match(
    workflow,
    /origin_date='\$\{\{ steps\.structural_gap\.outputs\.origin_date \}\}'/,
  );
  assert.match(workflow, /origin_date=\$\{origin_date\}\/structural-gap\.json/);
  assert.match(analyticsWorkflow, /image: postgres:16/);
  assert.match(
    analyticsWorkflow,
    /python tests\/postgres\/run_forecast_runtime\.py/,
  );
  assert.match(
    analyticsWorkflow,
    /python tests\/postgres\/run_tcgcsv_universe_runtime\.py/,
  );
});

test("TCGCSV universe remains private research-only", () => {
  assert.match(migration, /source_row\.code <> 'tcgcsv-research'/);
  assert.match(migration, /review_row\.decision <> 'research_only'/);
  for (const permission of [
    "commercial_use_allowed",
    "catalog_metadata_allowed",
    "image_display_allowed",
    "public_raw_display_allowed",
    "public_derived_display_allowed",
  ])
    assert.match(migration, new RegExp(`review_row\\.${permission}`));

  assert.match(migration, /create role collectfolio_tcgcsv_ingest/);
  assert.match(
    migration,
    /nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls/,
  );
  assert.match(
    migration,
    /alter table public\.tcgcsv_market_features_current enable row level security/,
  );
  assert.doesNotMatch(
    migration,
    /grant (?:select|insert|update|delete)[^;]+to (?:anon|authenticated)/i,
  );
  assert.doesNotMatch(migration, /update\s+public\.product_feature_flags/i);
  assert.doesNotMatch(
    migration,
    /publish_(?:forecast|descriptive)_intelligence/,
  );

  const publicArtifactBlock = workflow.slice(
    workflow.indexOf("uses: actions/upload-artifact@v4"),
  );
  for (const sensitive of [
    "archive-packet.json",
    "catalog-packet.json",
    "catalog-snapshot.json",
    "structural-gap.json",
  ])
    assert.doesNotMatch(
      publicArtifactBlock,
      new RegExp(`\\.tcgcsv-run/${sensitive.replace(".", "\\.")}\\b`),
    );
  assert.match(publicArtifactBlock, /archive-ingest-receipt\.json/);
});
