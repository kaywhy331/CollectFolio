\set ON_ERROR_STOP on

begin;

do $$
declare
  source_id constant uuid := '00000000-0000-0000-0000-000000000101';
  terms_id constant uuid := '00000000-0000-0000-0000-000000000102';
  set_id constant uuid := '00000000-0000-0000-0000-000000000103';
  card_id constant uuid := '00000000-0000-0000-0000-000000000104';
  variant_id constant uuid := '00000000-0000-0000-0000-000000000105';
  mapping_id constant uuid := '00000000-0000-0000-0000-000000000106';
  series_id constant uuid := '00000000-0000-0000-0000-000000000107';
  ingestion_id constant uuid := '00000000-0000-0000-0000-000000000108';
  observation_id constant uuid := '00000000-0000-0000-0000-000000000109';
  model_id constant uuid := '00000000-0000-0000-0000-000000000110';
  executor_id constant uuid := '00000000-0000-0000-0000-000000000111';
  trend_run_id constant uuid := '00000000-0000-0000-0000-000000000112';
  now_at timestamptz := clock_timestamp();
  feature_cutoff timestamptz := clock_timestamp() - interval '30 minutes';
  policy jsonb;
  identity_hash text;
begin
  policy := jsonb_build_object(
    'version', 'runtime-pilot-v1',
    'cohortKey', 'pokemon-en-raw-nm',
    'game', 'pokemon',
    'sourceId', source_id,
    'currency', 'USD',
    'language', 'en',
    'conditionClass', 'raw',
    'marketCondition', 'near-mint',
    'priceSemantics', 'market',
    'finishes', jsonb_build_array('normal'),
    'minimumEvidenceQuality', 0.55,
    'purpose', 'forecast_validation',
    'maximumFeatureAgeHours', 24,
    'maximumQuoteAgeHours', 24
  );

  insert into public.data_sources (
    id, code, name, source_type, terms_url, active, created_at, updated_at
  ) values (
    source_id, 'runtime-source', 'Runtime Source', 'marketplace_api',
    'https://example.invalid/terms', true,
    now_at - interval '2 days', now_at - interval '2 days'
  );
  insert into public.source_terms_reviews (
    id, source_id, terms_version, terms_url, decision,
    commercial_use_allowed, catalog_metadata_allowed, image_display_allowed,
    public_raw_display_allowed, public_derived_display_allowed,
    attribution_required, attribution_text, reviewed_at, expires_at,
    review_notes, document_hash, created_at,
    private_forecast_modeling_allowed, prospective_capture_allowed,
    exact_condition_labels_allowed, retention_through_maturity_allowed,
    liquidity_derivation_allowed, predictive_derivatives_allowed
  ) values (
    terms_id, source_id, 'runtime-v1', 'https://example.invalid/terms',
    'approved', true, true, false, false, false, false, null,
    now_at - interval '2 days', now_at + interval '400 days',
    'Local runtime fixture only', repeat('1', 64), now_at - interval '2 days',
    true, true, true, true, true, true
  );
  update public.data_sources
  set current_terms_review_id = terms_id
  where id = source_id;

  insert into public.catalog_sets (
    id, canonical_key, game, name, language, active, created_at, updated_at
  ) values (
    set_id, 'runtime:set', 'pokemon', 'Runtime Set', 'en', true,
    now_at - interval '2 days', now_at - interval '2 days'
  );
  insert into public.catalog_cards (
    id, set_id, canonical_key, name, number, active, created_at, updated_at
  ) values (
    card_id, set_id, 'runtime:card', 'Runtime Card', '1', true,
    now_at - interval '2 days', now_at - interval '2 days'
  );
  insert into public.catalog_variants (
    id, card_id, canonical_key, language, edition, finish, variant_name,
    raw_condition_class, active, created_at, updated_at
  ) values (
    variant_id, card_id, 'runtime:variant', 'en', 'unlimited', 'normal', '',
    'raw', true, now_at - interval '2 days', now_at - interval '2 days'
  );
  insert into public.external_card_mappings (
    id, source_id, external_product_id, external_variant_key, variant_id,
    mapping_confidence, mapping_method, mapping_version, review_status,
    reviewed_at, notes, created_at, updated_at
  ) values (
    mapping_id, source_id, 'runtime-card-1', 'normal-near-mint', variant_id,
    1, 'manual_review', 'runtime-map-v1', 'approved',
    now_at - interval '1 day', 'Local runtime fixture',
    now_at - interval '1 day', now_at - interval '1 day'
  );
  identity_hash := encode(digest(concat_ws('|',
    variant_id::text, source_id::text, mapping_id::text,
    'runtime-card-1', 'normal-near-mint', 'runtime-map-v1',
    'USD', 'en', 'normal', 'raw', 'near-mint', 'market'
  ), 'sha256'), 'hex');
  insert into public.market_series (
    id, catalog_variant_id, source_id, mapping_id, provider_product_id,
    provider_variant_key, mapping_version, currency, language, finish,
    condition_class, market_condition, price_semantics, identity_hash,
    created_at
  ) values (
    series_id, variant_id, source_id, mapping_id, 'runtime-card-1',
    'normal-near-mint', 'runtime-map-v1', 'USD', 'en', 'normal',
    'raw', 'near-mint', 'market', identity_hash, now_at - interval '1 day'
  );

  insert into public.source_ingestion_runs (
    id, source_id, terms_review_id, started_at, completed_at, status,
    records_read, records_written, raw_payload_hash, parser_version,
    code_commit, metadata
  ) values (
    ingestion_id, source_id, terms_id, now_at - interval '2 hours',
    now_at - interval '1 hour', 'succeeded', 1, 1, repeat('2', 64),
    'runtime-parser-v1', 'runtime-code-v1', '{}'::jsonb
  );
  insert into public.price_observations (
    id, ingestion_run_id, source_id, terms_review_id, mapping_id, variant_id,
    external_record_id, price_semantics, currency, market_price,
    observed_at, available_at, ingested_at, quality_score,
    observation_status, reason_codes, source_record_hash, metadata,
    created_at, market_series_id
  ) values (
    observation_id, ingestion_id, source_id, terms_id, mapping_id, variant_id,
    'runtime-observation-1', 'market', 'USD', 100,
    now_at - interval '90 minutes', now_at - interval '80 minutes',
    now_at - interval '70 minutes', 1, 'accepted', array[]::text[],
    repeat('3', 64), '{}'::jsonb, now_at - interval '70 minutes', series_id
  );

  insert into public.model_versions (
    id, model_key, version, model_family, research_only, allowed_horizons,
    training_dataset_hash, feature_version, mapping_version, code_version,
    model_artifact_hash, trained_through, config, config_hash, created_at,
    training_mode, model_definition_hash
  ) values (
    model_id, 'runtime-quantile', '1', 'quantile_return_forecast', true,
    array[30,90], repeat('4', 64), 'runtime-feature-v1', 'runtime-map-v1',
    'runtime-code-v1', repeat('5', 64), now_at - interval '1 day',
    jsonb_build_object('trainingMode', 'trained'), repeat('6', 64),
    now_at - interval '1 day', 'trained', repeat('7', 64)
  );
  insert into public.forecast_executor_keys (
    id, executor_label, model_artifact_hash, executor_build_hash,
    runtime_hash, hmac_secret, valid_from, valid_until, created_at
  ) values (
    executor_id, 'runtime-executor', repeat('5', 64), repeat('8', 64),
    repeat('9', 64), decode(repeat('ab', 32), 'hex'),
    now_at - interval '1 day', now_at + interval '200 days',
    now_at - interval '1 day'
  );

  insert into public.analytics_runs (
    id, run_kind, status, feature_cutoff, started_at, source_policy_hash,
    mapping_version, feature_version, code_version, config_hash, config,
    created_at
  ) values (
    trend_run_id, 'trend_build', 'running', feature_cutoff,
    now_at - interval '10 minutes', repeat('a', 64), 'runtime-map-v1',
    'runtime-feature-v1', 'runtime-code-v1', repeat('b', 64),
    jsonb_build_object('candidateUniversePolicy', policy),
    now_at - interval '10 minutes'
  );
  insert into public.analytics_run_sources (
    analytics_run_id, source_id, terms_review_id, usage_kind, created_at
  ) values (
    trend_run_id, source_id, terms_id, 'derived_feature',
    now_at - interval '10 minutes'
  );
end;
$$;

set role service_role;
select public.seal_trend_expected_input_manifest(
  '00000000-0000-0000-0000-000000000112'::uuid
);
reset role;

insert into public.trend_feature_snapshots (
  id, analytics_run_id, variant_id, source_id, terms_review_id,
  feature_cutoff, price_current, history_density_90d, staleness_hours,
  source_quality_90d, evidence_quality, trend_state,
  observation_count_90d, reason_codes, snapshot_hash, created_at,
  market_series_id
)
select
  '00000000-0000-0000-0000-000000000114'::uuid,
  run.id,
  '00000000-0000-0000-0000-000000000105'::uuid,
  '00000000-0000-0000-0000-000000000101'::uuid,
  '00000000-0000-0000-0000-000000000102'::uuid,
  run.feature_cutoff, 100, 1, 0.5, 1, 1, 'stable', 1,
  array[]::text[], repeat('c', 64), clock_timestamp(),
  '00000000-0000-0000-0000-000000000107'::uuid
from public.analytics_runs run
where run.id = '00000000-0000-0000-0000-000000000112'::uuid;

update public.analytics_runs
set status = 'succeeded', completed_at = clock_timestamp(),
    dataset_hash = repeat('d', 64), records_read = 1, records_written = 1
where id = '00000000-0000-0000-0000-000000000112'::uuid;

do $$
declare
  policy jsonb;
  now_at timestamptz := clock_timestamp();
begin
  select config->'candidateUniversePolicy' into policy
  from public.analytics_runs
  where id = '00000000-0000-0000-0000-000000000112'::uuid;
  insert into public.analytics_runs (
    id, run_kind, status, feature_cutoff, started_at, source_policy_hash,
    mapping_version, feature_version, code_version, config_hash, config,
    created_at
  )
  select
    '00000000-0000-0000-0000-000000000113'::uuid,
    'forecast_build', 'running', feature_cutoff, now_at,
    source_policy_hash, mapping_version, feature_version, code_version,
    repeat('e', 64), jsonb_build_object('candidateUniversePolicy', policy),
    now_at
  from public.analytics_runs
  where id = '00000000-0000-0000-0000-000000000112'::uuid;
  insert into public.analytics_run_sources (
    analytics_run_id, source_id, terms_review_id, usage_kind, created_at
  ) values (
    '00000000-0000-0000-0000-000000000113'::uuid,
    '00000000-0000-0000-0000-000000000101'::uuid,
    '00000000-0000-0000-0000-000000000102'::uuid,
    'derived_feature', now_at
  );
end;
$$;

set role service_role;
with scope as (
  select clock_timestamp() + interval '2 seconds' as origin_start
), schedule as (
  select origin_start, array[
    origin_start,
    origin_start + interval '22 days',
    origin_start + interval '44 days',
    origin_start + interval '66 days',
    origin_start + interval '88 days',
    origin_start + interval '110 days'
  ] as origins
  from scope
)
select public.create_prospective_scorecard_plan(jsonb_build_object(
  'modelVersionId', '00000000-0000-0000-0000-000000000110',
  'executorKeyId', '00000000-0000-0000-0000-000000000111',
  'horizonDays', 30,
  'cohortKey', 'pokemon-en-raw-nm',
  'sourceId', '00000000-0000-0000-0000-000000000101',
  'universePurpose', 'forecast_validation',
  'originStart', origin_start,
  'originEnd', origins[6] + interval '24 hours',
  'originSchedule', to_jsonb(origins),
  'selectionPolicy', (
    select config->'candidateUniversePolicy'
    from public.analytics_runs
    where id = '00000000-0000-0000-0000-000000000112'::uuid
  ),
  'promotionPolicy', jsonb_build_object(
    'version', 'forecast-ensemble-promotion-v1',
    'minimumCases', 200,
    'minimumBaselineLift', 0.02,
    'interval80CoverageMin', 0.72,
    'interval80CoverageMax', 0.88,
    'maximumBrierScore', 0.25,
    'requiredBaselines', jsonb_build_array(
      'no_change','damped_momentum','market_index','lifecycle_cohort',
      'structural_convergence'
    )
  )
))
from schedule;
reset role;

commit;
