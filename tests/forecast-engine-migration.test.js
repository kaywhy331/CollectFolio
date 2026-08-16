import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL(
  '../supabase/migrations/0016_forecast_engine_v1.sql', import.meta.url
), 'utf8');
const prospectiveMigration = await readFile(new URL(
  '../supabase/migrations/0017_private_prospective_forecast_ledger.sql', import.meta.url
), 'utf8');
const executionMigration = await readFile(new URL(
  '../supabase/migrations/0018_forecast_execution_and_scorecards.sql', import.meta.url
), 'utf8');

test('forecast migration installs immutable exact market-series identity', () => {
  assert.match(migration, /create table public\.market_series/);
  for (const field of [
    'catalog_variant_id', 'source_id', 'mapping_id', 'provider_product_id',
    'provider_variant_key', 'mapping_version', 'currency', 'language', 'finish',
    'condition_class', 'market_condition', 'price_semantics', 'identity_hash'
  ]) assert.match(migration, new RegExp(`\\b${field}\\b`));
  assert.match(migration, /Market series requires the current exact approved provider mapping/);
  assert.match(migration, /Market series language, finish, and condition class must match the catalog variant/);
  assert.match(migration, /market_series_append_only/);
  assert.match(migration, /alter table public\.market_series enable row level security/);
  assert.equal((migration.match(/pg_get_constraintdef\(constraint_row\.oid\)/g) || []).length, 2);
  assert.match(migration, /Legacy trend snapshot run\/variant\/source uniqueness is absent/);
  assert.match(migration, /Legacy forecast model\/variant\/origin\/horizon uniqueness is absent/);
  assert.match(migration, /create or replace function public\.guard_trend_snapshot_run_state\(\)/);
  assert.match(migration, /trend_feature_snapshots_000_guard_run/);
  assert.match(migration, /from public\.analytics_runs[\s\S]+for share/);
  assert.match(migration, /Trend snapshots require a running unfinished trend_build analytics run/);
  assert.doesNotMatch(
    migration,
    /drop constraint trend_feature_snapshots_analytics_run_id_variant_id_source_id_key/
  );
});

test('prediction, evaluation, and scorecard evidence modes are linked and v1 is retrospective-only', () => {
  assert.match(migration, /Prediction and evaluation evidence modes differ/);
  assert.match(migration, /evaluation_mode <> scorecard_mode/);
  assert.match(migration, /Forecast Engine v1 cannot accept caller-declared prospective evidence/);
  assert.equal((migration.match(/check \(evidence_mode = 'retrospective'\)/g) || []).length, 3);
  assert.match(migration, /Retrospective evidence cannot authorize model promotion/);
  assert.match(migration, /Approved promotion requires the authenticated price-intelligence operator/);
  assert.match(migration, /Approved promotion requires complete versioned scorecard membership/);
  assert.match(migration, /Approved promotion does not satisfy the declared five-baseline policy/);
  assert.match(migration, /Forecast Engine v1 has no public promotion path/);
  assert.doesNotMatch(migration, /create or replace function public\.publish_forecast_intelligence/);
});

test('scored labels are database-derived from immutable same-series observations', () => {
  assert.match(migration, /create table public\.forecast_evaluation_observations/);
  assert.match(migration, /references public\.price_observations\(id\)/);
  assert.match(migration, /observation_series is distinct from prediction_series/);
  assert.match(migration, /observation_time not between window_start and window_end/);
  assert.match(migration, /select distinct on \(observation\.observed_at\)/);
  assert.match(migration, /percentile_cont\(0\.5\) within group/);
  assert.match(migration, /derived_pinball := jsonb_build_object/);
  assert.match(migration, /derived_hash := encode\(digest/);
  assert.match(migration, /Scored evaluation accepts only identity, run, prediction, and evaluation time/);
  assert.match(migration, /create or replace function public\.record_unscorable_forecast_evaluation/);
  assert.match(migration, /A forecast with canonical maturity observations cannot be marked unscorable/);
  assert.match(migration, /Forecast evaluation must belong to its completed point-in-time evaluation run/);
  assert.match(migration, /revoke insert on public\.forecast_evaluations from service_role/);
  assert.doesNotMatch(migration, /grant select, insert on public\.forecast_evaluation_observations/);
  assert.doesNotMatch(migration, /record_scored_forecast_evaluation\(jsonb,uuid\[\]\)/);
});

test('migration is fail-closed and never mutates the public feature flag', () => {
  assert.match(migration, /Apply Forecast Engine v1 only while public_price_intelligence is disabled/);
  assert.match(migration, /Forecast Engine v1 must leave public_price_intelligence disabled/);
  assert.doesNotMatch(migration, /update\s+public\.product_feature_flags/i);
  assert.match(migration, /to_regprocedure\('public\.publish_forecast_intelligence\(uuid\)'\) is not null/);
});

test('legacy descriptive publication lineage remains intact', () => {
  assert.doesNotMatch(migration, /alter table public\.card_intelligence_publications/);
  assert.doesNotMatch(migration, /alter table public\.intelligence_publication_sources/);
  assert.doesNotMatch(migration, /drop column catalog_variant_id/);
  assert.doesNotMatch(migration, /delete from public\.intelligence_publication_sources/);
});

test('prospective ledger seals a private exact-series universe and origin-time costs', () => {
  for (const table of [
    'trend_expected_input_manifests',
    'prospective_forecast_runs',
    'prospective_candidate_universes',
    'prospective_candidate_universe_members',
    'prospective_acquisition_cost_quotes'
  ]) {
    assert.match(prospectiveMigration, new RegExp(`create table public\\.${table}`));
    assert.match(prospectiveMigration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  for (const field of [
    'market_series_id', 'terms_review_id', 'model_artifact_hash', 'origin',
    'horizon_days', 'selection_policy_hash', 'universe_snapshot_hash',
    'submission_hash', 'input_manifest_id', 'input_manifest_hash',
    'expected_series_count', 'expected_series_hash', 'quote_observed_at', 'captured_at',
    'all_in_acquisition_cost', 'break_even_resale_price',
    'liquidity_adjusted_break_even_reference'
  ]) assert.match(prospectiveMigration, new RegExp(`\\b${field}\\b`));
  for (const right of [
    'private_forecast_modeling_allowed', 'prospective_capture_allowed',
    'exact_condition_labels_allowed', 'retention_through_maturity_allowed',
    'liquidity_derivation_allowed', 'predictive_derivatives_allowed'
  ]) assert.match(prospectiveMigration, new RegExp(`\\b${right}\\b`));
  assert.match(prospectiveMigration, /not terms\.exact_condition_labels_allowed/);
  assert.match(prospectiveMigration, /not terms\.retention_through_maturity_allowed/);
  assert.match(prospectiveMigration, /not terms\.predictive_derivatives_allowed/);
  assert.match(prospectiveMigration, /not quote_terms\.retention_through_maturity_allowed/);
  assert.match(prospectiveMigration, /not quote_terms\.predictive_derivatives_allowed/);
  assert.match(prospectiveMigration, /not quote_terms\.liquidity_derivation_allowed/);
  assert.match(prospectiveMigration, /Every prospective candidate requires an origin-time cost-quote state/);
  assert.match(prospectiveMigration, /After-cost universes require complete cost and liquidity evidence/);
  assert.match(
    prospectiveMigration,
    /liquidity_adjusted_break_even_reference[\s\S]+offer_price \* \(1 \+ tax_rate\) \+ buy_shipping \+ sell_shipping \+ sell_fee_fixed[\s\S]+\(\(1 - sell_fee_rate\) \* \(1 - liquidity_haircut_rate\)\)/
  );
  assert.match(prospectiveMigration, /quote_semantics = 'provider_listing' or liquidity_status = 'unknown'/);
  assert.match(prospectiveMigration, /User-entered cost quotes cannot claim provider lineage or source-backed liquidity/);
});

test('prospective status and time are database-authored in one bounded atomic RPC', () => {
  assert.match(prospectiveMigration, /create or replace function public\.record_prospective_forecast_run/);
  assert.match(prospectiveMigration, /create or replace function public\.seal_trend_expected_input_manifest/);
  assert.match(prospectiveMigration, /recorded_origin timestamptz := clock_timestamp\(\)/);
  assert.match(prospectiveMigration, /Prospective run accepts only preregistered run, model, horizon, purpose, and policy identifiers/);
  assert.match(prospectiveMigration, /Prospective evidence mode is database-derived and requires sealed ledger lineage/);
  assert.match(prospectiveMigration, /current_setting\('collectfolio\.recording_prospective_forecast'/);
  assert.match(prospectiveMigration, /Supplied predictions do not cover the complete deterministic candidate universe/);
  assert.match(prospectiveMigration, /Candidate universe policy was not preregistered in the immutable forecast run/);
  assert.match(prospectiveMigration, /forecast_run\.status <> 'succeeded'/);
  assert.match(prospectiveMigration, /trend_run\.status <> 'succeeded'/);
  assert.match(prospectiveMigration, /maximumFeatureAgeHours/);
  assert.match(prospectiveMigration, /policy->>'priceSemantics' is distinct from 'market'/);
  assert.match(prospectiveMigration, /minimum_evidence < 0\.55/);
  assert.match(prospectiveMigration, /trend_run\.feature_cutoff < recorded_origin/);
  assert.match(prospectiveMigration, /snapshot\.feature_cutoff < recorded_origin/);
  assert.match(prospectiveMigration, /Prospective features must come from one fresh completed point-in-time trend run/);
  assert.match(prospectiveMigration, /Expected-input manifest must be sealed before trend outputs exist/);
  assert.match(prospectiveMigration, /Succeeded trend run does not match its independently sealed exact-series input manifest/);
  assert.match(prospectiveMigration, /actual_series_hash <> input_manifest\.expected_series_hash/);
  assert.match(prospectiveMigration, /input_manifest\.manifest_hash/);
  assert.match(prospectiveMigration, /Atomic prospective packet is incomplete/);
  assert.match(prospectiveMigration, /recorded_origin \+ interval '5 minutes'/);
  assert.match(prospectiveMigration, /clock_timestamp\(\) >= sealed_run\.matures_at/);
  assert.doesNotMatch(
    prospectiveMigration,
    /requested_run->>'(?:origin|createdAt|evidenceMode|candidateUniverseId|universeSnapshotHash)'/
  );
});

test('prospective evaluations use database time and serialize with scorecard creation', () => {
  const evaluationLineage = prospectiveMigration.match(
    /create or replace function public\.validate_forecast_evaluation_lineage\(\)[\s\S]+?\n\$\$;/
  )?.[0];
  assert.ok(evaluationLineage, 'prospective evaluation lineage function is absent');
  assert.match(prospectiveMigration, /database_evaluated_at := clock_timestamp\(\)/);
  assert.match(prospectiveMigration, /database_evaluated_at < prediction_maturity/);
  assert.match(prospectiveMigration, /evaluation_run_status <> 'succeeded'/);
  assert.match(prospectiveMigration, /new\.evaluated_at := database_evaluated_at/);
  assert.match(prospectiveMigration, /new\.created_at := database_evaluated_at/);
  assert.match(prospectiveMigration, /new\.evaluation_hash := encode\(digest\(concat_ws/);
  assert.match(evaluationLineage, /from public\.analytics_runs[\s\S]+for share/);
  assert.match(
    evaluationLineage,
    /from public\.model_scorecards scorecard[\s\S]+scorecard\.analytics_run_id = new\.analytics_run_id/
  );
  assert.match(
    evaluationLineage,
    /Prospective evaluation run is frozen after scorecard creation/
  );
  assert.match(prospectiveMigration, /Keep 0016's model_scorecards evidence-mode constraint retrospective-only/);
  assert.doesNotMatch(prospectiveMigration, /alter table public\.model_scorecards/);
  assert.doesNotMatch(prospectiveMigration, /validate_prospective_scorecard_universe/);
  assert.doesNotMatch(prospectiveMigration, /model_scorecards_validate_prospective_universe/);
});

test('prospective ledger is append-only, RPC-only, and has no publication path', () => {
  assert.match(prospectiveMigration, /Service role must create prospective evidence only through the guarded RPC/);
  assert.match(prospectiveMigration, /grant execute on function public\.record_prospective_forecast_run\(jsonb,jsonb\)\s+to service_role/);
  assert.match(prospectiveMigration, /grant execute on function public\.seal_trend_expected_input_manifest\(uuid\)\s+to service_role/);
  assert.match(prospectiveMigration, /Prospective forecast and cost evidence must remain private/);
  assert.match(prospectiveMigration, /Prospective ledger must leave public_price_intelligence disabled/);
  assert.match(prospectiveMigration, /Prospective ledger must not install a public forecast publisher/);
  assert.doesNotMatch(prospectiveMigration, /create or replace function public\.publish_forecast_intelligence/);
  assert.doesNotMatch(prospectiveMigration, /update\s+public\.product_feature_flags/i);
  assert.doesNotMatch(prospectiveMigration, /grant (?:select|insert|update|delete)[^;]+ to (?:anon|authenticated)/i);

  // Migration 0017 adds a guarded path; it does not rewrite or weaken v1's
  // caller-declared-prospective rejection and unconditional public block.
  assert.match(migration, /Forecast Engine v1 cannot accept caller-declared prospective evidence/);
  assert.match(migration, /Forecast Engine v1 has no public promotion path/);
});

test('execution challenges are preregistered, independently signed, and immutable', () => {
  for (const table of [
    'forecast_executor_keys', 'prospective_scorecard_plans',
    'forecast_execution_challenges', 'forecast_execution_receipts',
    'prospective_prediction_outputs'
  ]) {
    assert.match(executionMigration, new RegExp(`create table public\\.${table}`));
    assert.match(executionMigration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(executionMigration, /origin_end >= origin_start \+ interval '105 days'/);
  assert.match(executionMigration, /origin_schedule timestamptz\[\] not null/);
  assert.match(executionMigration, /cardinality\(origin_schedule\) between 6 and 18/);
  assert.match(executionMigration, /interval '22 days'/);
  assert.match(executionMigration, /interval '24 hours'/);
  assert.match(executionMigration, /unique \(scorecard_plan_id, origin_slot_index\)/);
  assert.match(executionMigration, /selected_origin_slot_index integer/);
  assert.match(
    executionMigration,
    /prior\.origin_slot_index = selected_origin_slot_index/
  );
  assert.match(executionMigration, /challenge_count <> cardinality\(plan\.origin_schedule\)/);
  assert.match(executionMigration, /origin_start <= database_created_at/);
  assert.match(executionMigration, /nonce bytea not null check \(octet_length\(nonce\) = 32\)/);
  assert.match(executionMigration, /expires_at = issued_at \+ interval '5 minutes'/);
  assert.match(executionMigration, /forecast_run\.status <> 'running'/);
  assert.match(executionMigration, /still-running output-free forecast build/);
  assert.match(executionMigration, /hmac\(/);
  assert.match(executionMigration, /hmac_executor_principal_v1/);
  assert.match(executionMigration, /artifact_execution_verified boolean not null default false/);
  assert.match(executionMigration, /check \(not artifact_execution_verified\)/);
  assert.match(executionMigration, /Service role must not read independent executor HMAC keys/);
  assert.match(executionMigration, /database_issued_at := clock_timestamp\(\)/);
  assert.match(executionMigration, /database_received_at := clock_timestamp\(\)/);
});

test('challenged output hash covers exact series, costs, baselines, and is order-independent', () => {
  assert.match(executionMigration, /canonical_prospective_cost_quote_hash/);
  assert.match(executionMigration, /canonical_prospective_candidate_output_hash/);
  assert.match(executionMigration, /canonical_stored_prospective_cost_quote_hash/);
  assert.match(executionMigration, /canonical_stored_prospective_output_hash/);
  assert.match(executionMigration, /cannot be reconstructed exactly from immutable stored predictions, costs, and outputs/);
  assert.match(executionMigration, /trim_scale\(prediction\.q50\)/);
  assert.match(executionMigration, /YYYY-MM-DD"T"HH24:MI:SS\.US"Z"/);
  assert.match(executionMigration, /order by series\.identity_hash, snapshot\.id/);
  assert.match(executionMigration, /marketSeriesIdentityHash/);
  assert.match(executionMigration, /costQuoteHash/);
  assert.match(executionMigration, /\(item->'baselinePrices'\) - array\[/);
  assert.doesNotMatch(executionMigration, /or item->'baselinePrices' - array\[/);
  for (const baseline of [
    'no_change', 'damped_momentum', 'market_index',
    'lifecycle_cohort', 'structural_convergence'
  ]) assert.match(executionMigration, new RegExp(`\\b${baseline}\\b`));
  assert.match(executionMigration, /forecast_dataset_hash = canonical_output_hash/);
  assert.match(executionMigration, /Execution challenge is absent, expired, or already consumed/);
  assert.match(executionMigration, /Execution input changed after challenge issuance/);
  assert.match(executionMigration, /new\.origin := challenge\.issued_at/);
  assert.match(executionMigration, /new\.matures_at := challenge\.issued_at/);
  assert.match(executionMigration, /Challenged cost evidence was stale or unauthorized at the database-issued origin/);
  assert.match(executionMigration, /quote_source\.current_terms_review_id <> quote_terms\.id/);
});

test('challenged output rejects lossy decimals and missing mandatory shadow reasons', () => {
  for (const [field, precision] of [
    ['q10', '16,4'], ['q25', '16,4'], ['q50', '16,4'],
    ['q75', '16,4'], ['q90', '16,4'], ['probabilityUp', '7,6'],
    ['confidence', '7,4']
  ]) {
    assert.match(
      executionMigration,
      new RegExp(`\\(item->>'${field}'\\)::numeric\\s*<>\\s*`
        + `\\(item->>'${field}'\\)::numeric\\(${precision}\\)`)
    );
  }
  assert.match(
    executionMigration,
    /trim\(both '"' from value::text\)::numeric\s*<>\s*trim\(both '"' from value::text\)::numeric\(16,4\)/
  );
  for (const [field, precision] of [
    ['probabilityNetPositive', '7,6'], ['structuralLowerPrice', '16,4']
  ]) {
    assert.match(
      executionMigration,
      new RegExp(`\\(item->>'${field}'\\)::numeric\\s*<>\\s*`
        + `\\(item->>'${field}'\\)::numeric\\(${precision}\\)`)
    );
  }
  const compactExecutionMigration = executionMigration.replace(/\s+/g, ' ');
  for (const [field, precision] of [
    ['offerPrice', '16,4'], ['taxRate', '9,8'], ['buyShipping', '16,4'],
    ['sellFeeRate', '9,8'], ['sellFeeFixed', '16,4'], ['sellShipping', '16,4'],
    ['liquidityHaircutRate', '9,8']
  ]) {
    assert.ok(
      compactExecutionMigration.includes(
        `item->'costQuote'->>'${field}' !~ '^[0-9]+(?:[.][0-9]+)?$'`
      ),
      `${field} must reject NaN, infinity, exponents, and signed values before casting`
    );
    assert.match(
      executionMigration,
      new RegExp(`\\(item->'costQuote'->>'${field}'\\)::numeric\\s*<>\\s*`
        + `\\(item->'costQuote'->>'${field}'\\)::numeric\\(${precision}\\)`)
    );
  }
  assert.match(
    executionMigration,
    /not \(\s*item->'reasonCodes' \?& array\[\s*'operator_model_review_required',\s*'private_prospective_shadow',\s*'public_forecast_disabled'\s*\]\s*\)/
  );
});

test('challenged runs cannot gain predictions outside the signed receipt transaction', () => {
  assert.match(
    executionMigration,
    /create or replace function public\.guard_challenged_forecast_prediction_insert\(\)/
  );
  assert.match(executionMigration, /card_forecast_predictions_000_guard_challenged_run/);
  assert.match(
    executionMigration,
    /Challenged forecast run accepts predictions only inside its signed receipt transaction/
  );
  assert.match(
    executionMigration,
    /Challenged forecast run gained an unsigned prediction before finalization/
  );
});

test('complete cost rows cannot exploit SQL CHECK unknown semantics', () => {
  assert.match(executionMigration, /prospective_complete_cost_fields_present_check/);
  for (const field of [
    'offer_price', 'tax_rate', 'buy_shipping', 'sell_fee_rate',
    'sell_fee_fixed', 'sell_shipping', 'quote_evidence_hash'
  ]) assert.match(executionMigration, new RegExp(`${field} is not null`));
  assert.match(executionMigration, /nullif\(btrim\(external_quote_id\), ''\) is not null/);
  assert.match(executionMigration, /liquidity_haircut_rate is not null/);
  assert.match(executionMigration, /liquidity_evidence_hash is not null/);
});

test('prospective scorecard scope, membership, metrics, and recommendation are DB-derived', () => {
  const scorecardFunction = executionMigration.match(
    /create or replace function public\.create_prospective_model_scorecard\([\s\S]+?\n\$\$;/
  )?.[0];
  assert.ok(scorecardFunction, 'prospective scorecard derivation function is absent');
  assert.match(executionMigration, /create or replace function public\.create_prospective_model_scorecard/);
  assert.match(executionMigration, /Prospective scorecard accepts only its preregistered plan and evaluation-run identifiers/);
  assert.match(executionMigration, /every preregistered challenge to have one valid receipt/i);
  assert.match(executionMigration, /missing prediction, output, cost state, or evaluation/);
  assert.match(executionMigration, /evaluation run contains rows outside the preregistered scorecard plan/);
  assert.match(executionMigration, /evaluationMembershipHash/);
  assert.match(executionMigration, /originClusteredBaselineLiftLower95/);
  assert.match(executionMigration, /generate_series/);
  for (const metric of [
    'maeLogReturn', 'medianAbsolutePercentageError', 'symmetricMape',
    'directionAccuracy', 'brierScore', 'probabilityCalibrationError',
    'pinballLoss', 'interval80Coverage', 'baselineResults',
    'afterCostProbability', 'selectedPockets'
  ]) assert.match(executionMigration, new RegExp(`'${metric}'`));
  assert.match(executionMigration, /recommendation := case/);
  assert.match(executionMigration, /Atomic prospective scorecard membership is incomplete/);
  assert.match(executionMigration, /Prospective membership must be database-derived atomically/);
  assert.match(executionMigration, /name <> 'no_change'/);
  assert.match(executionMigration, /challenger_baseline_lift_below_threshold/);
  assert.match(executionMigration, /0\.000000000001/);
  const planLock = scorecardFunction.indexOf('select * into plan');
  const evaluationRunLock = scorecardFunction.indexOf('select * into evaluation_run');
  const evaluationRead = scorecardFunction.indexOf('join public.forecast_evaluations evaluation');
  assert.ok(planLock >= 0 && planLock < evaluationRunLock);
  assert.ok(evaluationRunLock < evaluationRead);
  assert.match(
    scorecardFunction.slice(evaluationRunLock, evaluationRead),
    /for update/
  );
});

test('0018 revokes unattested writes and preserves the unconditional public block', () => {
  assert.match(
    executionMigration,
    /revoke execute on function public\.record_prospective_forecast_run\(jsonb,jsonb\)[\s\S]+from public, anon, authenticated, service_role/
  );
  assert.match(
    executionMigration,
    /grant execute on function public\.record_challenged_prospective_forecast_run\(jsonb,jsonb\)[\s\S]+to service_role/
  );
  assert.match(executionMigration, /Service role must not directly declare prospective scorecards/);
  assert.match(executionMigration, /Forecast Engine v1 unconditional public-promotion block must remain intact/);
  assert.match(executionMigration, /must leave public_price_intelligence disabled/);
  assert.match(executionMigration, /must not install a public forecast publisher/);
  assert.doesNotMatch(executionMigration, /create or replace function public\.publish_forecast_intelligence/);
  assert.doesNotMatch(executionMigration, /update\s+public\.product_feature_flags/i);
});
