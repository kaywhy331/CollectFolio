import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationPath = new URL(
  '../supabase/migrations/0006_price_intelligence_governance_hardening.sql',
  import.meta.url
);
const migration = await readFile(migrationPath, 'utf8');

test('database publication predicate includes the server kill switch and attribution', () => {
  const predicate = migration.match(
    /create or replace function public\.intelligence_publication_is_permitted[\s\S]*?\n\$\$;/
  )?.[0] ?? '';

  assert.match(predicate, /flag\.key = 'public_price_intelligence'/);
  assert.match(predicate, /and flag\.enabled/);
  assert.match(predicate, /review\.attribution_required/);
  assert.match(predicate, /jsonb_array_elements\(publication\.source_attributions\)/);
  assert.doesNotMatch(migration, /update\s+public\.product_feature_flags[\s\S]*public_price_intelligence/i);
});

test('scored and static-model contracts fail closed on null lineage', () => {
  assert.ok(
    migration.indexOf('alter column training_dataset_hash drop not null') <
      migration.indexOf('training_dataset_hash = case'),
    'legacy static rows must become nullable before their old digest is cleared'
  );
  assert.match(migration, /when config->>'trainingMode' = 'none_static_baseline' then null/);
  assert.match(migration, /model_versions_training_lineage_check[\s\S]*training_mode = 'trained' and training_dataset_hash is not null/);
  assert.match(migration, /training_mode = 'none_static_baseline' and training_dataset_hash is null/);
  assert.match(migration, /evaluation_status = 'scored'[\s\S]*realized_price is not null and realized_price > 0/);
  assert.match(migration, /observation_count is not null and observation_count > 0/);
  assert.match(migration, /absolute_log_error is not null and absolute_log_error >= 0/);
});

test('mapping correction is a one-to-one validated supersession', () => {
  assert.match(migration, /external_card_mappings_single_successor/);
  assert.match(migration, /validate_external_mapping_supersession/);
  assert.match(migration, /previous\.source_id <> new\.source_id/);
  assert.match(migration, /previous\.mapping_version = new\.mapping_version/);
  assert.match(migration, /Mapping identity is immutable; create a superseding mapping version/);
  assert.match(migration, /revoke update, delete on public\.external_card_mappings from service_role/);
});

test('promotion review binds model, exact scorecard membership, policy, and operator identity', () => {
  assert.match(migration, /scorecard_model <> new\.model_version_id/);
  assert.match(migration, /membership_count <> scorecard_matured_count/);
  assert.match(migration, /included_count <> scorecard_evaluation_count/);
  assert.match(migration, /missingRequiredBaselines' is distinct from '\[\]'::jsonb/);
  assert.match(migration, /requiredBaselines[\s\S]*no_change[\s\S]*structural_convergence/);
  assert.match(migration, /new\.reviewer_user_id is distinct from auth\.uid\(\)/);
  assert.match(migration, /price_intelligence_operator/);
  assert.match(migration, /create or replace function public\.review_model_promotion/);
  assert.match(migration, /revoke insert on public\.model_promotion_reviews from service_role/);
  assert.match(migration, /to authenticated;/);
});

test('publication writes and per-card rollback remain RPC-only', () => {
  assert.match(migration, /alter function public\.publish_descriptive_intelligence\(uuid\) security definer/);
  assert.match(migration, /revoke insert, update, delete on public\.card_intelligence_publications\s+from service_role/);
  assert.match(migration, /create or replace function public\.disable_public_intelligence/);
  assert.match(migration, /intelligence_publication_control_events_append_only/);
});
