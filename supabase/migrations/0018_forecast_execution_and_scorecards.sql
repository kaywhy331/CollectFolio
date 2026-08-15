-- CollectFolio prospective execution receipts and database-derived scorecards.
--
-- This migration closes two private-research integrity gaps without enabling a
-- browser forecast or a public promotion path:
--   1. every new prospective output is bound to a future-preregistered plan, a
--      database nonce issued before execution, and an independently held HMAC
--      executor key; and
--   2. prospective scorecard scope, membership, metrics, hashes, and the
--      recommendation are selected and authored by one database transaction.

begin;

do $$
begin
  if coalesce((
    select enabled from public.product_feature_flags
    where key = 'public_price_intelligence'
  ), false) then
    raise exception 'Apply forecast execution receipts only while public_price_intelligence is disabled';
  end if;
end;
$$;

-- PostgreSQL CHECK constraints accept UNKNOWN. Make the fields that define a
-- complete quote explicitly present before any after-cost score can use it.
alter table public.prospective_acquisition_cost_quotes
  add constraint prospective_complete_cost_fields_present_check check (
    quote_status <> 'complete'
    or (
      quote_observed_at is not null
      and offer_price is not null
      and tax_rate is not null
      and buy_shipping is not null
      and sell_fee_rate is not null
      and sell_fee_fixed is not null
      and sell_shipping is not null
      and quote_evidence_hash is not null
      and (
        quote_semantics <> 'provider_listing'
        or (
          quote_market_series_id is not null
          and quote_source_id is not null
          and quote_terms_review_id is not null
          and nullif(btrim(external_quote_id), '') is not null
        )
      )
      and (
        liquidity_status <> 'source_backed'
        or (
          liquidity_haircut_rate is not null
          and liquidity_evidence_hash is not null
        )
      )
    )
  );

-- Keys are provisioned only by the database owner. The normal service role can
-- neither read nor create them. An HMAC proves possession by the configured
-- executor principal; it deliberately does not claim cryptographic proof that
-- a particular artifact actually ran.
create table public.forecast_executor_keys (
  id uuid primary key default gen_random_uuid(),
  executor_label text not null check (char_length(executor_label) between 1 and 160),
  model_artifact_hash text not null check (model_artifact_hash ~ '^[0-9a-f]{64}$'),
  executor_build_hash text not null check (executor_build_hash ~ '^[0-9a-f]{64}$'),
  runtime_hash text not null check (runtime_hash ~ '^[0-9a-f]{64}$'),
  hmac_secret bytea not null check (octet_length(hmac_secret) >= 32),
  secret_fingerprint text generated always as (
    encode(digest(hmac_secret, 'sha256'), 'hex')
  ) stored,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (valid_until > valid_from),
  unique (secret_fingerprint)
);

create table public.prospective_scorecard_plans (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references public.model_versions(id) on delete restrict,
  executor_key_id uuid not null references public.forecast_executor_keys(id) on delete restrict,
  horizon_days integer not null check (horizon_days in (30,90)),
  cohort_key text not null check (char_length(cohort_key) between 1 and 200),
  source_id uuid not null references public.data_sources(id) on delete restrict,
  universe_purpose text not null check (
    universe_purpose in ('forecast_validation','after_cost_opportunity')
  ),
  origin_start timestamptz not null,
  origin_end timestamptz not null,
  origin_schedule timestamptz[] not null check (
    cardinality(origin_schedule) between 6 and 18
  ),
  selection_policy jsonb not null check (
    jsonb_typeof(selection_policy) = 'object'
    and octet_length(selection_policy::text) <= 32768
  ),
  selection_policy_hash text not null check (selection_policy_hash ~ '^[0-9a-f]{64}$'),
  promotion_policy jsonb not null check (
    jsonb_typeof(promotion_policy) = 'object'
    and octet_length(promotion_policy::text) <= 32768
  ),
  promotion_policy_hash text not null check (promotion_policy_hash ~ '^[0-9a-f]{64}$'),
  gate_policy jsonb not null check (
    jsonb_typeof(gate_policy) = 'object'
    and octet_length(gate_policy::text) <= 32768
  ),
  gate_policy_hash text not null check (gate_policy_hash ~ '^[0-9a-f]{64}$'),
  output_policy jsonb not null check (
    jsonb_typeof(output_policy) = 'object'
    and octet_length(output_policy::text) <= 32768
  ),
  created_at timestamptz not null,
  plan_hash text not null unique check (plan_hash ~ '^[0-9a-f]{64}$'),
  check (origin_end >= origin_start + interval '105 days'),
  check (origin_start = origin_schedule[1]),
  check (origin_end = origin_schedule[cardinality(origin_schedule)] + interval '24 hours'),
  unique (
    model_version_id, horizon_days, cohort_key, source_id, universe_purpose
  )
);

create table public.forecast_execution_challenges (
  id uuid primary key default gen_random_uuid(),
  scorecard_plan_id uuid not null references public.prospective_scorecard_plans(id) on delete restrict,
  forecast_analytics_run_id uuid not null unique
    references public.analytics_runs(id) on delete restrict,
  trend_analytics_run_id uuid not null references public.analytics_runs(id) on delete restrict,
  input_manifest_id uuid not null references public.trend_expected_input_manifests(id) on delete restrict,
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  model_version_id uuid not null references public.model_versions(id) on delete restrict,
  executor_key_id uuid not null references public.forecast_executor_keys(id) on delete restrict,
  horizon_days integer not null check (horizon_days in (30,90)),
  origin_slot_index integer not null check (origin_slot_index > 0),
  expected_input_count integer not null check (expected_input_count > 0),
  expected_input_hash text not null check (expected_input_hash ~ '^[0-9a-f]{64}$'),
  selection_policy_hash text not null check (selection_policy_hash ~ '^[0-9a-f]{64}$'),
  source_policy_hash text not null check (source_policy_hash ~ '^[0-9a-f]{64}$'),
  model_artifact_hash text not null check (model_artifact_hash ~ '^[0-9a-f]{64}$'),
  feature_version text not null,
  mapping_version text not null,
  code_version text not null,
  nonce bytea not null check (octet_length(nonce) = 32),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  challenge_hash text not null unique check (challenge_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  check (expires_at = issued_at + interval '5 minutes'),
  check (created_at = issued_at),
  unique (scorecard_plan_id, origin_slot_index),
  unique (id, forecast_analytics_run_id, model_version_id, horizon_days)
);

alter table public.prospective_forecast_runs
  add column execution_challenge_id uuid unique
    references public.forecast_execution_challenges(id) on delete restrict;

create table public.forecast_execution_receipts (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null unique
    references public.forecast_execution_challenges(id) on delete restrict,
  prospective_run_id uuid not null unique
    references public.prospective_forecast_runs(id) on delete restrict,
  forecast_analytics_run_id uuid not null unique
    references public.analytics_runs(id) on delete restrict,
  executor_key_id uuid not null references public.forecast_executor_keys(id) on delete restrict,
  challenge_hash text not null check (challenge_hash ~ '^[0-9a-f]{64}$'),
  expected_input_hash text not null check (expected_input_hash ~ '^[0-9a-f]{64}$'),
  output_count integer not null check (output_count > 0),
  canonical_output_hash text not null check (canonical_output_hash ~ '^[0-9a-f]{64}$'),
  forecast_dataset_hash text not null check (forecast_dataset_hash ~ '^[0-9a-f]{64}$'),
  core_submission_hash text not null check (core_submission_hash ~ '^[0-9a-f]{64}$'),
  executor_build_hash text not null check (executor_build_hash ~ '^[0-9a-f]{64}$'),
  runtime_hash text not null check (runtime_hash ~ '^[0-9a-f]{64}$'),
  execution_started_at timestamptz not null,
  execution_completed_at timestamptz not null,
  received_at timestamptz not null,
  executor_signature text not null check (executor_signature ~ '^[0-9a-f]{64}$'),
  attestation_level text not null check (attestation_level = 'hmac_executor_principal_v1'),
  artifact_execution_verified boolean not null default false
    check (not artifact_execution_verified),
  receipt_hash text not null unique check (receipt_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  check (forecast_dataset_hash = canonical_output_hash),
  check (execution_started_at <= execution_completed_at),
  check (execution_completed_at <= received_at),
  check (created_at = received_at)
);

create table public.prospective_prediction_outputs (
  prediction_id uuid primary key
    references public.card_forecast_predictions(id) on delete restrict,
  execution_receipt_id uuid not null
    references public.forecast_execution_receipts(id) on delete restrict,
  prospective_run_id uuid not null
    references public.prospective_forecast_runs(id) on delete restrict,
  baseline_prices jsonb not null check (
    jsonb_typeof(baseline_prices) = 'object'
    and baseline_prices ?& array[
      'no_change','damped_momentum','market_index','lifecycle_cohort',
      'structural_convergence'
    ]
    and baseline_prices - array[
      'no_change','damped_momentum','market_index','lifecycle_cohort',
      'structural_convergence'
    ] = '{}'::jsonb
    and jsonb_typeof(baseline_prices->'no_change') = 'number'
    and jsonb_typeof(baseline_prices->'damped_momentum') = 'number'
    and jsonb_typeof(baseline_prices->'market_index') = 'number'
    and jsonb_typeof(baseline_prices->'lifecycle_cohort') = 'number'
    and jsonb_typeof(baseline_prices->'structural_convergence') = 'number'
    and (baseline_prices->>'no_change')::numeric > 0
    and (baseline_prices->>'damped_momentum')::numeric > 0
    and (baseline_prices->>'market_index')::numeric > 0
    and (baseline_prices->>'lifecycle_cohort')::numeric > 0
    and (baseline_prices->>'structural_convergence')::numeric > 0
  ),
  probability_net_positive numeric(7,6)
    check (probability_net_positive between 0 and 1),
  structural_lower_price numeric(16,4)
    check (structural_lower_price is null or structural_lower_price > 0),
  selected_for_pocket boolean not null,
  selection_reason_codes text[] not null default '{}',
  output_hash text not null unique check (output_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  unique (execution_receipt_id, prediction_id),
  check (
    (selected_for_pocket and cardinality(selection_reason_codes) = 0)
    or (not selected_for_pocket and cardinality(selection_reason_codes) > 0)
  )
);

create or replace function public.create_prospective_scorecard_plan(
  requested_plan jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  database_created_at timestamptz := clock_timestamp();
  plan_id uuid := gen_random_uuid();
  model public.model_versions%rowtype;
  executor_key public.forecast_executor_keys%rowtype;
  selection_policy jsonb;
  promotion_policy jsonb;
  canonical_promotion_policy jsonb := jsonb_build_object(
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
  );
  canonical_gate_policy jsonb := jsonb_build_object(
    'version', 'prospective-gates-v1',
    'minimumVariants', 50,
    'minimumSets', 5,
    'minimumSpacedOrigins', 6,
    'minimumOriginSpacingDays', 21,
    'bootstrapSamples', 600,
    'confidenceLevel', 0.95,
    'minimumLiftLowerBound', 0.0,
    'minimumProbabilityCalibrationCases', 50,
    'minimumAfterCostCalibrationCases', 50,
    'maximumAfterCostBrierScore', 0.25,
    'maximumAfterCostCalibrationError', 0.10,
    'minimumSelectedPocketCases', 30,
    'minimumSelectedPositiveRate', 0.60,
    'minimumSelectedMedianNetRoi', 0.0,
    'maximumSelectedFalseDiscoveryRate', 0.40
  );
  canonical_output_policy jsonb := jsonb_build_object(
    'version', 'prospective-output-v1',
    'minimumProbabilityNetPositive', 0.70,
    'requireStructuralLowerBound', true,
    'requiredBaselines', jsonb_build_array(
      'no_change','damped_momentum','market_index','lifecycle_cohort',
      'structural_convergence'
    )
  );
  origin_start timestamptz;
  origin_end timestamptz;
  origin_schedule timestamptz[];
  horizon integer;
  cohort text;
  purpose text;
  source_id uuid;
  selection_hash text;
  promotion_hash text;
  gate_hash text;
  generated_plan_hash text;
begin
  if requested_plan is null
     or not (requested_plan ?& array[
       'modelVersionId','executorKeyId','horizonDays','cohortKey','sourceId',
       'universePurpose','originStart','originEnd','originSchedule','selectionPolicy',
       'promotionPolicy'
     ])
     or requested_plan - array[
       'modelVersionId','executorKeyId','horizonDays','cohortKey','sourceId',
       'universePurpose','originStart','originEnd','originSchedule','selectionPolicy',
       'promotionPolicy'
     ] <> '{}'::jsonb
     or jsonb_typeof(requested_plan->'originSchedule') <> 'array' then
    raise exception 'Prospective scorecard plans accept only the immutable model, executor, scope, and policy declaration';
  end if;

  select * into model from public.model_versions
  where id = (requested_plan->>'modelVersionId')::uuid;
  select * into executor_key from public.forecast_executor_keys
  where id = (requested_plan->>'executorKeyId')::uuid;
  horizon := (requested_plan->>'horizonDays')::integer;
  cohort := nullif(btrim(requested_plan->>'cohortKey'), '');
  purpose := requested_plan->>'universePurpose';
  source_id := (requested_plan->>'sourceId')::uuid;
  origin_start := (requested_plan->>'originStart')::timestamptz;
  origin_end := (requested_plan->>'originEnd')::timestamptz;
  select array_agg(value::timestamptz order by ordinal)
    into origin_schedule
  from jsonb_array_elements_text(requested_plan->'originSchedule')
    with ordinality scheduled(value, ordinal);
  selection_policy := requested_plan->'selectionPolicy';
  promotion_policy := requested_plan->'promotionPolicy';

  if model.id is null
     or model.model_family <> 'quantile_return_forecast'
     or model.model_artifact_hash is null
     or not model.research_only
     or horizon not in (30,90)
     or not (horizon = any(model.allowed_horizons)) then
    raise exception 'Prospective plans require a private 30/90-day quantile model artifact';
  end if;
  if executor_key.id is null
     or executor_key.model_artifact_hash <> model.model_artifact_hash
     or executor_key.valid_from > origin_start
     or executor_key.valid_until < origin_end + interval '5 minutes' then
    raise exception 'Prospective plan executor key is absent, mismatched, or not valid for the full origin window';
  end if;
  if cardinality(origin_schedule) not between 6 and 18
     or origin_start is distinct from origin_schedule[1]
     or origin_end is distinct from
          origin_schedule[cardinality(origin_schedule)] + interval '24 hours'
     or exists (
       select 1
       from generate_subscripts(origin_schedule, 1) slot
       where slot > 1
         and origin_schedule[slot]
               < origin_schedule[slot - 1] + interval '22 days'
     )
     or origin_start <= database_created_at
     or origin_end < origin_start + interval '105 days'
     or origin_end > origin_start + interval '365 days' then
    raise exception 'Prospective scorecard scope requires 6-18 future origin slots with 21 full days between 24-hour windows, inside 105-365 days';
  end if;
  if cohort is distinct from 'pokemon-en-raw-nm'
     or purpose not in ('forecast_validation','after_cost_opportunity') then
    raise exception 'Prospective plan is restricted to the Pokémon English raw Near Mint pilot';
  end if;
  if selection_policy is null
     or jsonb_typeof(selection_policy) <> 'object'
     or not (selection_policy ?& array[
       'version','cohortKey','game','sourceId','currency','language',
       'conditionClass','marketCondition','priceSemantics','finishes',
       'minimumEvidenceQuality','purpose','maximumFeatureAgeHours',
       'maximumQuoteAgeHours'
     ])
     or selection_policy - array[
       'version','cohortKey','game','sourceId','currency','language',
       'conditionClass','marketCondition','priceSemantics','finishes',
       'minimumEvidenceQuality','purpose','maximumFeatureAgeHours',
       'maximumQuoteAgeHours'
     ] <> '{}'::jsonb
     or selection_policy->>'cohortKey' is distinct from cohort
     or selection_policy->>'sourceId' is distinct from source_id::text
     or selection_policy->>'purpose' is distinct from purpose
     or selection_policy->>'game' is distinct from 'pokemon'
     or selection_policy->>'currency' is distinct from 'USD'
     or selection_policy->>'language' is distinct from 'en'
     or selection_policy->>'conditionClass' is distinct from 'raw'
     or selection_policy->>'marketCondition' is distinct from 'near-mint'
     or selection_policy->>'priceSemantics' is distinct from 'market'
     or jsonb_typeof(selection_policy->'finishes') <> 'array'
     or jsonb_array_length(selection_policy->'finishes') = 0
     or jsonb_typeof(selection_policy->'minimumEvidenceQuality') <> 'number'
     or (selection_policy->>'minimumEvidenceQuality')::numeric < 0.55
     or (selection_policy->>'minimumEvidenceQuality')::numeric > 1
     or jsonb_typeof(selection_policy->'maximumFeatureAgeHours') <> 'number'
     or (selection_policy->>'maximumFeatureAgeHours')::numeric <= 0
     or (selection_policy->>'maximumFeatureAgeHours')::numeric > 168
     or jsonb_typeof(selection_policy->'maximumQuoteAgeHours') <> 'number'
     or (selection_policy->>'maximumQuoteAgeHours')::numeric <= 0
     or (selection_policy->>'maximumQuoteAgeHours')::numeric > 168 then
    raise exception 'Prospective plan selection policy is incomplete, lenient, or outside the exact-series pilot';
  end if;
  if promotion_policy is distinct from canonical_promotion_policy then
    raise exception 'Prospective scorecards require the canonical five-baseline promotion policy';
  end if;

  selection_hash := encode(digest(selection_policy::text, 'sha256'), 'hex');
  promotion_hash := encode(digest(canonical_promotion_policy::text, 'sha256'), 'hex');
  gate_hash := encode(digest(canonical_gate_policy::text, 'sha256'), 'hex');
  generated_plan_hash := encode(digest(concat_ws('|',
    plan_id::text, model.id::text, executor_key.id::text, horizon::text,
    cohort, source_id::text, purpose, origin_start::text, origin_end::text,
    array_to_string(origin_schedule, ','),
    selection_hash, promotion_hash, gate_hash,
    encode(digest(canonical_output_policy::text, 'sha256'), 'hex'),
    database_created_at::text
  ), 'sha256'), 'hex');

  insert into public.prospective_scorecard_plans (
    id, model_version_id, executor_key_id, horizon_days, cohort_key, source_id,
    universe_purpose, origin_start, origin_end, origin_schedule, selection_policy,
    selection_policy_hash, promotion_policy, promotion_policy_hash,
    gate_policy, gate_policy_hash, output_policy, created_at, plan_hash
  ) values (
    plan_id, model.id, executor_key.id, horizon, cohort, source_id, purpose,
    origin_start, origin_end, origin_schedule, selection_policy, selection_hash,
    canonical_promotion_policy, promotion_hash, canonical_gate_policy, gate_hash,
    canonical_output_policy, database_created_at, generated_plan_hash
  );
  return plan_id;
end;
$$;

create or replace function public.canonical_forecast_execution_input_hash(
  requested_trend_analytics_run_id uuid
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select encode(digest(concat_ws('|',
    run.id::text, run.dataset_hash, run.feature_cutoff::text,
    string_agg(concat_ws(':',
      series.id::text, series.identity_hash, snapshot.id::text,
      snapshot.snapshot_hash, snapshot.terms_review_id::text,
      snapshot.evidence_quality::text, snapshot.feature_cutoff::text
    ), '||' order by series.identity_hash, snapshot.id)
  ), 'sha256'), 'hex')
  from public.analytics_runs run
  join public.trend_feature_snapshots snapshot
    on snapshot.analytics_run_id = run.id
  join public.market_series series on series.id = snapshot.market_series_id
  where run.id = requested_trend_analytics_run_id
  group by run.id, run.dataset_hash, run.feature_cutoff
$$;

create or replace function public.begin_prospective_forecast_execution(
  requested_execution jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  database_issued_at timestamptz;
  challenge_id uuid := gen_random_uuid();
  nonce bytea;
  plan public.prospective_scorecard_plans%rowtype;
  forecast_run public.analytics_runs%rowtype;
  trend_run public.analytics_runs%rowtype;
  model public.model_versions%rowtype;
  input_manifest public.trend_expected_input_manifests%rowtype;
  executor_key public.forecast_executor_keys%rowtype;
  actual_count bigint;
  actual_hash text;
  actual_series_hash text;
  generated_challenge_hash text;
  selected_origin_slot_index integer;
begin
  if requested_execution is null
     or not (requested_execution ?& array[
       'scorecardPlanId','forecastAnalyticsRunId','trendAnalyticsRunId'
     ])
     or requested_execution - array[
       'scorecardPlanId','forecastAnalyticsRunId','trendAnalyticsRunId'
     ] <> '{}'::jsonb then
    raise exception 'Execution challenge accepts only plan, forecast-run, and trend-run identifiers';
  end if;

  select * into plan from public.prospective_scorecard_plans
  where id = (requested_execution->>'scorecardPlanId')::uuid
  for update;
  select * into forecast_run from public.analytics_runs
  where id = (requested_execution->>'forecastAnalyticsRunId')::uuid
  for update;
  database_issued_at := clock_timestamp();
  nonce := gen_random_bytes(32);
  select * into trend_run from public.analytics_runs
  where id = (requested_execution->>'trendAnalyticsRunId')::uuid;
  select * into model from public.model_versions where id = plan.model_version_id;
  select * into executor_key from public.forecast_executor_keys
  where id = plan.executor_key_id;
  select * into input_manifest from public.trend_expected_input_manifests
  where trend_analytics_run_id = trend_run.id;

  if plan.id is null
     or database_issued_at < plan.origin_start
     or database_issued_at > plan.origin_end then
    raise exception 'Execution challenge is outside its immutable prospective plan window';
  end if;
  select slot into selected_origin_slot_index
  from generate_subscripts(plan.origin_schedule, 1) slot
  where database_issued_at >= plan.origin_schedule[slot]
    and database_issued_at < plan.origin_schedule[slot] + interval '24 hours';
  if selected_origin_slot_index is null
     or exists (
       select 1 from public.forecast_execution_challenges prior
       where prior.scorecard_plan_id = plan.id
         and prior.origin_slot_index = selected_origin_slot_index
     ) then
    raise exception 'Execution challenge must consume one unused preregistered 24-hour origin slot';
  end if;
  if forecast_run.id is null
     or forecast_run.run_kind <> 'forecast_build'
     or forecast_run.status <> 'running'
     or forecast_run.completed_at is not null
     or forecast_run.dataset_hash is not null
     or forecast_run.records_written <> 0
     or forecast_run.records_quarantined <> 0
     or exists (
       select 1 from public.card_forecast_predictions prediction
       where prediction.analytics_run_id = forecast_run.id
     ) then
    raise exception 'Execution challenge requires one still-running output-free forecast build';
  end if;
  if trend_run.id is null
     or trend_run.run_kind <> 'trend_build'
     or trend_run.status <> 'succeeded'
     or trend_run.completed_at > database_issued_at
     or trend_run.dataset_hash is null
     or input_manifest.id is null
     or input_manifest.manifest_hash is null
     or input_manifest.sealed_at > trend_run.completed_at then
    raise exception 'Execution challenge requires a manifest-complete succeeded trend build';
  end if;
  if model.id is null
     or model.id <> plan.model_version_id
     or model.model_artifact_hash is null
     or model.model_artifact_hash <> executor_key.model_artifact_hash
     or forecast_run.feature_version <> model.feature_version
     or forecast_run.mapping_version <> model.mapping_version
     or forecast_run.code_version <> model.code_version
     or trend_run.feature_version <> model.feature_version
     or trend_run.mapping_version <> model.mapping_version
     or trend_run.code_version <> model.code_version
     or forecast_run.source_policy_hash <> trend_run.source_policy_hash
     or forecast_run.config->'candidateUniversePolicy' is distinct from plan.selection_policy
     or trend_run.config->'candidateUniversePolicy' is distinct from plan.selection_policy
     or forecast_run.feature_cutoff is distinct from trend_run.feature_cutoff then
    raise exception 'Execution challenge model, source, policy, or code lineage differs';
  end if;
  if input_manifest.selection_policy is distinct from plan.selection_policy
     or input_manifest.selection_policy_hash <> plan.selection_policy_hash
     or input_manifest.feature_cutoff <> trend_run.feature_cutoff then
    raise exception 'Execution challenge manifest differs from the preregistered plan policy';
  end if;
  if model.created_at > database_issued_at
     or model.trained_through is null
     or model.trained_through > database_issued_at then
    raise exception 'Execution challenge model artifact did not exist at challenge issuance';
  end if;
  if executor_key.id is null
     or database_issued_at < executor_key.valid_from
     or database_issued_at + interval '5 minutes' > executor_key.valid_until then
    raise exception 'Execution challenge has no currently valid independent executor key';
  end if;
  if not exists (
    select 1
    from public.data_sources source
    join public.source_terms_reviews terms
      on terms.id = source.current_terms_review_id
     and terms.source_id = source.id
    where source.id = plan.source_id
      and source.active
      and terms.decision in ('research_only','approved')
      and terms.reviewed_at <= database_issued_at
      and terms.created_at <= database_issued_at
      and terms.commercial_use_allowed
      and terms.private_forecast_modeling_allowed
      and terms.prospective_capture_allowed
      and terms.exact_condition_labels_allowed
      and terms.retention_through_maturity_allowed
      and terms.predictive_derivatives_allowed
      and (
        terms.expires_at is null
        or terms.expires_at
             > database_issued_at + make_interval(days => plan.horizon_days)
      )
  ) then
    raise exception 'Execution challenge source or prospective rights are inactive, stale, or too short-lived';
  end if;

  select count(*) into actual_count
  from public.trend_feature_snapshots snapshot
  where snapshot.analytics_run_id = trend_run.id;
  actual_hash := public.canonical_forecast_execution_input_hash(trend_run.id);
  select encode(digest(string_agg(concat_ws(':',
           series.id::text, series.identity_hash
         ), '||' order by series.id), 'sha256'), 'hex')
    into actual_series_hash
  from public.trend_feature_snapshots snapshot
  join public.market_series series on series.id = snapshot.market_series_id
  where snapshot.analytics_run_id = trend_run.id;
  if actual_count <> input_manifest.expected_series_count
     or trend_run.records_written <> input_manifest.expected_series_count
     or actual_series_hash <> input_manifest.expected_series_hash
     or actual_hash is null then
    raise exception 'Execution challenge input differs from the independently sealed manifest';
  end if;

  generated_challenge_hash := encode(digest(concat_ws('|',
    challenge_id::text, plan.id::text, forecast_run.id::text,
    trend_run.id::text, input_manifest.id::text, input_manifest.manifest_hash,
    model.id::text, model.model_artifact_hash, executor_key.id::text,
    plan.horizon_days::text, selected_origin_slot_index::text,
    plan.origin_schedule[selected_origin_slot_index]::text,
    actual_count::text, actual_hash,
    plan.selection_policy_hash, forecast_run.source_policy_hash,
    model.feature_version, model.mapping_version, model.code_version,
    encode(nonce, 'hex'), database_issued_at::text,
    (database_issued_at + interval '5 minutes')::text
  ), 'sha256'), 'hex');

  insert into public.forecast_execution_challenges (
    id, scorecard_plan_id, forecast_analytics_run_id, trend_analytics_run_id,
    input_manifest_id, input_manifest_hash, model_version_id, executor_key_id,
    horizon_days, origin_slot_index, expected_input_count, expected_input_hash,
    selection_policy_hash, source_policy_hash, model_artifact_hash,
    feature_version, mapping_version, code_version, nonce, issued_at, expires_at,
    challenge_hash, created_at
  ) values (
    challenge_id, plan.id, forecast_run.id, trend_run.id, input_manifest.id,
    input_manifest.manifest_hash, model.id, executor_key.id, plan.horizon_days,
    selected_origin_slot_index, actual_count, actual_hash,
    plan.selection_policy_hash,
    forecast_run.source_policy_hash, model.model_artifact_hash,
    model.feature_version, model.mapping_version, model.code_version, nonce,
    database_issued_at, database_issued_at + interval '5 minutes',
    generated_challenge_hash, database_issued_at
  );

  return jsonb_build_object(
    'challengeId', challenge_id,
    'challengeHash', generated_challenge_hash,
    'nonce', encode(nonce, 'hex'),
    'expectedInputCount', actual_count,
    'expectedInputHash', actual_hash,
    'modelArtifactHash', model.model_artifact_hash,
    'executorKeyId', executor_key.id,
    'executorBuildHash', executor_key.executor_build_hash,
    'runtimeHash', executor_key.runtime_hash,
    'originSlotIndex', selected_origin_slot_index,
    'scheduledOrigin', plan.origin_schedule[selected_origin_slot_index],
    'issuedAt', database_issued_at,
    'expiresAt', database_issued_at + interval '5 minutes',
    'attestationLevel', 'hmac_executor_principal_v1',
    'artifactExecutionVerified', false
  );
end;
$$;

-- Canonical output hashing is independent of caller array order. Numeric model
-- outputs use decimal strings so the external executor and PostgreSQL sign the
-- same bytes without float or JSON-renderer ambiguity.
create or replace function public.canonical_prospective_cost_quote_hash(
  requested_quote jsonb
)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select encode(digest(concat_ws(chr(31),
    coalesce(requested_quote->>'status', ''),
    coalesce(requested_quote->>'semantics', ''),
    coalesce((requested_quote->>'quoteMarketSeriesId')::uuid::text, ''),
    coalesce((requested_quote->>'termsReviewId')::uuid::text, ''),
    encode(digest(coalesce(requested_quote->>'externalQuoteId', ''), 'sha256'), 'hex'),
    coalesce(to_char(
      (requested_quote->>'observedAt')::timestamptz at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ), ''),
    coalesce(requested_quote->>'evidenceHash', ''),
    coalesce(trim_scale((requested_quote->>'offerPrice')::numeric(16,4))::text, ''),
    coalesce(trim_scale((requested_quote->>'taxRate')::numeric(9,8))::text, ''),
    coalesce(trim_scale((requested_quote->>'buyShipping')::numeric(16,4))::text, ''),
    coalesce(trim_scale((requested_quote->>'sellFeeRate')::numeric(9,8))::text, ''),
    coalesce(trim_scale((requested_quote->>'sellFeeFixed')::numeric(16,4))::text, ''),
    coalesce(trim_scale((requested_quote->>'sellShipping')::numeric(16,4))::text, ''),
    case when requested_quote->>'status' = 'unavailable' then 'unavailable'
      else coalesce(requested_quote->>'liquidityStatus', '') end,
    coalesce(trim_scale(
      (requested_quote->>'liquidityHaircutRate')::numeric(9,8)
    )::text, ''),
    coalesce(requested_quote->>'liquidityEvidenceHash', ''),
    encode(digest(coalesce(btrim(requested_quote->>'unavailableReason'), ''), 'sha256'), 'hex')
  ), 'sha256'), 'hex')
$$;

create or replace function public.canonical_prospective_candidate_output_hash(
  requested_candidates jsonb
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select encode(digest(string_agg(concat_ws(chr(31),
    series.identity_hash,
    snapshot.id::text,
    trim_scale((item->>'q10')::numeric(16,4))::text,
    trim_scale((item->>'q25')::numeric(16,4))::text,
    trim_scale((item->>'q50')::numeric(16,4))::text,
    trim_scale((item->>'q75')::numeric(16,4))::text,
    trim_scale((item->>'q90')::numeric(16,4))::text,
    trim_scale((item->>'probabilityUp')::numeric(7,6))::text,
    trim_scale((item->>'confidence')::numeric(7,4))::text,
    item->>'predictionStatus',
    encode(digest(coalesce((
      select string_agg(code, chr(30) order by code)
      from jsonb_array_elements_text(item->'reasonCodes') reason(code)
    ), ''), 'sha256'), 'hex'),
    item->>'costQuoteHash',
    trim_scale((item->'baselinePrices'->>'no_change')::numeric(16,4))::text,
    trim_scale((item->'baselinePrices'->>'damped_momentum')::numeric(16,4))::text,
    trim_scale((item->'baselinePrices'->>'market_index')::numeric(16,4))::text,
    trim_scale((item->'baselinePrices'->>'lifecycle_cohort')::numeric(16,4))::text,
    trim_scale((item->'baselinePrices'->>'structural_convergence')::numeric(16,4))::text,
    case when jsonb_typeof(item->'probabilityNetPositive') = 'null' then 'null'
      else trim_scale((item->>'probabilityNetPositive')::numeric(7,6))::text end,
    case when jsonb_typeof(item->'structuralLowerPrice') = 'null' then 'null'
      else trim_scale((item->>'structuralLowerPrice')::numeric(16,4))::text end
  ), chr(29) order by series.identity_hash, snapshot.id), 'sha256'), 'hex')
  from jsonb_array_elements(requested_candidates) item
  join public.trend_feature_snapshots snapshot
    on snapshot.id = (item->>'trendSnapshotId')::uuid
  join public.market_series series on series.id = snapshot.market_series_id
  where item->>'marketSeriesIdentityHash' = series.identity_hash
$$;

-- Reconstruct the same commitment exclusively from immutable stored rows. The
-- receipt transaction and later scorecard derivation both compare this value
-- with the executor-signed hash, so JSON spelling, numeric typmod rounding, or
-- database-added reason codes cannot sever the attestation from its evidence.
create or replace function public.canonical_stored_prospective_cost_quote_hash(
  requested_quote_id uuid
)
returns text
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  select public.canonical_prospective_cost_quote_hash(jsonb_build_object(
    'status', quote.quote_status,
    'semantics', quote.quote_semantics,
    'quoteMarketSeriesId', quote.quote_market_series_id,
    'termsReviewId', quote.quote_terms_review_id,
    'externalQuoteId', quote.external_quote_id,
    'observedAt', quote.quote_observed_at,
    'evidenceHash', quote.quote_evidence_hash,
    'offerPrice', quote.offer_price,
    'taxRate', quote.tax_rate,
    'buyShipping', quote.buy_shipping,
    'sellFeeRate', quote.sell_fee_rate,
    'sellFeeFixed', quote.sell_fee_fixed,
    'sellShipping', quote.sell_shipping,
    'liquidityStatus', quote.liquidity_status,
    'liquidityHaircutRate', quote.liquidity_haircut_rate,
    'liquidityEvidenceHash', quote.liquidity_evidence_hash,
    'unavailableReason', quote.unavailable_reason
  ))
  from public.prospective_acquisition_cost_quotes quote
  where quote.id = requested_quote_id
$$;

create or replace function public.canonical_stored_prospective_output_hash(
  requested_receipt_id uuid
)
returns text
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  select encode(digest(string_agg(concat_ws(chr(31),
    series.identity_hash,
    prediction.trend_snapshot_id::text,
    trim_scale(prediction.q10)::text,
    trim_scale(prediction.q25)::text,
    trim_scale(prediction.q50)::text,
    trim_scale(prediction.q75)::text,
    trim_scale(prediction.q90)::text,
    trim_scale(prediction.probability_up)::text,
    trim_scale(prediction.confidence)::text,
    prediction.prediction_status,
    encode(digest(coalesce((
      select string_agg(code, chr(30) order by code)
      from unnest(prediction.reason_codes) reason(code)
    ), ''), 'sha256'), 'hex'),
    public.canonical_stored_prospective_cost_quote_hash(quote.id),
    trim_scale((output.baseline_prices->>'no_change')::numeric(16,4))::text,
    trim_scale((output.baseline_prices->>'damped_momentum')::numeric(16,4))::text,
    trim_scale((output.baseline_prices->>'market_index')::numeric(16,4))::text,
    trim_scale((output.baseline_prices->>'lifecycle_cohort')::numeric(16,4))::text,
    trim_scale((output.baseline_prices->>'structural_convergence')::numeric(16,4))::text,
    coalesce(trim_scale(output.probability_net_positive)::text, 'null'),
    coalesce(trim_scale(output.structural_lower_price)::text, 'null')
  ), chr(29) order by series.identity_hash, prediction.trend_snapshot_id),
  'sha256'), 'hex')
  from public.forecast_execution_receipts receipt
  join public.card_forecast_predictions prediction
    on prediction.prospective_run_id = receipt.prospective_run_id
  join public.market_series series on series.id = prediction.market_series_id
  join public.prospective_prediction_outputs output
    on output.execution_receipt_id = receipt.id
   and output.prediction_id = prediction.id
  join public.prospective_acquisition_cost_quotes quote
    on quote.candidate_member_id = prediction.prospective_candidate_member_id
   and quote.prospective_run_id = receipt.prospective_run_id
  where receipt.id = requested_receipt_id
$$;

-- Every prediction insert locks its analytics run before checking whether that
-- run has been challenged. This closes the gap between challenge issuance and
-- receipt finalization: a direct/retrospective insert can neither race the
-- receipt nor hide outside its signed prospective-run reconstruction.
create or replace function public.guard_challenged_forecast_prediction_insert()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  challenged_id uuid;
  expected_owner name;
begin
  perform 1 from public.analytics_runs run
  where run.id = new.analytics_run_id
  for update;
  if not found then
    raise exception 'Prediction analytics run is absent';
  end if;
  select challenge.id into challenged_id
  from public.forecast_execution_challenges challenge
  where challenge.forecast_analytics_run_id = new.analytics_run_id;
  if challenged_id is null then
    return new;
  end if;
  select pg_get_userbyid(proowner) into expected_owner
  from pg_proc
  where oid =
    'public.record_challenged_prospective_forecast_run(jsonb,jsonb)'::regprocedure;
  if current_user <> expected_owner
     or current_setting('collectfolio.challenged_forecast_execution', true)
          is distinct from challenged_id::text then
    raise exception 'Challenged forecast run accepts predictions only inside its signed receipt transaction';
  end if;
  return new;
end;
$$;

create trigger card_forecast_predictions_000_guard_challenged_run
  before insert on public.card_forecast_predictions
  for each row execute function public.guard_challenged_forecast_prediction_insert();

-- The legacy 0017 recorder remains the thoroughly validated atomic writer for
-- universe/cost/prediction rows, but its service-role grant is removed below.
-- These insert-time hooks replace its receipt-time timestamp with the earlier
-- database challenge instant and reseal hashes while the challenged wrapper is
-- active. The entire call remains one transaction.
create or replace function public.apply_challenged_prospective_run_origin()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  requested_challenge text;
  challenge public.forecast_execution_challenges%rowtype;
begin
  requested_challenge := current_setting(
    'collectfolio.challenged_forecast_execution', true
  );
  if coalesce(requested_challenge, '') = '' then
    return new;
  end if;
  select * into challenge from public.forecast_execution_challenges
  where id = requested_challenge::uuid;
  if challenge.id is null
     or new.analytics_run_id <> challenge.forecast_analytics_run_id
     or new.trend_analytics_run_id <> challenge.trend_analytics_run_id
     or new.model_version_id <> challenge.model_version_id
     or new.horizon_days <> challenge.horizon_days
     or new.forecast_dataset_hash <> current_setting(
       'collectfolio.challenged_output_hash', true
     ) then
    raise exception 'Prospective run does not match its database execution challenge';
  end if;
  new.execution_challenge_id := challenge.id;
  new.origin := challenge.issued_at;
  new.matures_at := challenge.issued_at
    + make_interval(days => challenge.horizon_days);
  new.created_at := challenge.issued_at;
  new.run_hash := encode(digest(concat_ws('|',
    new.id::text, new.analytics_run_id::text,
    new.trend_analytics_run_id::text, new.model_version_id::text,
    new.input_manifest_id::text, new.input_manifest_hash,
    challenge.id::text, challenge.challenge_hash, challenge.issued_at::text,
    new.horizon_days::text, new.model_artifact_hash,
    new.feature_dataset_hash, new.forecast_dataset_hash,
    new.source_policy_hash, new.feature_version, new.mapping_version,
    new.code_version, new.submission_hash
  ), 'sha256'), 'hex');
  return new;
end;
$$;

create trigger prospective_forecast_runs_00_challenge_origin
  before insert on public.prospective_forecast_runs
  for each row execute function public.apply_challenged_prospective_run_origin();

create or replace function public.apply_challenged_universe_origin()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  challenge_id text;
  issued timestamptz;
begin
  challenge_id := current_setting('collectfolio.challenged_forecast_execution', true);
  if coalesce(challenge_id, '') = '' then
    return new;
  end if;
  select challenge.issued_at into issued
  from public.forecast_execution_challenges challenge
  join public.prospective_forecast_runs run
    on run.execution_challenge_id = challenge.id
  where challenge.id = challenge_id::uuid and run.id = new.prospective_run_id;
  if issued is null then
    raise exception 'Candidate universe does not match the active execution challenge';
  end if;
  new.sealed_at := issued;
  new.created_at := issued;
  return new;
end;
$$;

create trigger prospective_candidate_universes_00_challenge_origin
  before insert on public.prospective_candidate_universes
  for each row execute function public.apply_challenged_universe_origin();

create or replace function public.apply_challenged_member_origin()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  challenge_id text;
  issued timestamptz;
begin
  challenge_id := current_setting('collectfolio.challenged_forecast_execution', true);
  if coalesce(challenge_id, '') = '' then
    return new;
  end if;
  select challenge.issued_at into issued
  from public.forecast_execution_challenges challenge
  join public.prospective_forecast_runs run
    on run.execution_challenge_id = challenge.id
  where challenge.id = challenge_id::uuid and run.id = new.prospective_run_id;
  if issued is null then
    raise exception 'Candidate member does not match the active execution challenge';
  end if;
  new.created_at := issued;
  return new;
end;
$$;

create trigger prospective_candidate_members_00_challenge_origin
  before insert on public.prospective_candidate_universe_members
  for each row execute function public.apply_challenged_member_origin();

create or replace function public.apply_challenged_cost_origin()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  challenge_id text;
  challenge_hash text;
  issued timestamptz;
begin
  challenge_id := current_setting('collectfolio.challenged_forecast_execution', true);
  if coalesce(challenge_id, '') = '' then
    return new;
  end if;
  select challenge.issued_at, challenge.challenge_hash
    into issued, challenge_hash
  from public.forecast_execution_challenges challenge
  join public.prospective_forecast_runs run
    on run.execution_challenge_id = challenge.id
  where challenge.id = challenge_id::uuid and run.id = new.prospective_run_id;
  if issued is null then
    raise exception 'Cost quote does not match the active execution challenge';
  end if;
  new.captured_at := issued;
  new.created_at := issued;
  new.quote_hash := encode(digest(concat_ws('|',
    new.quote_hash, challenge_hash, issued::text
  ), 'sha256'), 'hex');
  return new;
end;
$$;

create trigger prospective_cost_quotes_00_challenge_origin
  before insert on public.prospective_acquisition_cost_quotes
  for each row execute function public.apply_challenged_cost_origin();

create or replace function public.apply_challenged_prediction_origin()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  challenge_id text;
  challenge public.forecast_execution_challenges%rowtype;
begin
  challenge_id := current_setting('collectfolio.challenged_forecast_execution', true);
  if coalesce(challenge_id, '') = '' then
    return new;
  end if;
  select * into challenge from public.forecast_execution_challenges
  where id = challenge_id::uuid;
  if challenge.id is null
     or new.analytics_run_id <> challenge.forecast_analytics_run_id
     or new.model_version_id <> challenge.model_version_id
     or new.horizon_days <> challenge.horizon_days then
    raise exception 'Prediction does not match the active execution challenge';
  end if;
  select array_agg(reason order by reason) into new.reason_codes
  from unnest(new.reason_codes) reason;
  new.origin := challenge.issued_at;
  new.matures_at := challenge.issued_at
    + make_interval(days => challenge.horizon_days);
  new.created_at := challenge.issued_at;
  new.prediction_hash := encode(digest(concat_ws('|',
    new.id::text, new.prospective_run_id::text,
    new.candidate_universe_id::text,
    new.prospective_candidate_member_id::text,
    new.model_version_id::text, new.trend_snapshot_id::text,
    new.market_series_id::text, challenge.id::text,
    challenge.challenge_hash, new.origin::text, new.horizon_days::text,
    new.current_price::text, new.q10::text, new.q25::text, new.q50::text,
    new.q75::text, new.q90::text, new.probability_up::text,
    new.confidence::text, new.prediction_status,
    array_to_string(new.reason_codes, ','), new.dataset_hash,
    new.feature_version, new.mapping_version, new.code_version
  ), 'sha256'), 'hex');
  return new;
end;
$$;

create trigger card_forecast_predictions_00_challenge_origin
  before insert on public.card_forecast_predictions
  for each row execute function public.apply_challenged_prediction_origin();

create or replace function public.record_challenged_prospective_forecast_run(
  requested_execution jsonb,
  requested_candidates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  database_received_at timestamptz;
  challenge public.forecast_execution_challenges%rowtype;
  plan public.prospective_scorecard_plans%rowtype;
  forecast_run public.analytics_runs%rowtype;
  executor_key public.forecast_executor_keys%rowtype;
  prospective_run public.prospective_forecast_runs%rowtype;
  prediction public.card_forecast_predictions%rowtype;
  quote public.prospective_acquisition_cost_quotes%rowtype;
  candidate jsonb;
  baseline_prices jsonb;
  core_candidates jsonb;
  output_hash text;
  current_input_hash text;
  expected_signature text;
  supplied_signature text;
  signature_message text;
  started_text text;
  completed_text text;
  execution_started_at timestamptz;
  execution_completed_at timestamptz;
  prospective_run_id uuid;
  receipt_id uuid := gen_random_uuid();
  generated_receipt_hash text;
  generated_output_hash text;
  stored_output_hash text;
  matched_count bigint;
  quarantined_count bigint;
  probability_net_positive numeric;
  structural_lower_price numeric;
  selection_reasons text[];
  selected boolean;
begin
  if requested_execution is null
     or not (requested_execution ?& array[
       'challengeId','executionStartedAt','executionCompletedAt','signature'
     ])
     or requested_execution - array[
       'challengeId','executionStartedAt','executionCompletedAt','signature'
     ] <> '{}'::jsonb then
    raise exception 'Execution receipt accepts only challenge, signed execution times, and signature';
  end if;
  if jsonb_typeof(requested_candidates) <> 'array'
     or jsonb_array_length(requested_candidates) = 0
     or jsonb_array_length(requested_candidates) > 10000 then
    raise exception 'Challenged forecast outputs must be a bounded non-empty array';
  end if;

  select * into challenge from public.forecast_execution_challenges
  where id = (requested_execution->>'challengeId')::uuid
  for update;
  select * into plan from public.prospective_scorecard_plans
  where id = challenge.scorecard_plan_id;
  select * into forecast_run from public.analytics_runs
  where id = challenge.forecast_analytics_run_id
  for update;
  select * into executor_key from public.forecast_executor_keys
  where id = challenge.executor_key_id;
  database_received_at := clock_timestamp();

  if challenge.id is null
     or database_received_at > challenge.expires_at
     or exists (
       select 1 from public.forecast_execution_receipts receipt
       where receipt.challenge_id = challenge.id
     ) then
    raise exception 'Execution challenge is absent, expired, or already consumed';
  end if;
  if forecast_run.id is null
     or forecast_run.status <> 'running'
     or forecast_run.completed_at is not null
     or forecast_run.dataset_hash is not null
     or forecast_run.records_written <> 0
     or forecast_run.records_quarantined <> 0
     or exists (
       select 1 from public.card_forecast_predictions existing
       where existing.analytics_run_id = forecast_run.id
     ) then
    raise exception 'Execution receipt requires the original still-output-free forecast run';
  end if;
  if executor_key.id is null
     or executor_key.id <> plan.executor_key_id
     or executor_key.model_artifact_hash <> challenge.model_artifact_hash
     or database_received_at < executor_key.valid_from
     or database_received_at > executor_key.valid_until then
    raise exception 'Execution receipt executor key is invalid or does not match the model artifact';
  end if;

  if exists (
    select 1 from jsonb_array_elements(requested_candidates) item
    where jsonb_typeof(item) <> 'object'
       or not (item ?& array[
         'trendSnapshotId','marketSeriesIdentityHash',
         'q10','q25','q50','q75','q90','probabilityUp','confidence',
         'predictionStatus','reasonCodes','costQuote','costQuoteHash','baselinePrices',
         'probabilityNetPositive','structuralLowerPrice'
       ])
       or item - array[
         'trendSnapshotId','marketSeriesIdentityHash',
         'q10','q25','q50','q75','q90','probabilityUp','confidence',
         'predictionStatus','reasonCodes','costQuote','costQuoteHash','baselinePrices',
         'probabilityNetPositive','structuralLowerPrice'
       ] <> '{}'::jsonb
       or item->>'marketSeriesIdentityHash' !~ '^[0-9a-f]{64}$'
       or item->>'costQuoteHash' !~ '^[0-9a-f]{64}$'
       or item->>'costQuoteHash' is distinct from
            public.canonical_prospective_cost_quote_hash(item->'costQuote')
       or jsonb_typeof(item->'q10') <> 'string'
       or item->>'q10' !~ '^[0-9]+(?:[.][0-9]+)?$'
       or (item->>'q10')::numeric <>
            (item->>'q10')::numeric(16,4)
       or jsonb_typeof(item->'q25') <> 'string'
       or item->>'q25' !~ '^[0-9]+(?:[.][0-9]+)?$'
       or (item->>'q25')::numeric <>
            (item->>'q25')::numeric(16,4)
       or jsonb_typeof(item->'q50') <> 'string'
       or item->>'q50' !~ '^[0-9]+(?:[.][0-9]+)?$'
       or (item->>'q50')::numeric <>
            (item->>'q50')::numeric(16,4)
       or jsonb_typeof(item->'q75') <> 'string'
       or item->>'q75' !~ '^[0-9]+(?:[.][0-9]+)?$'
       or (item->>'q75')::numeric <>
            (item->>'q75')::numeric(16,4)
       or jsonb_typeof(item->'q90') <> 'string'
       or item->>'q90' !~ '^[0-9]+(?:[.][0-9]+)?$'
       or (item->>'q90')::numeric <>
            (item->>'q90')::numeric(16,4)
       or jsonb_typeof(item->'probabilityUp') <> 'string'
       or item->>'probabilityUp' !~ '^[0-9]+(?:[.][0-9]+)?$'
       or (item->>'probabilityUp')::numeric <>
            (item->>'probabilityUp')::numeric(7,6)
       or jsonb_typeof(item->'confidence') <> 'string'
       or item->>'confidence' !~ '^[0-9]+(?:[.][0-9]+)?$'
       or (item->>'confidence')::numeric <>
            (item->>'confidence')::numeric(7,4)
       or jsonb_typeof(item->'reasonCodes') <> 'array'
       or not (
         item->'reasonCodes' ?& array[
           'operator_model_review_required',
           'private_prospective_shadow',
           'public_forecast_disabled'
         ]
       )
       or jsonb_array_length(item->'reasonCodes') <> (
         select count(distinct code)
         from jsonb_array_elements_text(item->'reasonCodes') reason(code)
       )
       or jsonb_typeof(item->'baselinePrices') <> 'object'
       or not (item->'baselinePrices' ?& array[
         'no_change','damped_momentum','market_index','lifecycle_cohort',
         'structural_convergence'
       ])
       or (item->'baselinePrices') - array[
         'no_change','damped_momentum','market_index','lifecycle_cohort',
         'structural_convergence'
       ] <> '{}'::jsonb
       or exists (
         select 1
         from jsonb_each(item->'baselinePrices') baseline(name, value)
         where jsonb_typeof(value) <> 'string'
            or trim(both '"' from value::text) !~ '^[0-9]+(?:[.][0-9]+)?$'
            or trim(both '"' from value::text)::numeric <>
                 trim(both '"' from value::text)::numeric(16,4)
            or trim(both '"' from value::text)::numeric <= 0
       )
       or jsonb_typeof(item->'probabilityNetPositive') not in ('string','null')
       or (
         jsonb_typeof(item->'probabilityNetPositive') = 'string'
         and (
           item->>'probabilityNetPositive' !~ '^[0-9]+(?:[.][0-9]+)?$'
           or (item->>'probabilityNetPositive')::numeric <>
                (item->>'probabilityNetPositive')::numeric(7,6)
           or (item->>'probabilityNetPositive')::numeric not between 0 and 1
         )
       )
       or jsonb_typeof(item->'structuralLowerPrice') not in ('string','null')
       or (
         jsonb_typeof(item->'structuralLowerPrice') = 'string'
         and (
           item->>'structuralLowerPrice' !~ '^[0-9]+(?:[.][0-9]+)?$'
           or (item->>'structuralLowerPrice')::numeric <>
                (item->>'structuralLowerPrice')::numeric(16,4)
           or (item->>'structuralLowerPrice')::numeric <= 0
         )
       )
       or (
         item->'costQuote'->>'status' = 'complete'
         and (
           jsonb_typeof(item->'costQuote'->'observedAt') <> 'string'
           or jsonb_typeof(item->'costQuote'->'evidenceHash') <> 'string'
           or jsonb_typeof(item->'costQuote'->'offerPrice') <> 'string'
           or jsonb_typeof(item->'costQuote'->'taxRate') <> 'string'
           or jsonb_typeof(item->'costQuote'->'buyShipping') <> 'string'
           or jsonb_typeof(item->'costQuote'->'sellFeeRate') <> 'string'
           or jsonb_typeof(item->'costQuote'->'sellFeeFixed') <> 'string'
           or jsonb_typeof(item->'costQuote'->'sellShipping') <> 'string'
           or jsonb_typeof(item->'costQuote'->'liquidityStatus') <> 'string'
           or jsonb_typeof(item->'costQuote'->'liquidityHaircutRate')
                not in ('string','null')
           or jsonb_typeof(item->'costQuote'->'liquidityEvidenceHash')
                not in ('string','null')
           or item->'costQuote'->>'offerPrice'
                !~ '^[0-9]+(?:[.][0-9]+)?$'
           or item->'costQuote'->>'taxRate'
                !~ '^[0-9]+(?:[.][0-9]+)?$'
           or item->'costQuote'->>'buyShipping'
                !~ '^[0-9]+(?:[.][0-9]+)?$'
           or item->'costQuote'->>'sellFeeRate'
                !~ '^[0-9]+(?:[.][0-9]+)?$'
           or item->'costQuote'->>'sellFeeFixed'
                !~ '^[0-9]+(?:[.][0-9]+)?$'
           or item->'costQuote'->>'sellShipping'
                !~ '^[0-9]+(?:[.][0-9]+)?$'
           or (item->'costQuote'->>'offerPrice')::numeric <>
                (item->'costQuote'->>'offerPrice')::numeric(16,4)
           or (item->'costQuote'->>'taxRate')::numeric <>
                (item->'costQuote'->>'taxRate')::numeric(9,8)
           or (item->'costQuote'->>'buyShipping')::numeric <>
                (item->'costQuote'->>'buyShipping')::numeric(16,4)
           or (item->'costQuote'->>'sellFeeRate')::numeric <>
                (item->'costQuote'->>'sellFeeRate')::numeric(9,8)
           or (item->'costQuote'->>'sellFeeFixed')::numeric <>
                (item->'costQuote'->>'sellFeeFixed')::numeric(16,4)
           or (item->'costQuote'->>'sellShipping')::numeric <>
                (item->'costQuote'->>'sellShipping')::numeric(16,4)
           or (
             jsonb_typeof(item->'costQuote'->'liquidityHaircutRate') = 'string'
             and (
               item->'costQuote'->>'liquidityHaircutRate'
                    !~ '^[0-9]+(?:[.][0-9]+)?$'
               or (item->'costQuote'->>'liquidityHaircutRate')::numeric <>
                    (item->'costQuote'->>'liquidityHaircutRate')::numeric(9,8)
             )
           )
         )
       )
  ) then
    raise exception 'Challenged outputs contain malformed, ambiguous, or unsupported fields';
  end if;
  if (
    select count(distinct item->>'trendSnapshotId')
    from jsonb_array_elements(requested_candidates) item
  ) <> jsonb_array_length(requested_candidates) then
    raise exception 'Challenged output contains duplicate trend snapshots';
  end if;
  select count(*) into matched_count
  from jsonb_array_elements(requested_candidates) item
  join public.trend_feature_snapshots snapshot
    on snapshot.id = (item->>'trendSnapshotId')::uuid
  join public.market_series series on series.id = snapshot.market_series_id
  where snapshot.analytics_run_id = challenge.trend_analytics_run_id
    and item->>'marketSeriesIdentityHash' = series.identity_hash;
  if matched_count <> challenge.expected_input_count
     or matched_count <> jsonb_array_length(requested_candidates) then
    raise exception 'Challenged output does not cover the exact signed input universe';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(requested_candidates) item
    join public.trend_feature_snapshots snapshot
      on snapshot.id = (item->>'trendSnapshotId')::uuid
    join public.source_terms_reviews terms
      on terms.id = snapshot.terms_review_id
     and terms.source_id = snapshot.source_id
    where snapshot.feature_cutoff > challenge.issued_at
       or snapshot.feature_cutoff < challenge.issued_at
            - (plan.selection_policy->>'maximumFeatureAgeHours')::numeric
              * interval '1 hour'
       or snapshot.created_at > challenge.issued_at
       or terms.reviewed_at > challenge.issued_at
       or terms.created_at > challenge.issued_at
       or terms.decision not in ('research_only','approved')
       or not terms.commercial_use_allowed
       or not terms.private_forecast_modeling_allowed
       or not terms.prospective_capture_allowed
       or not terms.exact_condition_labels_allowed
       or not terms.retention_through_maturity_allowed
       or not terms.predictive_derivatives_allowed
       or (terms.expires_at is not null and terms.expires_at
            <= challenge.issued_at + make_interval(days => challenge.horizon_days))
  ) then
    raise exception 'Challenged source evidence was not eligible at the database-issued origin';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(requested_candidates) item
    left join public.source_terms_reviews quote_terms
      on quote_terms.id = (item->'costQuote'->>'termsReviewId')::uuid
    left join public.data_sources quote_source
      on quote_source.id = quote_terms.source_id
    where item->'costQuote'->>'status' = 'complete'
      and (
        (item->'costQuote'->>'observedAt')::timestamptz > challenge.issued_at
        or (item->'costQuote'->>'observedAt')::timestamptz
             < challenge.issued_at
               - (plan.selection_policy->>'maximumQuoteAgeHours')::numeric
                 * interval '1 hour'
        or (
          item->'costQuote'->>'semantics' = 'provider_listing'
          and (
            quote_terms.id is null
            or quote_source.id is null
            or not quote_source.active
            or quote_source.current_terms_review_id <> quote_terms.id
            or quote_terms.reviewed_at > challenge.issued_at
            or quote_terms.created_at > challenge.issued_at
            or quote_terms.decision not in ('research_only','approved')
            or not quote_terms.commercial_use_allowed
            or not quote_terms.private_forecast_modeling_allowed
            or not quote_terms.prospective_capture_allowed
            or not quote_terms.exact_condition_labels_allowed
            or not quote_terms.retention_through_maturity_allowed
            or not quote_terms.predictive_derivatives_allowed
            or (
              item->'costQuote'->>'liquidityStatus' = 'source_backed'
              and not quote_terms.liquidity_derivation_allowed
            )
            or (quote_terms.expires_at is not null and quote_terms.expires_at
                 <= challenge.issued_at
                   + make_interval(days => challenge.horizon_days))
          )
        )
      )
  ) then
    raise exception 'Challenged cost evidence was stale or unauthorized at the database-issued origin';
  end if;

  output_hash := public.canonical_prospective_candidate_output_hash(
    requested_candidates
  );
  if output_hash is null then
    raise exception 'Challenged output hash could not be derived';
  end if;
  current_input_hash := public.canonical_forecast_execution_input_hash(
    challenge.trend_analytics_run_id
  );
  if current_input_hash is distinct from challenge.expected_input_hash then
    raise exception 'Execution input changed after challenge issuance';
  end if;

  execution_started_at := (requested_execution->>'executionStartedAt')::timestamptz;
  execution_completed_at := (requested_execution->>'executionCompletedAt')::timestamptz;
  started_text := to_char(
    execution_started_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  completed_text := to_char(
    execution_completed_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  if execution_started_at < challenge.issued_at
     or execution_started_at > execution_completed_at
     or execution_completed_at > challenge.expires_at
     or execution_completed_at > database_received_at then
    raise exception 'Signed executor timing falls outside the database challenge window';
  end if;
  signature_message := concat_ws('|',
    challenge.challenge_hash, encode(challenge.nonce, 'hex'),
    challenge.expected_input_hash, output_hash,
    challenge.expected_input_count::text, challenge.model_artifact_hash,
    executor_key.executor_build_hash, executor_key.runtime_hash,
    started_text, completed_text
  );
  expected_signature := encode(hmac(
    convert_to(signature_message, 'UTF8'), executor_key.hmac_secret, 'sha256'
  ), 'hex');
  supplied_signature := lower(requested_execution->>'signature');
  if supplied_signature !~ '^[0-9a-f]{64}$'
     or supplied_signature <> expected_signature then
    raise exception 'Execution receipt signature was not produced by the independent executor key';
  end if;

  select jsonb_agg(
    item - array[
      'marketSeriesIdentityHash','baselinePrices',
      'costQuoteHash','probabilityNetPositive','structuralLowerPrice'
    ] order by ordinal
  ) into core_candidates
  from jsonb_array_elements(requested_candidates)
    with ordinality supplied(item, ordinal);
  select count(*) into quarantined_count
  from jsonb_array_elements(requested_candidates) item
  where item->>'predictionStatus' = 'quarantined';

  if exists (
    select 1 from public.card_forecast_predictions existing
    where existing.analytics_run_id = challenge.forecast_analytics_run_id
  ) then
    raise exception 'Challenged forecast run gained an unsigned prediction before finalization';
  end if;

  update public.analytics_runs
  set status = 'succeeded', completed_at = database_received_at,
      dataset_hash = output_hash,
      records_read = challenge.expected_input_count,
      records_written = challenge.expected_input_count,
      records_quarantined = quarantined_count,
      error_summary = null
  where id = challenge.forecast_analytics_run_id;

  perform set_config(
    'collectfolio.challenged_forecast_execution', challenge.id::text, true
  );
  perform set_config(
    'collectfolio.challenged_output_hash', output_hash, true
  );
  prospective_run_id := public.record_prospective_forecast_run(
    jsonb_build_object(
      'analyticsRunId', challenge.forecast_analytics_run_id,
      'trendAnalyticsRunId', challenge.trend_analytics_run_id,
      'modelVersionId', challenge.model_version_id,
      'horizonDays', challenge.horizon_days,
      'purpose', plan.universe_purpose,
      'selectionPolicy', plan.selection_policy
    ),
    core_candidates
  );

  select * into prospective_run from public.prospective_forecast_runs
  where id = prospective_run_id;
  if prospective_run.id is null
     or prospective_run.execution_challenge_id <> challenge.id
     or prospective_run.origin <> challenge.issued_at
     or prospective_run.forecast_dataset_hash <> output_hash
     or prospective_run.analytics_run_id <> challenge.forecast_analytics_run_id
     or prospective_run.model_version_id <> challenge.model_version_id
     or prospective_run.horizon_days <> challenge.horizon_days then
    raise exception 'Recorded prospective run does not reproduce its challenged execution lineage';
  end if;

  generated_receipt_hash := encode(digest(concat_ws('|',
    receipt_id::text, challenge.id::text, challenge.challenge_hash,
    prospective_run.id::text, prospective_run.run_hash,
    challenge.forecast_analytics_run_id::text, executor_key.id::text,
    challenge.expected_input_hash, challenge.expected_input_count::text,
    output_hash, prospective_run.submission_hash,
    executor_key.executor_build_hash, executor_key.runtime_hash,
    started_text, completed_text, database_received_at::text,
    supplied_signature, 'hmac_executor_principal_v1', 'false'
  ), 'sha256'), 'hex');
  insert into public.forecast_execution_receipts (
    id, challenge_id, prospective_run_id, forecast_analytics_run_id,
    executor_key_id, challenge_hash, expected_input_hash, output_count,
    canonical_output_hash, forecast_dataset_hash, core_submission_hash,
    executor_build_hash, runtime_hash, execution_started_at,
    execution_completed_at, received_at, executor_signature,
    attestation_level, artifact_execution_verified, receipt_hash, created_at
  ) values (
    receipt_id, challenge.id, prospective_run.id,
    challenge.forecast_analytics_run_id, executor_key.id,
    challenge.challenge_hash, challenge.expected_input_hash,
    challenge.expected_input_count, output_hash, output_hash,
    prospective_run.submission_hash, executor_key.executor_build_hash,
    executor_key.runtime_hash, execution_started_at, execution_completed_at,
    database_received_at, supplied_signature, 'hmac_executor_principal_v1',
    false, generated_receipt_hash, database_received_at
  );

  for candidate in
    select item
    from jsonb_array_elements(requested_candidates) item
    join public.trend_feature_snapshots snapshot
      on snapshot.id = (item->>'trendSnapshotId')::uuid
    join public.market_series series on series.id = snapshot.market_series_id
    order by series.identity_hash, snapshot.id
  loop
    select prediction_row.* into prediction
    from public.card_forecast_predictions prediction_row
    where prediction_row.prospective_run_id = prospective_run.id
      and prediction_row.trend_snapshot_id = (candidate->>'trendSnapshotId')::uuid;
    select quote_row.* into quote
    from public.prospective_acquisition_cost_quotes quote_row
    where quote_row.prospective_run_id = prospective_run.id
      and quote_row.candidate_member_id = prediction.prospective_candidate_member_id;
    if prediction.id is null or quote.id is null then
      raise exception 'Receipt output cannot be joined to its atomic prediction and cost state';
    end if;

    baseline_prices := jsonb_build_object(
      'no_change', (candidate->'baselinePrices'->>'no_change')::numeric(16,4),
      'damped_momentum', (candidate->'baselinePrices'->>'damped_momentum')::numeric(16,4),
      'market_index', (candidate->'baselinePrices'->>'market_index')::numeric(16,4),
      'lifecycle_cohort', (candidate->'baselinePrices'->>'lifecycle_cohort')::numeric(16,4),
      'structural_convergence', (candidate->'baselinePrices'->>'structural_convergence')::numeric(16,4)
    );
    if (baseline_prices->>'no_change')::numeric <> prediction.current_price then
      raise exception 'No-change baseline must equal the immutable origin price';
    end if;
    probability_net_positive := case
      when jsonb_typeof(candidate->'probabilityNetPositive') = 'null' then null
      else (candidate->>'probabilityNetPositive')::numeric
    end;
    structural_lower_price := case
      when jsonb_typeof(candidate->'structuralLowerPrice') = 'null' then null
      else (candidate->>'structuralLowerPrice')::numeric
    end;

    selection_reasons := array[]::text[];
    if plan.universe_purpose <> 'after_cost_opportunity' then
      selection_reasons := array_append(
        selection_reasons, 'not_after_cost_opportunity_scope'
      );
    else
      if quote.quote_status <> 'complete'
         or quote.quote_semantics <> 'provider_listing'
         or quote.liquidity_status <> 'source_backed'
         or quote.liquidity_adjusted_break_even_reference is null then
        selection_reasons := array_append(
          selection_reasons, 'complete_provider_liquidity_evidence_missing'
        );
      end if;
      if prediction.prediction_status <> 'research_only' then
        selection_reasons := array_append(
          selection_reasons, 'forecast_not_research_eligible'
        );
      end if;
      if quote.liquidity_adjusted_break_even_reference is null
         or prediction.q25 <= quote.liquidity_adjusted_break_even_reference then
        selection_reasons := array_append(
          selection_reasons, 'conservative_net_return_not_positive'
        );
      end if;
      if probability_net_positive is null then
        selection_reasons := array_append(
          selection_reasons, 'after_cost_probability_uncalibrated'
        );
      elsif probability_net_positive < 0.70 then
        selection_reasons := array_append(
          selection_reasons, 'net_probability_below_threshold'
        );
      end if;
      if structural_lower_price is null then
        selection_reasons := array_append(
          selection_reasons, 'structural_lower_bound_missing'
        );
      elsif quote.all_in_acquisition_cost is null
         or structural_lower_price <= quote.all_in_acquisition_cost then
        selection_reasons := array_append(
          selection_reasons, 'structural_lower_bound_not_above_cost'
        );
      end if;
    end if;
    selected := cardinality(selection_reasons) = 0;
    generated_output_hash := encode(digest(concat_ws('|',
      prediction.id::text, receipt_id::text, prospective_run.id::text,
      baseline_prices::text, coalesce(probability_net_positive::text, ''),
      coalesce(structural_lower_price::text, ''), selected::text,
      array_to_string(selection_reasons, ','), output_hash,
      generated_receipt_hash, database_received_at::text
    ), 'sha256'), 'hex');
    insert into public.prospective_prediction_outputs (
      prediction_id, execution_receipt_id, prospective_run_id,
      baseline_prices, probability_net_positive, structural_lower_price,
      selected_for_pocket, selection_reason_codes, output_hash, created_at
    ) values (
      prediction.id, receipt_id, prospective_run.id, baseline_prices,
      probability_net_positive, structural_lower_price, selected,
      selection_reasons, generated_output_hash, database_received_at
    );
  end loop;

  if (select count(*) from public.prospective_prediction_outputs output
      where output.execution_receipt_id = receipt_id)
       <> challenge.expected_input_count then
    raise exception 'Execution receipt is missing prediction-level baseline or pocket outputs';
  end if;
  stored_output_hash := public.canonical_stored_prospective_output_hash(receipt_id);
  if stored_output_hash is distinct from output_hash then
    raise exception 'Executor-signed output cannot be reconstructed exactly from immutable stored predictions, costs, and outputs';
  end if;
  return jsonb_build_object(
    'prospectiveRunId', prospective_run.id,
    'executionReceiptId', receipt_id,
    'challengeId', challenge.id,
    'origin', challenge.issued_at,
    'canonicalOutputHash', output_hash,
    'receiptHash', generated_receipt_hash,
    'attestationLevel', 'hmac_executor_principal_v1',
    'artifactExecutionVerified', false,
    'publicPublicationAllowed', false
  );
end;
$$;
-- A prospective scorecard points directly at the plan that existed before its
-- first challenge. Retrospective scorecards keep their existing null lineage.
alter table public.model_scorecards disable trigger model_scorecards_append_only;
alter table public.model_scorecards
  add column prospective_scorecard_plan_id uuid
    references public.prospective_scorecard_plans(id) on delete restrict,
  drop constraint model_scorecards_evidence_mode_check,
  add constraint model_scorecards_evidence_mode_check check (
    (
      evidence_mode = 'retrospective'
      and prospective_scorecard_plan_id is null
    )
    or (
      evidence_mode = 'prospective'
      and prospective_scorecard_plan_id is not null
    )
  );
alter table public.model_scorecards enable trigger model_scorecards_append_only;

create unique index model_scorecards_prospective_plan_unique
  on public.model_scorecards (prospective_scorecard_plan_id)
  where prospective_scorecard_plan_id is not null;

create table public.prospective_scorecard_run_memberships (
  scorecard_id uuid not null references public.model_scorecards(id) on delete restrict,
  scorecard_plan_id uuid not null
    references public.prospective_scorecard_plans(id) on delete restrict,
  prospective_run_id uuid not null
    references public.prospective_forecast_runs(id) on delete restrict,
  execution_receipt_id uuid not null
    references public.forecast_execution_receipts(id) on delete restrict,
  candidate_universe_id uuid not null
    references public.prospective_candidate_universes(id) on delete restrict,
  created_at timestamptz not null,
  primary key (scorecard_id, prospective_run_id),
  unique (scorecard_id, execution_receipt_id),
  unique (scorecard_id, candidate_universe_id)
);

create or replace function public.validate_prospective_scorecard_creation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  expected_owner name;
  plan public.prospective_scorecard_plans%rowtype;
begin
  if new.evidence_mode = 'retrospective' then
    if new.prospective_scorecard_plan_id is not null then
      raise exception 'Retrospective scorecard cannot claim a prospective plan';
    end if;
    return new;
  end if;
  select pg_get_userbyid(proowner) into expected_owner
  from pg_proc where oid = 'public.create_prospective_model_scorecard(jsonb)'::regprocedure;
  if current_user <> expected_owner
     or current_setting('collectfolio.deriving_prospective_scorecard', true)
          is distinct from new.prospective_scorecard_plan_id::text then
    raise exception 'Prospective scorecards must be authored by the guarded database derivation RPC';
  end if;
  select * into plan from public.prospective_scorecard_plans
  where id = new.prospective_scorecard_plan_id;
  if plan.id is null
     or new.model_version_id <> plan.model_version_id
     or new.horizon_days <> plan.horizon_days
     or new.cohort_key <> plan.cohort_key
     or new.origin_start <> plan.origin_start
     or new.origin_end <> plan.origin_end
     or new.promotion_policy is distinct from plan.promotion_policy
     or new.promotion_policy_hash <> plan.promotion_policy_hash then
    raise exception 'Prospective scorecard does not reproduce its preregistered plan';
  end if;
  return new;
end;
$$;

create trigger model_scorecards_validate_prospective_creation
  before insert on public.model_scorecards
  for each row execute function public.validate_prospective_scorecard_creation();

-- Retain every retrospective membership rule from 0016. Prospective rows add
-- an unspoofable security-definer-owner check and exact plan/receipt/output
-- lineage; a custom GUC alone is never authority.
create or replace function public.validate_scorecard_evaluation_membership()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  stored_status text;
  evaluation_mode text;
  prediction_horizon integer;
  prediction_model uuid;
  prediction_status text;
  prediction_origin timestamptz;
  prediction_series uuid;
  prediction_run uuid;
  prediction_universe uuid;
  stored_prediction_id uuid;
  evaluation_run uuid;
  scorecard_horizon integer;
  scorecard_model uuid;
  scorecard_run uuid;
  scorecard_mode text;
  scorecard_plan uuid;
  scorecard_origin_start timestamptz;
  scorecard_origin_end timestamptz;
  expected_reason_codes text[];
  target_membership_count bigint;
  stored_observation_count integer;
  expected_owner name;
begin
  if exists (
    select 1 from public.model_promotion_reviews
    where scorecard_id = new.scorecard_id
  ) then
    raise exception 'Scorecard membership is frozen after its first review';
  end if;
  select evaluation.evaluation_status, evaluation.evidence_mode,
         evaluation.analytics_run_id, evaluation.observation_count,
         prediction.id, prediction.horizon_days, prediction.model_version_id,
         prediction.prediction_status, prediction.origin,
         prediction.market_series_id, prediction.prospective_run_id,
         prediction.candidate_universe_id
    into stored_status, evaluation_mode, evaluation_run,
         stored_observation_count, stored_prediction_id, prediction_horizon,
         prediction_model, prediction_status, prediction_origin,
         prediction_series, prediction_run, prediction_universe
  from public.forecast_evaluations evaluation
  join public.card_forecast_predictions prediction
    on prediction.id = evaluation.prediction_id
  where evaluation.id = new.evaluation_id;
  select horizon_days, model_version_id, analytics_run_id, evidence_mode,
         prospective_scorecard_plan_id, origin_start, origin_end
    into scorecard_horizon, scorecard_model, scorecard_run, scorecard_mode,
         scorecard_plan, scorecard_origin_start, scorecard_origin_end
  from public.model_scorecards where id = new.scorecard_id;

  if stored_status is null or scorecard_horizon is null
     or stored_status <> new.evaluation_status
     or evaluation_mode <> scorecard_mode
     or prediction_horizon <> scorecard_horizon
     or prediction_model <> scorecard_model
     or evaluation_run <> scorecard_run
     or prediction_origin not between scorecard_origin_start and scorecard_origin_end then
    raise exception 'Scorecard evaluation membership lineage is inconsistent';
  end if;
  if scorecard_mode = 'prospective' then
    select pg_get_userbyid(proowner) into expected_owner
    from pg_proc where oid = 'public.create_prospective_model_scorecard(jsonb)'::regprocedure;
    if current_user <> expected_owner
       or current_setting('collectfolio.deriving_prospective_scorecard', true)
            is distinct from scorecard_plan::text then
      raise exception 'Prospective membership must be database-derived atomically';
    end if;
    if prediction_series is null
       or prediction_run is null
       or prediction_universe is null
       or not exists (
         select 1
         from public.forecast_execution_challenges challenge
         join public.forecast_execution_receipts receipt
           on receipt.challenge_id = challenge.id
          and receipt.prospective_run_id = prediction_run
         join public.prospective_prediction_outputs output
           on output.execution_receipt_id = receipt.id
          and output.prediction_id = stored_prediction_id
         where challenge.scorecard_plan_id = scorecard_plan
           and challenge.issued_at between scorecard_origin_start and scorecard_origin_end
       ) then
      raise exception 'Prospective membership lacks exact plan, receipt, or output lineage';
    end if;
  elsif scorecard_plan is not null then
    raise exception 'Retrospective membership cannot claim a prospective plan';
  end if;

  if stored_status = 'scored' and prediction_series is not null then
    select count(*) into target_membership_count
    from public.forecast_evaluation_observations
    where evaluation_id = new.evaluation_id;
    if target_membership_count = 0
       or target_membership_count <> stored_observation_count then
      raise exception 'Scored evaluation target membership is incomplete';
    end if;
  end if;
  if new.included_in_metrics
     and (stored_status <> 'scored' or prediction_status <> 'research_only') then
    raise exception 'Only scored eligible research predictions enter scorecard metrics';
  end if;
  if new.included_in_metrics and cardinality(new.reason_codes) <> 0 then
    raise exception 'Included scorecard membership cannot carry exclusion reasons';
  end if;
  if not new.included_in_metrics
     and prediction_status = 'research_only' and stored_status = 'scored' then
    raise exception 'Eligible scored evaluation must enter scorecard metrics';
  end if;
  expected_reason_codes := case
    when prediction_status = 'quarantined'
      then array['quarantined_prediction_excluded']
    when stored_status = 'unscorable'
      then array['unscorable_target_excluded']
    else array[]::text[]
  end;
  if not new.included_in_metrics
     and new.reason_codes <> expected_reason_codes then
    raise exception 'Excluded scorecard membership reason is inconsistent';
  end if;
  return new;
end;
$$;

create or replace function public.create_prospective_model_scorecard(
  requested_scorecard jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  database_created_at timestamptz;
  generated_scorecard_id uuid := gen_random_uuid();
  plan public.prospective_scorecard_plans%rowtype;
  evaluation_run public.analytics_runs%rowtype;
  model public.model_versions%rowtype;
  challenge_count bigint;
  receipt_count bigint;
  expected_case_count bigint;
  evidence_case_count bigint;
  evaluation_count integer;
  matured_count integer;
  unscorable_count integer;
  excluded_count integer;
  membership_hash text;
  mae_log_return numeric;
  median_absolute_percentage_error numeric;
  symmetric_mape numeric;
  median_absolute_dollar_error numeric;
  direction_accuracy numeric;
  direction_accuracy_10 numeric;
  direction_accuracy_25 numeric;
  brier_score numeric;
  probability_calibration_error numeric;
  interval_50_coverage numeric;
  interval_80_coverage numeric;
  interval_50_width numeric;
  interval_80_width numeric;
  pinball_loss jsonb;
  no_change_error numeric;
  damped_momentum_error numeric;
  market_index_error numeric;
  lifecycle_cohort_error numeric;
  structural_convergence_error numeric;
  no_change_lift numeric;
  damped_momentum_lift numeric;
  market_index_lift numeric;
  lifecycle_cohort_lift numeric;
  structural_convergence_lift numeric;
  baseline_results jsonb;
  baseline_lift_lower_95 jsonb;
  missing_baselines text[];
  below_threshold_baselines text[];
  strongest_challenger_name text;
  strongest_challenger_lift numeric;
  variant_count integer;
  set_count integer;
  origin_count integer;
  spaced_origin_count integer := 0;
  origin_value timestamptz;
  last_spaced_origin timestamptz;
  after_cost_case_count integer;
  after_cost_brier numeric;
  after_cost_calibration numeric;
  selected_count integer;
  selected_positive_rate numeric;
  selected_median_net_roi numeric;
  selected_false_discovery_rate numeric;
  selected_mean_conservative_error numeric;
  reason_codes text[] := array[]::text[];
  recommendation text;
  metrics jsonb;
  generated_scorecard_hash text;
begin
  if requested_scorecard is null
     or not (requested_scorecard ?& array[
       'scorecardPlanId','evaluationAnalyticsRunId'
     ])
     or requested_scorecard - array[
       'scorecardPlanId','evaluationAnalyticsRunId'
     ] <> '{}'::jsonb then
    raise exception 'Prospective scorecard accepts only its preregistered plan and evaluation-run identifiers';
  end if;

  select * into plan from public.prospective_scorecard_plans
  where id = (requested_scorecard->>'scorecardPlanId')::uuid
  for update;
  select * into evaluation_run from public.analytics_runs
  where id = (requested_scorecard->>'evaluationAnalyticsRunId')::uuid
  for update;
  database_created_at := clock_timestamp();
  select * into model from public.model_versions
  where id = plan.model_version_id;
  if plan.id is null
     or model.id is null
     or database_created_at < plan.origin_end
          + make_interval(days => plan.horizon_days) then
    raise exception 'Prospective scorecard plan is absent or its full origin window has not matured';
  end if;
  if exists (
    select 1 from public.model_scorecards scorecard
    where scorecard.prospective_scorecard_plan_id = plan.id
  ) then
    raise exception 'Prospective scorecard plan has already been consumed';
  end if;
  if evaluation_run.id is null
     or evaluation_run.run_kind <> 'forecast_evaluation'
     or evaluation_run.status <> 'succeeded'
     or evaluation_run.completed_at is null
     or evaluation_run.completed_at > database_created_at
     or evaluation_run.feature_cutoff is distinct from evaluation_run.completed_at
     or evaluation_run.config->>'prospectiveScorecardPlanId'
          is distinct from plan.id::text
     or evaluation_run.feature_version <> model.feature_version
     or evaluation_run.mapping_version <> model.mapping_version
     or evaluation_run.code_version <> model.code_version then
    raise exception 'Prospective scorecard requires its dedicated succeeded point-in-time evaluation run';
  end if;

  select count(*), coalesce(sum(challenge.expected_input_count), 0)
    into challenge_count, expected_case_count
  from public.forecast_execution_challenges challenge
  where challenge.scorecard_plan_id = plan.id;
  select count(*) into receipt_count
  from public.forecast_execution_challenges challenge
  join public.forecast_execution_receipts receipt
    on receipt.challenge_id = challenge.id
  where challenge.scorecard_plan_id = plan.id;
  if challenge_count <> cardinality(plan.origin_schedule)
     or receipt_count <> challenge_count
     or exists (
       select 1
       from public.forecast_execution_challenges challenge
       where challenge.scorecard_plan_id = plan.id
         and (
           challenge.issued_at not between plan.origin_start and plan.origin_end
           or challenge.origin_slot_index > cardinality(plan.origin_schedule)
           or challenge.issued_at < plan.origin_schedule[challenge.origin_slot_index]
           or challenge.issued_at >=
                plan.origin_schedule[challenge.origin_slot_index] + interval '24 hours'
           or challenge.model_version_id <> plan.model_version_id
           or challenge.horizon_days <> plan.horizon_days
           or challenge.selection_policy_hash <> plan.selection_policy_hash
         )
     ) then
    raise exception 'Prospective scorecard requires every preregistered challenge to have one valid receipt';
  end if;
  if exists (
    select 1
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    where challenge.scorecard_plan_id = plan.id
      and (
        receipt.output_count <> challenge.expected_input_count
        or receipt.expected_input_hash <> challenge.expected_input_hash
        or receipt.canonical_output_hash <> receipt.forecast_dataset_hash
        or receipt.canonical_output_hash is distinct from
             public.canonical_stored_prospective_output_hash(receipt.id)
        or receipt.artifact_execution_verified
        or receipt.attestation_level <> 'hmac_executor_principal_v1'
      )
  ) then
    raise exception 'Prospective scorecard receipt hashes, counts, or attestation semantics are inconsistent';
  end if;

  select count(*) into evidence_case_count
  from public.forecast_execution_challenges challenge
  join public.forecast_execution_receipts receipt
    on receipt.challenge_id = challenge.id
  join public.prospective_forecast_runs prospective_run
    on prospective_run.id = receipt.prospective_run_id
   and prospective_run.execution_challenge_id = challenge.id
  join public.prospective_candidate_universes universe
    on universe.prospective_run_id = prospective_run.id
  join public.prospective_candidate_universe_members member
    on member.prospective_run_id = prospective_run.id
   and member.candidate_universe_id = universe.id
  join public.card_forecast_predictions prediction
    on prediction.prospective_candidate_member_id = member.id
   and prediction.prospective_run_id = prospective_run.id
   and prediction.candidate_universe_id = universe.id
  join public.prospective_prediction_outputs output
    on output.prediction_id = prediction.id
   and output.execution_receipt_id = receipt.id
   and output.prospective_run_id = prospective_run.id
  join public.prospective_acquisition_cost_quotes quote
    on quote.candidate_member_id = member.id
   and quote.prospective_run_id = prospective_run.id
  join public.forecast_evaluations evaluation
    on evaluation.prediction_id = prediction.id
   and evaluation.analytics_run_id = evaluation_run.id
  where challenge.scorecard_plan_id = plan.id
    and universe.purpose = plan.universe_purpose
    and universe.selection_policy_hash = plan.selection_policy_hash
    and member.source_id = plan.source_id
    and prediction.model_version_id = plan.model_version_id
    and prediction.horizon_days = plan.horizon_days
    and prediction.origin = challenge.issued_at
    and prediction.origin between plan.origin_start and plan.origin_end
    and prediction.evidence_mode = 'prospective'
    and evaluation.evidence_mode = 'prospective';
  if evidence_case_count <> expected_case_count
     or evaluation_run.records_written <> expected_case_count then
    raise exception 'Prospective scorecard expected membership has a missing prediction, output, cost state, or evaluation';
  end if;
  if exists (
    select 1
    from public.forecast_evaluations evaluation
    where evaluation.analytics_run_id = evaluation_run.id
      and not exists (
        select 1
        from public.forecast_execution_challenges challenge
        join public.forecast_execution_receipts receipt
          on receipt.challenge_id = challenge.id
        join public.card_forecast_predictions prediction
          on prediction.prospective_run_id = receipt.prospective_run_id
         and prediction.id = evaluation.prediction_id
        where challenge.scorecard_plan_id = plan.id
      )
  ) then
    raise exception 'Prospective evaluation run contains rows outside the preregistered scorecard plan';
  end if;
  if exists (
    select 1
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    join public.prospective_forecast_runs prospective_run
      on prospective_run.id = receipt.prospective_run_id
    join public.prospective_candidate_universes universe
      on universe.prospective_run_id = prospective_run.id
    join public.prospective_candidate_universe_members member
      on member.prospective_run_id = prospective_run.id
    join public.card_forecast_predictions prediction
      on prediction.prospective_candidate_member_id = member.id
    join public.forecast_evaluations evaluation
      on evaluation.prediction_id = prediction.id
    left join public.forecast_evaluation_observations target
      on target.evaluation_id = evaluation.id
    where challenge.scorecard_plan_id = plan.id
    group by evaluation.id, prediction.id
    having evaluation.analytics_run_id <> evaluation_run.id
       or evaluation.maturity <> prediction.matures_at
       or evaluation.evaluation_status not in ('scored','unscorable')
       or (
         evaluation.evaluation_status = 'scored'
         and count(target.observation_id) <> evaluation.observation_count
       )
       or (
         evaluation.evaluation_status = 'unscorable'
         and count(target.observation_id) <> 0
       )
  ) then
    raise exception 'Prospective scorecard evaluation or immutable target membership is inconsistent';
  end if;

  select
    count(*) filter (
      where prediction.prediction_status = 'research_only'
        and evaluation.evaluation_status = 'scored'
    )::integer,
    count(*)::integer,
    count(*) filter (
      where prediction.prediction_status = 'research_only'
        and evaluation.evaluation_status = 'unscorable'
    )::integer,
    count(*) filter (
      where prediction.prediction_status = 'quarantined'
    )::integer,
    encode(digest(string_agg(concat_ws('|',
      member.market_series_id::text, member.id::text, prediction.id::text,
      prediction.prediction_hash, evaluation.id::text,
      evaluation.evaluation_hash, receipt.id::text, receipt.receipt_hash,
      evaluation.evaluation_status,
      (
        prediction.prediction_status = 'research_only'
        and evaluation.evaluation_status = 'scored'
      )::text,
      case
        when prediction.prediction_status = 'quarantined'
          then 'quarantined_prediction_excluded'
        when evaluation.evaluation_status = 'unscorable'
          then 'unscorable_target_excluded'
        else ''
      end
    ), '||' order by prediction.origin, member.market_series_id, prediction.id),
    'sha256'), 'hex')
    into evaluation_count, matured_count, unscorable_count, excluded_count,
         membership_hash
  from public.forecast_execution_challenges challenge
  join public.forecast_execution_receipts receipt
    on receipt.challenge_id = challenge.id
  join public.prospective_candidate_universe_members member
    on member.prospective_run_id = receipt.prospective_run_id
  join public.card_forecast_predictions prediction
    on prediction.prospective_candidate_member_id = member.id
  join public.forecast_evaluations evaluation
    on evaluation.prediction_id = prediction.id
   and evaluation.analytics_run_id = evaluation_run.id
  where challenge.scorecard_plan_id = plan.id;
  if matured_count <> evaluation_count + unscorable_count + excluded_count
     or membership_hash is null then
    raise exception 'Prospective scorecard case partition or membership hash is incomplete';
  end if;

  select
    avg(abs(ln(prediction.q50 / evaluation.realized_price))),
    percentile_cont(0.5) within group (
      order by abs(prediction.q50 - evaluation.realized_price)
        / evaluation.realized_price
    ),
    avg(2 * abs(prediction.q50 - evaluation.realized_price)
      / (prediction.q50 + evaluation.realized_price)),
    percentile_cont(0.5) within group (
      order by abs(prediction.q50 - evaluation.realized_price)
    ),
    avg(((case
      when prediction.q50 / prediction.current_price - 1 > 0.000000000001 then 1
      when prediction.q50 / prediction.current_price - 1 < -0.000000000001 then -1
      else 0
    end) = (case
      when evaluation.realized_price / prediction.current_price - 1 > 0.000000000001 then 1
      when evaluation.realized_price / prediction.current_price - 1 < -0.000000000001 then -1
      else 0
    end))::integer),
    avg(((case
      when prediction.q50 / prediction.current_price - 1 > 0.000000000001 then 1
      when prediction.q50 / prediction.current_price - 1 < -0.000000000001 then -1
      else 0
    end) = (case
      when evaluation.realized_price / prediction.current_price - 1 > 0.000000000001 then 1
      when evaluation.realized_price / prediction.current_price - 1 < -0.000000000001 then -1
      else 0
    end))::integer)
      filter (where abs(evaluation.realized_price / prediction.current_price - 1) >= 0.10),
    avg(((case
      when prediction.q50 / prediction.current_price - 1 > 0.000000000001 then 1
      when prediction.q50 / prediction.current_price - 1 < -0.000000000001 then -1
      else 0
    end) = (case
      when evaluation.realized_price / prediction.current_price - 1 > 0.000000000001 then 1
      when evaluation.realized_price / prediction.current_price - 1 < -0.000000000001 then -1
      else 0
    end))::integer)
      filter (where abs(evaluation.realized_price / prediction.current_price - 1) >= 0.25),
    avg(power(
      prediction.probability_up
        - (evaluation.realized_price > prediction.current_price)::integer,
      2
    )),
    avg((evaluation.realized_price between prediction.q25 and prediction.q75)::integer),
    avg((evaluation.realized_price between prediction.q10 and prediction.q90)::integer),
    avg(prediction.q75 - prediction.q25),
    avg(prediction.q90 - prediction.q10),
    jsonb_build_object(
      'q10', avg(greatest(
        0.10 * (evaluation.realized_price - prediction.q10),
        -0.90 * (evaluation.realized_price - prediction.q10)
      )),
      'q25', avg(greatest(
        0.25 * (evaluation.realized_price - prediction.q25),
        -0.75 * (evaluation.realized_price - prediction.q25)
      )),
      'q50', avg(greatest(
        0.50 * (evaluation.realized_price - prediction.q50),
        -0.50 * (evaluation.realized_price - prediction.q50)
      )),
      'q75', avg(greatest(
        0.75 * (evaluation.realized_price - prediction.q75),
        -0.25 * (evaluation.realized_price - prediction.q75)
      )),
      'q90', avg(greatest(
        0.90 * (evaluation.realized_price - prediction.q90),
        -0.10 * (evaluation.realized_price - prediction.q90)
      ))
    )
    into mae_log_return, median_absolute_percentage_error, symmetric_mape,
         median_absolute_dollar_error, direction_accuracy,
         direction_accuracy_10, direction_accuracy_25, brier_score,
         interval_50_coverage, interval_80_coverage, interval_50_width,
         interval_80_width, pinball_loss
  from public.forecast_execution_challenges challenge
  join public.forecast_execution_receipts receipt
    on receipt.challenge_id = challenge.id
  join public.card_forecast_predictions prediction
    on prediction.prospective_run_id = receipt.prospective_run_id
  join public.forecast_evaluations evaluation
    on evaluation.prediction_id = prediction.id
   and evaluation.analytics_run_id = evaluation_run.id
  where challenge.scorecard_plan_id = plan.id
    and prediction.prediction_status = 'research_only'
    and evaluation.evaluation_status = 'scored';

  with probability_cases as (
    select prediction.probability_up as probability,
           (evaluation.realized_price > prediction.current_price)::integer as outcome
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    join public.card_forecast_predictions prediction
      on prediction.prospective_run_id = receipt.prospective_run_id
    join public.forecast_evaluations evaluation
      on evaluation.prediction_id = prediction.id
     and evaluation.analytics_run_id = evaluation_run.id
    where challenge.scorecard_plan_id = plan.id
      and prediction.prediction_status = 'research_only'
      and evaluation.evaluation_status = 'scored'
  ), buckets as (
    select least(floor(probability * 10), 9)::integer as bucket,
           count(*) as bucket_count, avg(probability) as mean_probability,
           avg(outcome) as mean_outcome
    from probability_cases group by 1
  )
  select sum(
    bucket_count::numeric / nullif(evaluation_count, 0)
      * abs(mean_probability - mean_outcome)
  ) into probability_calibration_error
  from buckets;

  select
    avg(abs(ln((output.baseline_prices->>'no_change')::numeric
      / evaluation.realized_price))),
    avg(abs(ln((output.baseline_prices->>'damped_momentum')::numeric
      / evaluation.realized_price))),
    avg(abs(ln((output.baseline_prices->>'market_index')::numeric
      / evaluation.realized_price))),
    avg(abs(ln((output.baseline_prices->>'lifecycle_cohort')::numeric
      / evaluation.realized_price))),
    avg(abs(ln((output.baseline_prices->>'structural_convergence')::numeric
      / evaluation.realized_price)))
    into no_change_error, damped_momentum_error, market_index_error,
         lifecycle_cohort_error, structural_convergence_error
  from public.forecast_execution_challenges challenge
  join public.forecast_execution_receipts receipt
    on receipt.challenge_id = challenge.id
  join public.card_forecast_predictions prediction
    on prediction.prospective_run_id = receipt.prospective_run_id
  join public.prospective_prediction_outputs output
    on output.prediction_id = prediction.id
   and output.execution_receipt_id = receipt.id
  join public.forecast_evaluations evaluation
    on evaluation.prediction_id = prediction.id
   and evaluation.analytics_run_id = evaluation_run.id
  where challenge.scorecard_plan_id = plan.id
    and prediction.prediction_status = 'research_only'
    and evaluation.evaluation_status = 'scored';

  no_change_lift := case when no_change_error > 0
    then 1 - mae_log_return / no_change_error else null end;
  damped_momentum_lift := case when damped_momentum_error > 0
    then 1 - mae_log_return / damped_momentum_error else null end;
  market_index_lift := case when market_index_error > 0
    then 1 - mae_log_return / market_index_error else null end;
  lifecycle_cohort_lift := case when lifecycle_cohort_error > 0
    then 1 - mae_log_return / lifecycle_cohort_error else null end;
  structural_convergence_lift := case when structural_convergence_error > 0
    then 1 - mae_log_return / structural_convergence_error else null end;
  baseline_results := jsonb_build_object(
    'no_change', no_change_lift,
    'damped_momentum', damped_momentum_lift,
    'market_index', market_index_lift,
    'lifecycle_cohort', lifecycle_cohort_lift,
    'structural_convergence', structural_convergence_lift
  );
  select
    coalesce(array_agg(name order by ordinal) filter (where lift is null), array[]::text[]),
    coalesce(array_agg(name order by ordinal) filter (
      where lift is not null
        and name <> 'no_change'
        and lift < (plan.promotion_policy->>'minimumBaselineLift')::numeric
    ), array[]::text[])
    into missing_baselines, below_threshold_baselines
  from (values
    ('no_change', no_change_lift, 1),
    ('damped_momentum', damped_momentum_lift, 2),
    ('market_index', market_index_lift, 3),
    ('lifecycle_cohort', lifecycle_cohort_lift, 4),
    ('structural_convergence', structural_convergence_lift, 5)
  ) baselines(name, lift, ordinal);
  select name, lift into strongest_challenger_name, strongest_challenger_lift
  from (values
    ('damped_momentum', damped_momentum_lift),
    ('market_index', market_index_lift),
    ('lifecycle_cohort', lifecycle_cohort_lift),
    ('structural_convergence', structural_convergence_lift)
  ) challengers(name, lift)
  where lift is not null order by lift asc, name asc limit 1;

  -- Deterministic origin-cluster bootstrap. Each sample resamples whole origin
  -- clusters, so many cards from one market date cannot masquerade as
  -- independent evidence. The digest supplies reproducible pseudo-random draws.
  with included_cases as (
    select prediction.origin,
           abs(ln(prediction.q50 / evaluation.realized_price)) as model_error,
           output.baseline_prices,
           evaluation.realized_price
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    join public.card_forecast_predictions prediction
      on prediction.prospective_run_id = receipt.prospective_run_id
    join public.prospective_prediction_outputs output
      on output.prediction_id = prediction.id
     and output.execution_receipt_id = receipt.id
    join public.forecast_evaluations evaluation
      on evaluation.prediction_id = prediction.id
     and evaluation.analytics_run_id = evaluation_run.id
    where challenge.scorecard_plan_id = plan.id
      and prediction.prediction_status = 'research_only'
      and evaluation.evaluation_status = 'scored'
  ), expanded as (
    select included.origin, included.model_error, baseline.name,
           abs(ln(baseline.price / included.realized_price)) as baseline_error
    from included_cases included
    cross join lateral (values
      ('no_change', (included.baseline_prices->>'no_change')::numeric),
      ('damped_momentum', (included.baseline_prices->>'damped_momentum')::numeric),
      ('market_index', (included.baseline_prices->>'market_index')::numeric),
      ('lifecycle_cohort', (included.baseline_prices->>'lifecycle_cohort')::numeric),
      ('structural_convergence', (included.baseline_prices->>'structural_convergence')::numeric)
    ) baseline(name, price)
  ), origin_clusters as (
    select name, origin, sum(model_error) as model_error,
           sum(baseline_error) as baseline_error,
           row_number() over (partition by name order by origin) as origin_number,
           count(*) over (partition by name) as cluster_origin_count
    from expanded group by name, origin
  ), draws as (
    select cluster_count.name, sample_number, draw_number,
           1 + mod(
             (
               ('x' || substr(encode(digest(concat_ws('|',
                 plan.plan_hash, cluster_count.name, sample_number::text,
                 draw_number::text
               ), 'sha256'), 'hex'), 1, 8))::bit(32)::bigint
             ),
             cluster_count.cluster_origin_count
           ) as chosen_origin
    from (
      select name, max(cluster_origin_count) as cluster_origin_count
      from origin_clusters group by name
    ) cluster_count
    cross join generate_series(
      1, (plan.gate_policy->>'bootstrapSamples')::integer
    ) sample_number
    cross join lateral generate_series(
      1, cluster_count.cluster_origin_count::integer
    ) draw_number
  ), estimates as (
    select draw.name, draw.sample_number,
           case when sum(cluster.baseline_error) > 0
             then 1 - sum(cluster.model_error) / sum(cluster.baseline_error)
             else null
           end as lift
    from draws draw
    join origin_clusters cluster
      on cluster.name = draw.name
     and cluster.origin_number = draw.chosen_origin
    group by draw.name, draw.sample_number
  ), lower_bounds as (
    select name, percentile_cont(
      (1 - (plan.gate_policy->>'confidenceLevel')::numeric) / 2
    ) within group (order by lift) filter (where lift is not null) as lower_bound
    from estimates group by name
  )
  select coalesce(jsonb_object_agg(name, lower_bound order by name), '{}'::jsonb)
    into baseline_lift_lower_95
  from lower_bounds;

  select count(distinct prediction.variant_id)::integer,
         count(distinct card.set_id)::integer,
         count(distinct prediction.origin)::integer
    into variant_count, set_count, origin_count
  from public.forecast_execution_challenges challenge
  join public.forecast_execution_receipts receipt
    on receipt.challenge_id = challenge.id
  join public.card_forecast_predictions prediction
    on prediction.prospective_run_id = receipt.prospective_run_id
  join public.catalog_variants variant on variant.id = prediction.variant_id
  join public.catalog_cards card on card.id = variant.card_id
  join public.forecast_evaluations evaluation
    on evaluation.prediction_id = prediction.id
   and evaluation.analytics_run_id = evaluation_run.id
  where challenge.scorecard_plan_id = plan.id
    and prediction.prediction_status = 'research_only'
    and evaluation.evaluation_status = 'scored';
  for origin_value in
    select distinct prediction.origin
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    join public.card_forecast_predictions prediction
      on prediction.prospective_run_id = receipt.prospective_run_id
    join public.forecast_evaluations evaluation
      on evaluation.prediction_id = prediction.id
     and evaluation.analytics_run_id = evaluation_run.id
    where challenge.scorecard_plan_id = plan.id
      and prediction.prediction_status = 'research_only'
      and evaluation.evaluation_status = 'scored'
    order by prediction.origin
  loop
    if last_spaced_origin is null
       or origin_value >= last_spaced_origin
            + (plan.gate_policy->>'minimumOriginSpacingDays')::numeric
              * interval '1 day' then
      spaced_origin_count := spaced_origin_count + 1;
      last_spaced_origin := origin_value;
    end if;
  end loop;

  with cost_cases as (
    select prediction.id, prediction.q25,
           output.probability_net_positive as probability,
           output.selected_for_pocket,
           quote.all_in_acquisition_cost,
           quote.sell_fee_rate, quote.sell_fee_fixed, quote.sell_shipping,
           quote.liquidity_haircut_rate,
           (
             evaluation.realized_price * (1 - quote.sell_fee_rate)
               * (1 - quote.liquidity_haircut_rate)
             - quote.sell_fee_fixed - quote.sell_shipping
           ) / quote.all_in_acquisition_cost - 1 as realized_net_roi,
           (
             prediction.q25 * (1 - quote.sell_fee_rate)
               * (1 - quote.liquidity_haircut_rate)
             - quote.sell_fee_fixed - quote.sell_shipping
           ) / quote.all_in_acquisition_cost - 1 as conservative_net_roi
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    join public.card_forecast_predictions prediction
      on prediction.prospective_run_id = receipt.prospective_run_id
    join public.prospective_prediction_outputs output
      on output.prediction_id = prediction.id
     and output.execution_receipt_id = receipt.id
    join public.prospective_acquisition_cost_quotes quote
      on quote.prospective_run_id = receipt.prospective_run_id
     and quote.candidate_member_id = prediction.prospective_candidate_member_id
    join public.forecast_evaluations evaluation
      on evaluation.prediction_id = prediction.id
     and evaluation.analytics_run_id = evaluation_run.id
    where challenge.scorecard_plan_id = plan.id
      and prediction.prediction_status = 'research_only'
      and evaluation.evaluation_status = 'scored'
      and quote.quote_status = 'complete'
      and quote.quote_semantics = 'provider_listing'
      and quote.liquidity_status = 'source_backed'
      and output.probability_net_positive is not null
  )
  select count(*)::integer,
         avg(power(probability - (realized_net_roi > 0)::integer, 2)),
         count(*) filter (where selected_for_pocket)::integer,
         avg((realized_net_roi > 0)::integer)
           filter (where selected_for_pocket),
         percentile_cont(0.5) within group (order by realized_net_roi)
           filter (where selected_for_pocket),
         avg((realized_net_roi <= 0)::integer)
           filter (where selected_for_pocket),
         avg(abs(conservative_net_roi - realized_net_roi))
           filter (where selected_for_pocket)
    into after_cost_case_count, after_cost_brier, selected_count,
         selected_positive_rate, selected_median_net_roi,
         selected_false_discovery_rate, selected_mean_conservative_error
  from cost_cases;

  with cost_cases as (
    select output.probability_net_positive as probability,
           (
             (
               evaluation.realized_price * (1 - quote.sell_fee_rate)
                 * (1 - quote.liquidity_haircut_rate)
               - quote.sell_fee_fixed - quote.sell_shipping
             ) / quote.all_in_acquisition_cost - 1 > 0
           )::integer as outcome
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    join public.card_forecast_predictions prediction
      on prediction.prospective_run_id = receipt.prospective_run_id
    join public.prospective_prediction_outputs output
      on output.prediction_id = prediction.id
     and output.execution_receipt_id = receipt.id
    join public.prospective_acquisition_cost_quotes quote
      on quote.prospective_run_id = receipt.prospective_run_id
     and quote.candidate_member_id = prediction.prospective_candidate_member_id
    join public.forecast_evaluations evaluation
      on evaluation.prediction_id = prediction.id
     and evaluation.analytics_run_id = evaluation_run.id
    where challenge.scorecard_plan_id = plan.id
      and prediction.prediction_status = 'research_only'
      and evaluation.evaluation_status = 'scored'
      and quote.quote_status = 'complete'
      and quote.quote_semantics = 'provider_listing'
      and quote.liquidity_status = 'source_backed'
      and output.probability_net_positive is not null
  ), buckets as (
    select least(floor(probability * 10), 9)::integer as bucket,
           count(*) as bucket_count, avg(probability) as mean_probability,
           avg(outcome) as mean_outcome
    from cost_cases group by 1
  )
  select sum(
    bucket_count::numeric / nullif(after_cost_case_count, 0)
      * abs(mean_probability - mean_outcome)
  ) into after_cost_calibration
  from buckets;

  if cardinality(missing_baselines) > 0 then
    reason_codes := array_append(reason_codes, 'missing_required_baselines');
  end if;
  if evaluation_count < (plan.promotion_policy->>'minimumCases')::integer then
    reason_codes := array_append(reason_codes, 'insufficient_evaluation_cases');
  end if;
  if no_change_lift is null then
    reason_codes := array_append(reason_codes, 'missing_baseline_comparison');
  elsif no_change_lift
          < (plan.promotion_policy->>'minimumBaselineLift')::numeric then
    reason_codes := array_append(reason_codes, 'baseline_lift_below_threshold');
  end if;
  if cardinality(below_threshold_baselines) > 0 then
    reason_codes := array_append(
      reason_codes, 'challenger_baseline_lift_below_threshold'
    );
  end if;
  if interval_80_coverage is null then
    reason_codes := array_append(reason_codes, 'missing_interval_coverage');
  elsif interval_80_coverage not between
      (plan.promotion_policy->>'interval80CoverageMin')::numeric
      and (plan.promotion_policy->>'interval80CoverageMax')::numeric then
    reason_codes := array_append(reason_codes, 'interval_coverage_outside_band');
  end if;
  if brier_score is null then
    reason_codes := array_append(reason_codes, 'missing_probability_score');
  elsif brier_score > (plan.promotion_policy->>'maximumBrierScore')::numeric then
    reason_codes := array_append(reason_codes, 'brier_score_above_threshold');
  end if;
  if variant_count < (plan.gate_policy->>'minimumVariants')::integer then
    reason_codes := array_append(reason_codes, 'insufficient_variant_breadth');
  end if;
  if set_count < (plan.gate_policy->>'minimumSets')::integer then
    reason_codes := array_append(reason_codes, 'insufficient_set_breadth');
  end if;
  if spaced_origin_count < (plan.gate_policy->>'minimumSpacedOrigins')::integer then
    reason_codes := array_append(reason_codes, 'insufficient_origin_breadth');
  end if;
  if baseline_lift_lower_95 is null
     or exists (
       select 1
       from jsonb_array_elements_text(
         plan.promotion_policy->'requiredBaselines'
       ) baseline(name)
       where jsonb_typeof(baseline_lift_lower_95->baseline.name)
               is distinct from 'number'
     ) then
    reason_codes := array_append(reason_codes, 'missing_clustered_lift_intervals');
  elsif exists (
    select 1
    from jsonb_array_elements_text(
      plan.promotion_policy->'requiredBaselines'
    ) baseline(name)
    where (baseline_lift_lower_95->>baseline.name)::numeric
            <= (plan.gate_policy->>'minimumLiftLowerBound')::numeric
  ) then
    reason_codes := array_append(reason_codes, 'lift_lower_bound_not_positive');
  end if;
  if after_cost_case_count < evaluation_count then
    reason_codes := array_append(reason_codes, 'incomplete_after_cost_candidate_universe');
  end if;
  if plan.universe_purpose = 'after_cost_opportunity' then
    if after_cost_case_count
         < (plan.gate_policy->>'minimumAfterCostCalibrationCases')::integer then
      reason_codes := array_append(reason_codes, 'insufficient_after_cost_probability_calibration_cases');
    else
      if after_cost_brier is null
         or after_cost_brier
              > (plan.gate_policy->>'maximumAfterCostBrierScore')::numeric then
        reason_codes := array_append(reason_codes, 'after_cost_brier_above_threshold');
      end if;
      if after_cost_calibration is null
         or after_cost_calibration
              > (plan.gate_policy->>'maximumAfterCostCalibrationError')::numeric then
        reason_codes := array_append(reason_codes, 'after_cost_calibration_error_above_threshold');
      end if;
    end if;
    if selected_count < (plan.gate_policy->>'minimumSelectedPocketCases')::integer then
      reason_codes := array_append(reason_codes, 'insufficient_selected_pocket_cases');
    else
      if selected_positive_rate
           < (plan.gate_policy->>'minimumSelectedPositiveRate')::numeric then
        reason_codes := array_append(reason_codes, 'selected_reference_positive_rate_below_threshold');
      end if;
      if selected_median_net_roi
           <= (plan.gate_policy->>'minimumSelectedMedianNetRoi')::numeric then
        reason_codes := array_append(reason_codes, 'selected_median_reference_implied_net_roi_below_threshold');
      end if;
      if selected_false_discovery_rate
           > (plan.gate_policy->>'maximumSelectedFalseDiscoveryRate')::numeric then
        reason_codes := array_append(reason_codes, 'selected_reference_false_discovery_rate_above_threshold');
      end if;
    end if;
  end if;

  recommendation := case
    when cardinality(reason_codes) = 0 then 'eligible_for_operator_review'
    when exists (
      select 1 from unnest(reason_codes) reason
      where reason like 'insufficient_%'
         or reason like 'missing_%'
         or reason like 'incomplete_%'
    ) then 'insufficient'
    else 'reject'
  end;
  metrics := jsonb_build_object(
    'count', evaluation_count,
    'maeLogReturn', mae_log_return,
    'medianAbsolutePercentageError', median_absolute_percentage_error,
    'symmetricMape', symmetric_mape,
    'medianAbsoluteDollarError', median_absolute_dollar_error,
    'directionAccuracy', direction_accuracy,
    'directionAccuracy10Percent', direction_accuracy_10,
    'directionAccuracy25Percent', direction_accuracy_25,
    'baselineRelativeLift', no_change_lift,
    'brierScore', brier_score,
    'probabilityCalibrationError', probability_calibration_error,
    'pinballLoss', pinball_loss,
    'interval50Coverage', interval_50_coverage,
    'interval80Coverage', interval_80_coverage,
    'interval50Width', interval_50_width,
    'interval80Width', interval_80_width,
    'baselineResults', baseline_results,
    'originClusteredBaselineLiftLower95', baseline_lift_lower_95,
    'missingRequiredBaselines', to_jsonb(missing_baselines),
    'belowThresholdRequiredBaselines', to_jsonb(below_threshold_baselines),
    'strongestSimpleChallenger', case
      when strongest_challenger_name is null then null
      else jsonb_build_object(
        'name', strongest_challenger_name,
        'relativeLift', strongest_challenger_lift
      )
    end,
    'maturedCount', matured_count,
    'unscorableCount', unscorable_count,
    'excludedCount', excluded_count,
    'promotionPolicy', plan.promotion_policy,
    'promotionPolicyHash', plan.promotion_policy_hash,
    'evaluationMembershipHash', membership_hash,
    'gatePolicy', plan.gate_policy,
    'gatePolicyHash', plan.gate_policy_hash,
    'scorecardPlanId', plan.id,
    'scorecardPlanHash', plan.plan_hash,
    'challengeCount', challenge_count,
    'variantCount', variant_count,
    'setCount', set_count,
    'originCount', origin_count,
    'spacedOriginCount', spaced_origin_count,
    'afterCostProbability', jsonb_build_object(
      'caseCount', coalesce(after_cost_case_count, 0),
      'brierScore', after_cost_brier,
      'calibrationError', after_cost_calibration,
      'outcomeSemantics', 'provider_reference_net_proceeds_exceed_cost'
    ),
    'selectedPockets', jsonb_build_object(
      'candidateCount', coalesce(selected_count, 0),
      'referencePositiveRate', selected_positive_rate,
      'medianReferenceImpliedNetRoi', selected_median_net_roi,
      'referenceFalseDiscoveryRate', selected_false_discovery_rate,
      'meanConservativeReferenceError', selected_mean_conservative_error,
      'outcomeSemantics', 'provider_reference_not_executed_sale'
    ),
    'executionAttestation', jsonb_build_object(
      'level', 'hmac_executor_principal_v1',
      'artifactExecutionVerified', false
    )
  );
  generated_scorecard_hash := encode(digest(concat_ws('|',
    generated_scorecard_id::text, plan.id::text, plan.plan_hash,
    evaluation_run.id::text, model.id::text, plan.horizon_days::text,
    plan.cohort_key, plan.origin_start::text, plan.origin_end::text,
    evaluation_count::text, matured_count::text, unscorable_count::text,
    excluded_count::text, membership_hash, plan.promotion_policy_hash,
    metrics::text, recommendation, array_to_string(reason_codes, ','),
    database_created_at::text
  ), 'sha256'), 'hex');

  perform set_config(
    'collectfolio.deriving_prospective_scorecard', plan.id::text, true
  );
  insert into public.model_scorecards (
    id, analytics_run_id, model_version_id, horizon_days, cohort_key,
    origin_start, origin_end, evaluation_count, matured_count,
    unscorable_count, excluded_count, metrics, promotion_policy,
    promotion_policy_hash, evaluation_membership_hash,
    promotion_recommendation, reason_codes, scorecard_hash, created_at,
    evidence_mode, prospective_scorecard_plan_id
  ) values (
    generated_scorecard_id, evaluation_run.id, model.id, plan.horizon_days,
    plan.cohort_key, plan.origin_start, plan.origin_end, evaluation_count,
    matured_count, unscorable_count, excluded_count, metrics,
    plan.promotion_policy, plan.promotion_policy_hash, membership_hash,
    recommendation, reason_codes, generated_scorecard_hash,
    database_created_at, 'prospective', plan.id
  );

  insert into public.prospective_scorecard_run_memberships (
    scorecard_id, scorecard_plan_id, prospective_run_id,
    execution_receipt_id, candidate_universe_id, created_at
  )
  select generated_scorecard_id, plan.id, receipt.prospective_run_id, receipt.id,
         universe.id, database_created_at
  from public.forecast_execution_challenges challenge
  join public.forecast_execution_receipts receipt
    on receipt.challenge_id = challenge.id
  join public.prospective_candidate_universes universe
    on universe.prospective_run_id = receipt.prospective_run_id
  where challenge.scorecard_plan_id = plan.id;

  insert into public.model_scorecard_evaluations (
    scorecard_id, evaluation_id, evaluation_status,
    included_in_metrics, reason_codes, created_at
  )
  select generated_scorecard_id, evaluation.id, evaluation.evaluation_status,
         prediction.prediction_status = 'research_only'
           and evaluation.evaluation_status = 'scored',
         case
           when prediction.prediction_status = 'quarantined'
             then array['quarantined_prediction_excluded']
           when evaluation.evaluation_status = 'unscorable'
             then array['unscorable_target_excluded']
           else array[]::text[]
         end,
         database_created_at
  from public.forecast_execution_challenges challenge
  join public.forecast_execution_receipts receipt
    on receipt.challenge_id = challenge.id
  join public.card_forecast_predictions prediction
    on prediction.prospective_run_id = receipt.prospective_run_id
  join public.forecast_evaluations evaluation
    on evaluation.prediction_id = prediction.id
   and evaluation.analytics_run_id = evaluation_run.id
  where challenge.scorecard_plan_id = plan.id;

  if (select count(*) from public.model_scorecard_evaluations membership
      where membership.scorecard_id = generated_scorecard_id) <> matured_count
     or (select count(*) from public.prospective_scorecard_run_memberships membership
         where membership.scorecard_id = generated_scorecard_id) <> challenge_count then
    raise exception 'Atomic prospective scorecard membership is incomplete';
  end if;
  return generated_scorecard_id;
end;
$$;

create trigger forecast_executor_keys_append_only
  before update or delete on public.forecast_executor_keys
  for each row execute function public.reject_append_only_mutation();
create trigger prospective_scorecard_plans_append_only
  before update or delete on public.prospective_scorecard_plans
  for each row execute function public.reject_append_only_mutation();
create trigger forecast_execution_challenges_append_only
  before update or delete on public.forecast_execution_challenges
  for each row execute function public.reject_append_only_mutation();
create trigger forecast_execution_receipts_append_only
  before update or delete on public.forecast_execution_receipts
  for each row execute function public.reject_append_only_mutation();
create trigger prospective_prediction_outputs_append_only
  before update or delete on public.prospective_prediction_outputs
  for each row execute function public.reject_append_only_mutation();
create trigger prospective_scorecard_runs_append_only
  before update or delete on public.prospective_scorecard_run_memberships
  for each row execute function public.reject_append_only_mutation();

alter table public.forecast_executor_keys enable row level security;
alter table public.prospective_scorecard_plans enable row level security;
alter table public.forecast_execution_challenges enable row level security;
alter table public.forecast_execution_receipts enable row level security;
alter table public.prospective_prediction_outputs enable row level security;
alter table public.prospective_scorecard_run_memberships enable row level security;

revoke all on public.forecast_executor_keys,
  public.prospective_scorecard_plans,
  public.forecast_execution_challenges,
  public.forecast_execution_receipts,
  public.prospective_prediction_outputs,
  public.prospective_scorecard_run_memberships
  from public, anon, authenticated, service_role;
grant select on public.prospective_scorecard_plans,
  public.forecast_execution_challenges,
  public.forecast_execution_receipts,
  public.prospective_prediction_outputs,
  public.prospective_scorecard_run_memberships
  to service_role;

-- Retrospective research exporters retain a column-scoped insert path. They
-- cannot set either the prospective evidence mode or its plan foreign key.
revoke insert on public.model_scorecards from service_role;
grant insert (
  id, analytics_run_id, model_version_id, horizon_days, cohort_key,
  origin_start, origin_end, evaluation_count, metrics,
  promotion_recommendation, reason_codes, scorecard_hash, matured_count,
  unscorable_count, excluded_count, promotion_policy,
  promotion_policy_hash, evaluation_membership_hash
) on public.model_scorecards to service_role;

revoke execute on function public.record_prospective_forecast_run(jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.create_prospective_scorecard_plan(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_prospective_scorecard_plan(jsonb)
  to service_role;
revoke execute on function public.begin_prospective_forecast_execution(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_prospective_forecast_execution(jsonb)
  to service_role;
revoke execute on function public.record_challenged_prospective_forecast_run(jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_challenged_prospective_forecast_run(jsonb,jsonb)
  to service_role;
revoke execute on function public.create_prospective_model_scorecard(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_prospective_model_scorecard(jsonb)
  to service_role;

revoke execute on function public.canonical_forecast_execution_input_hash(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.canonical_prospective_cost_quote_hash(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.canonical_prospective_candidate_output_hash(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.canonical_stored_prospective_cost_quote_hash(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.canonical_stored_prospective_output_hash(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_challenged_forecast_prediction_insert()
  from public, anon, authenticated, service_role;
revoke execute on function public.apply_challenged_prospective_run_origin()
  from public, anon, authenticated, service_role;
revoke execute on function public.apply_challenged_universe_origin()
  from public, anon, authenticated, service_role;
revoke execute on function public.apply_challenged_member_origin()
  from public, anon, authenticated, service_role;
revoke execute on function public.apply_challenged_cost_origin()
  from public, anon, authenticated, service_role;
revoke execute on function public.apply_challenged_prediction_origin()
  from public, anon, authenticated, service_role;
revoke execute on function public.validate_prospective_scorecard_creation()
  from public, anon, authenticated, service_role;
revoke execute on function public.validate_scorecard_evaluation_membership()
  from public, anon, authenticated, service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'forecast_executor_keys','prospective_scorecard_plans',
    'forecast_execution_challenges','forecast_execution_receipts',
    'prospective_prediction_outputs','prospective_scorecard_run_memberships'
  ]
  loop
    if not (
      select relation.relrowsecurity
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relname = table_name
    ) then
      raise exception 'Forecast execution table % must have RLS enabled', table_name;
    end if;
    if has_table_privilege('anon', format('public.%I', table_name), 'SELECT')
       or has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT') then
      raise exception 'Forecast execution table % must remain browser-private', table_name;
    end if;
    if has_table_privilege('service_role', format('public.%I', table_name), 'INSERT')
       or has_table_privilege('service_role', format('public.%I', table_name), 'UPDATE')
       or has_table_privilege('service_role', format('public.%I', table_name), 'DELETE') then
      raise exception 'Forecast execution table % must be guarded-RPC append-only', table_name;
    end if;
  end loop;

  if has_table_privilege('service_role', 'public.forecast_executor_keys', 'SELECT') then
    raise exception 'Service role must not read independent executor HMAC keys';
  end if;
  if has_column_privilege(
       'service_role', 'public.model_scorecards', 'evidence_mode', 'INSERT'
     )
     or has_column_privilege(
       'service_role', 'public.model_scorecards',
       'prospective_scorecard_plan_id', 'INSERT'
     ) then
    raise exception 'Service role must not directly declare prospective scorecards';
  end if;
  if has_function_privilege(
       'service_role', 'public.record_prospective_forecast_run(jsonb,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.record_challenged_prospective_forecast_run(jsonb,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'Only the challenged prospective recording path may be service-executable';
  end if;
  if has_function_privilege(
       'anon', 'public.create_prospective_model_scorecard(jsonb)', 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', 'public.create_prospective_model_scorecard(jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role', 'public.create_prospective_model_scorecard(jsonb)',
       'EXECUTE'
     ) then
    raise exception 'Prospective scorecard RPC ACL is incorrect';
  end if;
  if coalesce((
    select enabled from public.product_feature_flags
    where key = 'public_price_intelligence'
  ), false) then
    raise exception 'Forecast execution migration must leave public_price_intelligence disabled';
  end if;
  if to_regprocedure('public.publish_forecast_intelligence(uuid)') is not null then
    raise exception 'Forecast execution migration must not install a public forecast publisher';
  end if;
  if position(
    'Forecast Engine v1 has no public promotion path'
    in pg_get_functiondef(
      'public.validate_model_promotion_review_integrity()'::regprocedure
    )
  ) = 0 then
    raise exception 'Forecast Engine v1 unconditional public-promotion block must remain intact';
  end if;
end;
$$;

commit;
