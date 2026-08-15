\set ON_ERROR_STOP on

-- This fixture deliberately manufactures historical database rows so the full
-- six-origin scorecard SQL can be exercised in a disposable local database.
-- It is not evidence that the origins happened prospectively, that an external
-- executor ran the artifact, or that the model has predictive skill.

begin;

-- Prediction insert triggers correctly enforce production-time authorship and
-- cannot accept deliberately backdated origins. Disable only user triggers for
-- the direct historical seed, then restore them before any evaluation RPC runs.
alter table public.card_forecast_predictions disable trigger user;

do $$
declare
  fixture_source_id constant uuid := '00000000-0000-0000-0000-000000000101';
  base_terms_id constant uuid := '00000000-0000-0000-0000-000000000102';
  variant_id constant uuid := '00000000-0000-0000-0000-000000000105';
  mapping_id constant uuid := '00000000-0000-0000-0000-000000000106';
  series_id constant uuid := '00000000-0000-0000-0000-000000000107';
  base_model_id constant uuid := '00000000-0000-0000-0000-000000000110';
  historical_terms_id constant uuid := md5('collectfolio-scorecard-terms')::uuid;
  model_id constant uuid := md5('collectfolio-scorecard-model')::uuid;
  executor_id constant uuid := md5('collectfolio-scorecard-executor')::uuid;
  plan_id constant uuid := md5('collectfolio-scorecard-plan')::uuid;
  evaluation_run_id constant uuid := md5('collectfolio-scorecard-evaluation-run')::uuid;
  history_start timestamptz := clock_timestamp() - interval '171 days';
  history_end timestamptz;
  plan_created_at timestamptz;
  evaluation_at timestamptz;
  origin_schedule timestamptz[];
  selection_policy jsonb;
  promotion_policy jsonb;
  gate_policy jsonb;
  output_policy jsonb;
  selection_policy_hash text;
  promotion_policy_hash text;
  gate_policy_hash text;
  plan_hash text;
  source_policy_hash text := encode(digest(
    'collectfolio-synthetic-scorecard-source-policy', 'sha256'
  ), 'hex');
  model public.model_versions%rowtype;
  executor public.forecast_executor_keys%rowtype;
  series_identity_hash text;
  slot integer;
  origin_at timestamptz;
  feature_cutoff timestamptz;
  manifest_sealed_at timestamptz;
  trend_completed_at timestamptz;
  execution_started_at timestamptz;
  execution_completed_at timestamptz;
  received_at timestamptz;
  maturity_at timestamptz;
  trend_run_id uuid;
  forecast_run_id uuid;
  manifest_id uuid;
  snapshot_id uuid;
  challenge_id uuid;
  prospective_run_id uuid;
  universe_id uuid;
  member_id uuid;
  quote_id uuid;
  prediction_id uuid;
  receipt_id uuid;
  ingestion_id uuid;
  observation_id uuid;
  trend_dataset_hash text;
  expected_series_hash text;
  manifest_hash text;
  snapshot_hash text;
  expected_input_hash text;
  challenge_nonce bytea;
  challenge_hash text;
  quote_payload jsonb;
  cost_quote_commitment text;
  candidate_payload jsonb;
  core_candidate_payload jsonb;
  canonical_output_hash text;
  submission_hash text;
  universe_hash text;
  run_hash text;
  base_quote_hash text;
  quote_hash text;
  prediction_hash text;
  baseline_prices jsonb;
  signature_message text;
  executor_signature text;
  receipt_hash text;
  prediction_output_hash text;
begin
  select * into model from public.model_versions where id = base_model_id;
  if model.id is null then
    raise exception 'Synthetic scorecard fixture requires the base runtime model';
  end if;
  select identity_hash into series_identity_hash
  from public.market_series where id = series_id;

  select plan.selection_policy, plan.promotion_policy, plan.gate_policy,
         plan.output_policy
    into selection_policy, promotion_policy, gate_policy, output_policy
  from public.prospective_scorecard_plans plan
  where plan.model_version_id = base_model_id
    and plan.source_id = fixture_source_id
    and plan.universe_purpose = 'forecast_validation';
  if selection_policy is null then
    raise exception 'Synthetic scorecard fixture requires the genuine runtime plan';
  end if;

  origin_schedule := array[
    history_start,
    history_start + interval '22 days',
    history_start + interval '44 days',
    history_start + interval '66 days',
    history_start + interval '88 days',
    history_start + interval '110 days'
  ];
  history_end := origin_schedule[6] + interval '24 hours';
  plan_created_at := history_start - interval '2 days';
  selection_policy_hash := encode(digest(selection_policy::text, 'sha256'), 'hex');
  promotion_policy_hash := encode(digest(promotion_policy::text, 'sha256'), 'hex');
  gate_policy_hash := encode(digest(gate_policy::text, 'sha256'), 'hex');

  insert into public.source_terms_reviews (
    id, source_id, terms_version, terms_url, decision,
    commercial_use_allowed, catalog_metadata_allowed, image_display_allowed,
    public_raw_display_allowed, public_derived_display_allowed,
    attribution_required, attribution_text, reviewed_at, expires_at,
    review_notes, document_hash, created_at,
    private_forecast_modeling_allowed, prospective_capture_allowed,
    exact_condition_labels_allowed, retention_through_maturity_allowed,
    liquidity_derivation_allowed, predictive_derivatives_allowed
  )
  select
    historical_terms_id, fixture_source_id, 'runtime-history-v1', terms_url, decision,
    commercial_use_allowed, catalog_metadata_allowed, image_display_allowed,
    public_raw_display_allowed, public_derived_display_allowed,
    attribution_required, attribution_text, history_start - interval '3 days',
    clock_timestamp() + interval '400 days',
    'Synthetic historical scorecard runtime fixture only',
    encode(digest('collectfolio-scorecard-terms-document', 'sha256'), 'hex'),
    history_start - interval '3 days', private_forecast_modeling_allowed,
    prospective_capture_allowed, exact_condition_labels_allowed,
    retention_through_maturity_allowed, liquidity_derivation_allowed,
    predictive_derivatives_allowed
  from public.source_terms_reviews where id = base_terms_id;
  update public.data_sources
  set current_terms_review_id = historical_terms_id,
      updated_at = clock_timestamp()
  where id = fixture_source_id;

  insert into public.model_versions (
    id, model_key, version, model_family, research_only, allowed_horizons,
    training_dataset_hash, feature_version, mapping_version, code_version,
    model_artifact_hash, trained_through, config, config_hash, created_at,
    training_mode, model_definition_hash
  )
  select
    model_id, 'runtime-quantile-scorecard', '1', model_family, research_only,
    allowed_horizons, training_dataset_hash, feature_version, mapping_version,
    code_version, model_artifact_hash, history_start - interval '3 days',
    config, config_hash, history_start - interval '2 days', training_mode,
    model_definition_hash
  from public.model_versions where id = base_model_id;

  insert into public.forecast_executor_keys (
    id, executor_label, model_artifact_hash, executor_build_hash,
    runtime_hash, hmac_secret, valid_from, valid_until, created_at
  )
  select
    executor_id, 'runtime-scorecard-synthetic-executor', model_artifact_hash,
    executor_build_hash, runtime_hash, decode(repeat('cd', 32), 'hex'),
    history_start - interval '3 days', history_end + interval '1 day',
    history_start - interval '3 days'
  from public.forecast_executor_keys
  where id = '00000000-0000-0000-0000-000000000111'::uuid;
  select * into executor from public.forecast_executor_keys where id = executor_id;

  plan_hash := encode(digest(concat_ws('|',
    plan_id::text, model_id::text, executor_id::text, '30',
    'pokemon-en-raw-nm', fixture_source_id::text, 'forecast_validation',
    history_start::text, history_end::text, array_to_string(origin_schedule, ','),
    selection_policy_hash, promotion_policy_hash, gate_policy_hash,
    encode(digest(output_policy::text, 'sha256'), 'hex'), plan_created_at::text
  ), 'sha256'), 'hex');
  insert into public.prospective_scorecard_plans (
    id, model_version_id, executor_key_id, horizon_days, cohort_key, source_id,
    universe_purpose, origin_start, origin_end, origin_schedule, selection_policy,
    selection_policy_hash, promotion_policy, promotion_policy_hash,
    gate_policy, gate_policy_hash, output_policy, created_at, plan_hash
  ) values (
    plan_id, model_id, executor_id, 30, 'pokemon-en-raw-nm', fixture_source_id,
    'forecast_validation', history_start, history_end, origin_schedule,
    selection_policy, selection_policy_hash, promotion_policy,
    promotion_policy_hash, gate_policy, gate_policy_hash, output_policy,
    plan_created_at, plan_hash
  );

  for slot in 1..6 loop
    origin_at := origin_schedule[slot];
    feature_cutoff := origin_at - interval '2 hours';
    manifest_sealed_at := origin_at - interval '90 minutes';
    trend_completed_at := origin_at - interval '45 minutes';
    execution_started_at := origin_at + interval '10 seconds';
    execution_completed_at := origin_at + interval '20 seconds';
    received_at := origin_at + interval '30 seconds';
    maturity_at := origin_at + interval '30 days';
    trend_run_id := md5('collectfolio-scorecard-trend-run-' || slot)::uuid;
    forecast_run_id := md5('collectfolio-scorecard-forecast-run-' || slot)::uuid;
    manifest_id := md5('collectfolio-scorecard-manifest-' || slot)::uuid;
    snapshot_id := md5('collectfolio-scorecard-snapshot-' || slot)::uuid;
    challenge_id := md5('collectfolio-scorecard-challenge-' || slot)::uuid;
    prospective_run_id := md5('collectfolio-scorecard-prospective-run-' || slot)::uuid;
    universe_id := md5('collectfolio-scorecard-universe-' || slot)::uuid;
    member_id := md5('collectfolio-scorecard-member-' || slot)::uuid;
    quote_id := md5('collectfolio-scorecard-quote-' || slot)::uuid;
    prediction_id := md5('collectfolio-scorecard-prediction-' || slot)::uuid;
    receipt_id := md5('collectfolio-scorecard-receipt-' || slot)::uuid;
    ingestion_id := md5('collectfolio-scorecard-ingestion-' || slot)::uuid;
    observation_id := md5('collectfolio-scorecard-observation-' || slot)::uuid;
    trend_dataset_hash := encode(digest(
      'collectfolio-scorecard-trend-dataset-' || slot, 'sha256'
    ), 'hex');
    snapshot_hash := encode(digest(concat_ws('|',
      snapshot_id::text, trend_run_id::text, series_id::text,
      feature_cutoff::text, '100.0000'
    ), 'sha256'), 'hex');

    insert into public.analytics_runs (
      id, run_kind, status, feature_cutoff, started_at, completed_at,
      dataset_hash, source_policy_hash, mapping_version, feature_version,
      code_version, config_hash, config, records_read, records_written,
      records_quarantined, error_summary, created_at
    ) values (
      trend_run_id, 'trend_build', 'running', feature_cutoff,
      feature_cutoff - interval '10 minutes', null,
      null, source_policy_hash, model.mapping_version,
      model.feature_version, model.code_version,
      encode(digest(('trend-' || slot)::text, 'sha256'), 'hex'),
      jsonb_build_object('candidateUniversePolicy', selection_policy),
      0, 0, 0, null, feature_cutoff - interval '10 minutes'
    );
    insert into public.analytics_run_sources (
      analytics_run_id, source_id, terms_review_id, usage_kind, created_at
    ) values (
      trend_run_id, fixture_source_id, historical_terms_id, 'derived_feature',
      feature_cutoff - interval '10 minutes'
    );

    expected_series_hash := encode(digest(concat_ws(':',
      series_id::text, series_identity_hash
    ), 'sha256'), 'hex');
    manifest_hash := encode(digest(concat_ws('|',
      manifest_id::text, trend_run_id::text, feature_cutoff::text,
      model.mapping_version, selection_policy_hash, '1',
      expected_series_hash, manifest_sealed_at::text
    ), 'sha256'), 'hex');
    insert into public.trend_expected_input_manifests (
      id, trend_analytics_run_id, feature_cutoff, selection_policy,
      selection_policy_hash, expected_series_count, expected_series_hash,
      sealed_at, manifest_hash, created_at
    ) values (
      manifest_id, trend_run_id, feature_cutoff, selection_policy,
      selection_policy_hash, 1, expected_series_hash, manifest_sealed_at,
      manifest_hash, manifest_sealed_at
    );
    insert into public.trend_feature_snapshots (
      id, analytics_run_id, variant_id, source_id, terms_review_id,
      feature_cutoff, price_current, history_density_90d, staleness_hours,
      source_quality_90d, evidence_quality, trend_state,
      observation_count_90d, reason_codes, snapshot_hash, created_at,
      market_series_id
    ) values (
      snapshot_id, trend_run_id, variant_id, fixture_source_id, historical_terms_id,
      feature_cutoff, 100, 1, 0.5, 1, 1, 'stable', 1,
      array['synthetic_historical_scorecard_fixture']::text[], snapshot_hash,
      origin_at - interval '60 minutes', series_id
    );
    update public.analytics_runs
    set status = 'succeeded', completed_at = trend_completed_at,
        dataset_hash = trend_dataset_hash, records_read = 1,
        records_written = 1
    where id = trend_run_id;
    expected_input_hash := public.canonical_forecast_execution_input_hash(
      trend_run_id
    );

    quote_payload := jsonb_build_object(
      'status', 'complete',
      'semantics', 'provider_listing',
      'quoteMarketSeriesId', series_id,
      'termsReviewId', historical_terms_id,
      'externalQuoteId', 'runtime-scorecard-listing-' || slot,
      'observedAt', origin_at - interval '15 minutes',
      'evidenceHash', encode(digest('scorecard-quote-evidence-' || slot, 'sha256'), 'hex'),
      'offerPrice', '75',
      'taxRate', '0.08',
      'buyShipping', '0',
      'sellFeeRate', '0.13',
      'sellFeeFixed', '0',
      'sellShipping', '0',
      'liquidityStatus', 'source_backed',
      'liquidityHaircutRate', '0.1',
      'liquidityEvidenceHash', encode(digest(
        'scorecard-liquidity-evidence-' || slot, 'sha256'
      ), 'hex')
    );
    cost_quote_commitment := public.canonical_prospective_cost_quote_hash(
      quote_payload
    );
    candidate_payload := jsonb_build_object(
      'trendSnapshotId', snapshot_id,
      'marketSeriesIdentityHash', series_identity_hash,
      'q10', '80', 'q25', '90', 'q50', '110', 'q75', '125', 'q90', '140',
      'probabilityUp', '0.7', 'confidence', '61.5',
      'predictionStatus', 'research_only',
      'reasonCodes', jsonb_build_array(
        'operator_model_review_required', 'private_prospective_shadow',
        'public_forecast_disabled', 'runtime_fixture'
      ),
      'costQuote', quote_payload,
      'costQuoteHash', cost_quote_commitment,
      'baselinePrices', jsonb_build_object(
        'no_change', '100', 'damped_momentum', '105', 'market_index', '103',
        'lifecycle_cohort', '107', 'structural_convergence', '108'
      ),
      'probabilityNetPositive', '0.74',
      'structuralLowerPrice', '95'
    );
    canonical_output_hash := public.canonical_prospective_candidate_output_hash(
      jsonb_build_array(candidate_payload)
    );
    core_candidate_payload := candidate_payload - array[
      'marketSeriesIdentityHash', 'baselinePrices', 'costQuoteHash',
      'probabilityNetPositive', 'structuralLowerPrice'
    ];
    submission_hash := encode(digest(
      jsonb_build_array(core_candidate_payload)::text, 'sha256'
    ), 'hex');

    insert into public.analytics_runs (
      id, run_kind, status, feature_cutoff, started_at, completed_at,
      dataset_hash, source_policy_hash, mapping_version, feature_version,
      code_version, config_hash, config, records_read, records_written,
      records_quarantined, error_summary, created_at
    ) values (
      forecast_run_id, 'forecast_build', 'succeeded', feature_cutoff,
      origin_at - interval '5 minutes', received_at, canonical_output_hash,
      source_policy_hash, model.mapping_version, model.feature_version,
      model.code_version,
      encode(digest(('forecast-' || slot)::text, 'sha256'), 'hex'),
      jsonb_build_object('candidateUniversePolicy', selection_policy),
      1, 1, 0, null, origin_at - interval '5 minutes'
    );
    insert into public.analytics_run_sources (
      analytics_run_id, source_id, terms_review_id, usage_kind, created_at
    ) values (
      forecast_run_id, fixture_source_id, historical_terms_id, 'derived_feature',
      origin_at - interval '5 minutes'
    );

    challenge_nonce := digest('collectfolio-scorecard-nonce-' || slot, 'sha256');
    challenge_hash := encode(digest(concat_ws('|',
      challenge_id::text, plan_id::text, forecast_run_id::text,
      trend_run_id::text, manifest_id::text, manifest_hash, model_id::text,
      model.model_artifact_hash, executor_id::text, '30', slot::text,
      origin_schedule[slot]::text, '1', expected_input_hash,
      selection_policy_hash, source_policy_hash, model.feature_version,
      model.mapping_version, model.code_version, encode(challenge_nonce, 'hex'),
      origin_at::text, (origin_at + interval '5 minutes')::text
    ), 'sha256'), 'hex');
    insert into public.forecast_execution_challenges (
      id, scorecard_plan_id, forecast_analytics_run_id, trend_analytics_run_id,
      input_manifest_id, input_manifest_hash, model_version_id, executor_key_id,
      horizon_days, origin_slot_index, expected_input_count, expected_input_hash,
      selection_policy_hash, source_policy_hash, model_artifact_hash,
      feature_version, mapping_version, code_version, nonce, issued_at,
      expires_at, challenge_hash, created_at
    ) values (
      challenge_id, plan_id, forecast_run_id, trend_run_id, manifest_id,
      manifest_hash, model_id, executor_id, 30, slot, 1, expected_input_hash,
      selection_policy_hash, source_policy_hash, model.model_artifact_hash,
      model.feature_version, model.mapping_version, model.code_version,
      challenge_nonce, origin_at, origin_at + interval '5 minutes',
      challenge_hash, origin_at
    );

    select encode(digest(concat_ws('|',
      trend_run_id::text, trend_dataset_hash, selection_policy_hash,
      string_agg(concat_ws(':', series.identity_hash, snapshot.id::text,
        snapshot.snapshot_hash, snapshot.terms_review_id::text,
        snapshot.evidence_quality::text
      ), '||' order by series.identity_hash, snapshot.id)
    ), 'sha256'), 'hex') into universe_hash
    from public.trend_feature_snapshots snapshot
    join public.market_series series on series.id = snapshot.market_series_id
    where snapshot.analytics_run_id = trend_run_id;
    run_hash := encode(digest(concat_ws('|',
      prospective_run_id::text, forecast_run_id::text, trend_run_id::text,
      model_id::text, manifest_id::text, manifest_hash, challenge_id::text,
      challenge_hash, origin_at::text, '30', model.model_artifact_hash,
      trend_dataset_hash, canonical_output_hash, source_policy_hash,
      model.feature_version, model.mapping_version, model.code_version,
      submission_hash
    ), 'sha256'), 'hex');
    insert into public.prospective_forecast_runs (
      id, analytics_run_id, trend_analytics_run_id, input_manifest_id,
      input_manifest_hash, model_version_id, origin, horizon_days, matures_at,
      model_artifact_hash, feature_dataset_hash, forecast_dataset_hash,
      source_policy_hash, feature_version, mapping_version, code_version,
      submission_hash, run_hash, created_at, execution_challenge_id
    ) values (
      prospective_run_id, forecast_run_id, trend_run_id, manifest_id,
      manifest_hash, model_id, origin_at, 30, maturity_at,
      model.model_artifact_hash, trend_dataset_hash, canonical_output_hash,
      source_policy_hash, model.feature_version, model.mapping_version,
      model.code_version, submission_hash, run_hash, origin_at, challenge_id
    );
    insert into public.prospective_candidate_universes (
      id, prospective_run_id, purpose, selection_policy, selection_policy_hash,
      candidate_count, universe_snapshot_hash, sealed_at, created_at
    ) values (
      universe_id, prospective_run_id, 'forecast_validation', selection_policy,
      selection_policy_hash, 1, universe_hash, origin_at, origin_at
    );
    insert into public.prospective_candidate_universe_members (
      id, candidate_universe_id, prospective_run_id, market_series_id,
      trend_snapshot_id, source_id, terms_review_id, selection_ordinal,
      evidence_quality, trend_snapshot_hash, created_at
    ) values (
      member_id, universe_id, prospective_run_id, series_id, snapshot_id,
      fixture_source_id, historical_terms_id, 1, 1, snapshot_hash, origin_at
    );

    base_quote_hash := encode(digest(concat_ws('|',
      member_id::text, universe_id::text, prospective_run_id::text,
      'provider_listing', series_id::text, historical_terms_id::text,
      'runtime-scorecard-listing-' || slot,
      (origin_at - interval '15 minutes')::text, origin_at::text, 'USD',
      '75', '0.08', '0', '0.13', '0', '0', 'source_backed', '0.1',
      quote_payload->>'evidenceHash', quote_payload->>'liquidityEvidenceHash'
    ), 'sha256'), 'hex');
    quote_hash := encode(digest(concat_ws('|',
      base_quote_hash, challenge_hash, origin_at::text
    ), 'sha256'), 'hex');
    insert into public.prospective_acquisition_cost_quotes (
      id, candidate_member_id, candidate_universe_id, prospective_run_id,
      quote_status, quote_semantics, quote_market_series_id, quote_source_id,
      quote_terms_review_id, external_quote_id, quote_observed_at, captured_at,
      currency, offer_price, tax_rate, buy_shipping, sell_fee_rate,
      sell_fee_fixed, sell_shipping, liquidity_status, liquidity_haircut_rate,
      quote_evidence_hash, liquidity_evidence_hash, quote_hash, created_at
    ) values (
      quote_id, member_id, universe_id, prospective_run_id, 'complete',
      'provider_listing', series_id, fixture_source_id, historical_terms_id,
      'runtime-scorecard-listing-' || slot, origin_at - interval '15 minutes',
      origin_at, 'USD', 75, 0.08, 0, 0.13, 0, 0, 'source_backed', 0.1,
      quote_payload->>'evidenceHash', quote_payload->>'liquidityEvidenceHash',
      quote_hash, origin_at
    );

    prediction_hash := encode(digest(concat_ws('|',
      prediction_id::text, prospective_run_id::text, universe_id::text,
      member_id::text, model_id::text, snapshot_id::text, series_id::text,
      challenge_id::text, challenge_hash, origin_at::text, '30',
      (100::numeric(16,4))::text, (80::numeric(16,4))::text,
      (90::numeric(16,4))::text, (110::numeric(16,4))::text,
      (125::numeric(16,4))::text, (140::numeric(16,4))::text,
      (0.7::numeric(7,6))::text, (61.5::numeric(7,4))::text,
      'research_only',
      'operator_model_review_required,private_prospective_shadow,public_forecast_disabled,runtime_fixture',
      trend_dataset_hash, model.feature_version, model.mapping_version,
      model.code_version
    ), 'sha256'), 'hex');
    insert into public.card_forecast_predictions (
      id, analytics_run_id, model_version_id, trend_snapshot_id, variant_id,
      source_id, terms_review_id, origin, feature_cutoff, horizon_days,
      matures_at, currency, current_price, q10, q25, q50, q75, q90,
      probability_up, confidence, prediction_status, reason_codes, dataset_hash,
      feature_version, mapping_version, code_version, prediction_hash,
      created_at, market_series_id, evidence_mode, prospective_run_id,
      candidate_universe_id, prospective_candidate_member_id
    ) values (
      prediction_id, forecast_run_id, model_id, snapshot_id, variant_id,
      fixture_source_id, historical_terms_id, origin_at, feature_cutoff, 30,
      maturity_at, 'USD', 100, 80, 90, 110, 125, 140, 0.7, 61.5,
      'research_only', array[
        'operator_model_review_required', 'private_prospective_shadow',
        'public_forecast_disabled', 'runtime_fixture'
      ]::text[], trend_dataset_hash, model.feature_version,
      model.mapping_version, model.code_version, prediction_hash, origin_at,
      series_id, 'prospective', prospective_run_id, universe_id, member_id
    );

    signature_message := concat_ws('|',
      challenge_hash, encode(challenge_nonce, 'hex'), expected_input_hash,
      canonical_output_hash, '1', model.model_artifact_hash,
      executor.executor_build_hash, executor.runtime_hash,
      to_char(execution_started_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      to_char(execution_completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );
    executor_signature := encode(hmac(
      convert_to(signature_message, 'UTF8'), executor.hmac_secret, 'sha256'
    ), 'hex');
    receipt_hash := encode(digest(concat_ws('|',
      receipt_id::text, challenge_id::text, challenge_hash,
      prospective_run_id::text, run_hash, forecast_run_id::text,
      executor_id::text, expected_input_hash, '1', canonical_output_hash,
      submission_hash, executor.executor_build_hash, executor.runtime_hash,
      to_char(execution_started_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      to_char(execution_completed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      received_at::text, executor_signature,
      'hmac_executor_principal_v1', 'false'
    ), 'sha256'), 'hex');
    insert into public.forecast_execution_receipts (
      id, challenge_id, prospective_run_id, forecast_analytics_run_id,
      executor_key_id, challenge_hash, expected_input_hash, output_count,
      canonical_output_hash, forecast_dataset_hash, core_submission_hash,
      executor_build_hash, runtime_hash, execution_started_at,
      execution_completed_at, received_at, executor_signature,
      attestation_level, artifact_execution_verified, receipt_hash, created_at
    ) values (
      receipt_id, challenge_id, prospective_run_id, forecast_run_id,
      executor_id, challenge_hash, expected_input_hash, 1,
      canonical_output_hash, canonical_output_hash, submission_hash,
      executor.executor_build_hash, executor.runtime_hash,
      execution_started_at, execution_completed_at, received_at,
      executor_signature, 'hmac_executor_principal_v1', false,
      receipt_hash, received_at
    );

    baseline_prices := jsonb_build_object(
      'no_change', 100::numeric(16,4),
      'damped_momentum', 105::numeric(16,4),
      'market_index', 103::numeric(16,4),
      'lifecycle_cohort', 107::numeric(16,4),
      'structural_convergence', 108::numeric(16,4)
    );
    prediction_output_hash := encode(digest(concat_ws('|',
      prediction_id::text, receipt_id::text, prospective_run_id::text,
      baseline_prices::text, (0.74::numeric(7,6))::text,
      (95::numeric(16,4))::text, 'false',
      'not_after_cost_opportunity_scope', canonical_output_hash,
      receipt_hash, received_at::text
    ), 'sha256'), 'hex');
    insert into public.prospective_prediction_outputs (
      prediction_id, execution_receipt_id, prospective_run_id,
      baseline_prices, probability_net_positive, structural_lower_price,
      selected_for_pocket, selection_reason_codes, output_hash, created_at
    ) values (
      prediction_id, receipt_id, prospective_run_id, baseline_prices, 0.74, 95,
      false, array['not_after_cost_opportunity_scope']::text[],
      prediction_output_hash, received_at
    );
    if public.canonical_stored_prospective_output_hash(receipt_id)
         is distinct from canonical_output_hash then
      raise exception 'Synthetic receipt % cannot reconstruct its canonical output', slot;
    end if;

    insert into public.source_ingestion_runs (
      id, source_id, terms_review_id, started_at, completed_at, status,
      records_read, records_written, records_quarantined, raw_payload_hash,
      parser_version, code_commit, error_summary, metadata
    ) values (
      ingestion_id, fixture_source_id, historical_terms_id,
      maturity_at - interval '10 minutes', maturity_at, 'succeeded',
      1, 1, 0,
      encode(digest('scorecard-maturity-payload-' || slot, 'sha256'), 'hex'),
      'runtime-scorecard-parser-v1', 'runtime-code-v1', null,
      jsonb_build_object('syntheticHistoricalFixture', true)
    );
    insert into public.price_observations (
      id, ingestion_run_id, source_id, terms_review_id, mapping_id, variant_id,
      external_record_id, price_semantics, currency, market_price,
      observed_at, available_at, ingested_at, quality_score,
      observation_status, reason_codes, source_record_hash, metadata,
      created_at, market_series_id
    ) values (
      observation_id, ingestion_id, fixture_source_id, historical_terms_id,
      mapping_id, variant_id, 'runtime-scorecard-maturity-' || slot,
      'market', 'USD', 115 + slot, maturity_at, maturity_at,
      maturity_at + interval '1 minute', 1, 'accepted', array[]::text[],
      encode(digest('scorecard-maturity-record-' || slot, 'sha256'), 'hex'),
      jsonb_build_object('syntheticHistoricalFixture', true),
      maturity_at + interval '1 minute', series_id
    );
  end loop;

  evaluation_at := clock_timestamp();
  insert into public.analytics_runs (
    id, run_kind, status, feature_cutoff, started_at, completed_at,
    dataset_hash, source_policy_hash, mapping_version, feature_version,
    code_version, config_hash, config, records_read, records_written,
    records_quarantined, error_summary, created_at
  ) values (
    evaluation_run_id, 'forecast_evaluation', 'succeeded', evaluation_at,
    evaluation_at - interval '1 minute', evaluation_at,
    encode(digest('collectfolio-scorecard-evaluation-dataset', 'sha256'), 'hex'),
    source_policy_hash, model.mapping_version, model.feature_version,
    model.code_version,
    encode(digest('collectfolio-scorecard-evaluation-config', 'sha256'), 'hex'),
    jsonb_build_object(
      'prospectiveScorecardPlanId', plan_id,
      'syntheticHistoricalFixture', true
    ),
    6, 6, 0, null, evaluation_at - interval '1 minute'
  );
  insert into public.analytics_run_sources (
    analytics_run_id, source_id, terms_review_id, usage_kind, created_at
  ) values (
    evaluation_run_id, fixture_source_id, historical_terms_id, 'raw_price',
    evaluation_at - interval '1 minute'
  );
end;
$$;

alter table public.card_forecast_predictions enable trigger user;

set role service_role;
select public.record_scored_forecast_evaluation(jsonb_build_object(
  'id', md5('collectfolio-scorecard-evaluation-' || slot)::uuid,
  'analytics_run_id', md5('collectfolio-scorecard-evaluation-run')::uuid,
  'prediction_id', md5('collectfolio-scorecard-prediction-' || slot)::uuid,
  'evaluated_at', (
    select completed_at from public.analytics_runs
    where id = md5('collectfolio-scorecard-evaluation-run')::uuid
  )
))
from generate_series(1, 6) slot;
reset role;

do $$
declare
  plan_id constant uuid := md5('collectfolio-scorecard-plan')::uuid;
begin
  if (select count(*) from public.forecast_execution_challenges
      where scorecard_plan_id = plan_id) <> 6
     or (select count(*) from public.forecast_execution_receipts receipt
         join public.forecast_execution_challenges challenge
           on challenge.id = receipt.challenge_id
         where challenge.scorecard_plan_id = plan_id) <> 6
     or (select count(*) from public.forecast_evaluations
         where analytics_run_id = md5(
           'collectfolio-scorecard-evaluation-run'
         )::uuid) <> 6 then
    raise exception 'Synthetic six-origin scorecard fixture is incomplete';
  end if;
  if exists (
    select 1
    from public.forecast_execution_receipts receipt
    join public.forecast_execution_challenges challenge
      on challenge.id = receipt.challenge_id
    where challenge.scorecard_plan_id = plan_id
      and receipt.canonical_output_hash is distinct from
          public.canonical_stored_prospective_output_hash(receipt.id)
  ) then
    raise exception 'Synthetic scorecard receipt commitment does not reconstruct';
  end if;
end;
$$;

commit;
