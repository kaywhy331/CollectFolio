-- CollectFolio private prospective forecast ledger.
--
-- This migration creates proof that a complete exact-series candidate universe,
-- its origin-time cost evidence, and its shadow predictions were committed before
-- any target matured. The database authors the origin and evidence mode. It does
-- not create a forecast publication RPC, enable a public feature flag, or make any
-- forecast evidence browser-readable.

begin;

do $$
begin
  if coalesce((
    select enabled from public.product_feature_flags
    where key = 'public_price_intelligence'
  ), false) then
    raise exception 'Apply the prospective forecast ledger only while public_price_intelligence is disabled';
  end if;
end;
$$;

-- Generic commercial/modeling flags are not enough to prove exact-condition
-- label, retention, liquidity, or predictive-derivative rights. Existing reviews
-- fail closed; activation requires a new immutable review granting every use.
alter table public.source_terms_reviews
  add column private_forecast_modeling_allowed boolean not null default false,
  add column prospective_capture_allowed boolean not null default false,
  add column exact_condition_labels_allowed boolean not null default false,
  add column retention_through_maturity_allowed boolean not null default false,
  add column liquidity_derivation_allowed boolean not null default false,
  add column predictive_derivatives_allowed boolean not null default false,
  add constraint source_terms_reviews_forecast_rights_check check (
    not private_forecast_modeling_allowed
    or commercial_use_allowed
  ),
  add constraint source_terms_reviews_prospective_rights_check check (
    not prospective_capture_allowed
    or commercial_use_allowed
  ),
  add constraint source_terms_reviews_exact_condition_labels_rights_check check (
    not exact_condition_labels_allowed
    or commercial_use_allowed
  ),
  add constraint source_terms_reviews_retention_rights_check check (
    not retention_through_maturity_allowed
    or (commercial_use_allowed and prospective_capture_allowed)
  ),
  add constraint source_terms_reviews_liquidity_rights_check check (
    not liquidity_derivation_allowed
    or commercial_use_allowed
  ),
  add constraint source_terms_reviews_predictive_derivative_rights_check check (
    not predictive_derivatives_allowed
    or (commercial_use_allowed and private_forecast_modeling_allowed)
  );

create table public.trend_expected_input_manifests (
  id uuid primary key default gen_random_uuid(),
  trend_analytics_run_id uuid not null unique
    references public.analytics_runs(id) on delete restrict,
  feature_cutoff timestamptz not null,
  selection_policy jsonb not null check (
    jsonb_typeof(selection_policy) = 'object'
    and octet_length(selection_policy::text) <= 32768
  ),
  selection_policy_hash text not null
    check (selection_policy_hash ~ '^[0-9a-f]{64}$'),
  expected_series_count integer not null check (expected_series_count > 0),
  expected_series_hash text not null
    check (expected_series_hash ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz not null,
  manifest_hash text not null unique check (manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  unique (id, trend_analytics_run_id, manifest_hash),
  check (created_at = sealed_at)
);

create table public.prospective_forecast_runs (
  id uuid primary key default gen_random_uuid(),
  analytics_run_id uuid not null references public.analytics_runs(id) on delete restrict,
  trend_analytics_run_id uuid not null references public.analytics_runs(id) on delete restrict,
  input_manifest_id uuid not null,
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  model_version_id uuid not null references public.model_versions(id) on delete restrict,
  origin timestamptz not null,
  horizon_days integer not null check (horizon_days in (30,90)),
  matures_at timestamptz not null,
  model_artifact_hash text not null check (model_artifact_hash ~ '^[0-9a-f]{64}$'),
  feature_dataset_hash text not null check (feature_dataset_hash ~ '^[0-9a-f]{64}$'),
  forecast_dataset_hash text not null check (forecast_dataset_hash ~ '^[0-9a-f]{64}$'),
  source_policy_hash text not null check (source_policy_hash ~ '^[0-9a-f]{64}$'),
  feature_version text not null check (char_length(feature_version) between 1 and 160),
  mapping_version text not null check (char_length(mapping_version) between 1 and 160),
  code_version text not null check (char_length(code_version) between 1 and 240),
  submission_hash text not null check (submission_hash ~ '^[0-9a-f]{64}$'),
  run_hash text not null unique check (run_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  unique (analytics_run_id, horizon_days),
  unique (id, model_version_id, origin, horizon_days),
  foreign key (input_manifest_id, trend_analytics_run_id, input_manifest_hash)
    references public.trend_expected_input_manifests(
      id, trend_analytics_run_id, manifest_hash
    ) on delete restrict,
  check (matures_at = origin + make_interval(days => horizon_days)),
  check (created_at = origin)
);

create table public.prospective_candidate_universes (
  id uuid primary key default gen_random_uuid(),
  prospective_run_id uuid not null unique
    references public.prospective_forecast_runs(id) on delete restrict,
  purpose text not null check (purpose in ('forecast_validation','after_cost_opportunity')),
  selection_policy jsonb not null check (
    jsonb_typeof(selection_policy) = 'object'
    and octet_length(selection_policy::text) <= 32768
  ),
  selection_policy_hash text not null check (selection_policy_hash ~ '^[0-9a-f]{64}$'),
  candidate_count integer not null check (candidate_count > 0),
  universe_snapshot_hash text not null unique
    check (universe_snapshot_hash ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz not null,
  created_at timestamptz not null,
  unique (id, prospective_run_id),
  check (created_at = sealed_at)
);

create table public.prospective_candidate_universe_members (
  id uuid primary key default gen_random_uuid(),
  candidate_universe_id uuid not null,
  prospective_run_id uuid not null,
  market_series_id uuid not null references public.market_series(id) on delete restrict,
  trend_snapshot_id uuid not null references public.trend_feature_snapshots(id) on delete restrict,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  selection_ordinal integer not null check (selection_ordinal > 0),
  evidence_quality numeric(7,6) not null check (evidence_quality between 0 and 1),
  trend_snapshot_hash text not null check (trend_snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  foreign key (candidate_universe_id, prospective_run_id)
    references public.prospective_candidate_universes(id, prospective_run_id)
    on delete restrict,
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  unique (candidate_universe_id, market_series_id),
  unique (candidate_universe_id, trend_snapshot_id),
  unique (candidate_universe_id, selection_ordinal),
  unique (id, candidate_universe_id, prospective_run_id)
);

create table public.prospective_acquisition_cost_quotes (
  id uuid primary key default gen_random_uuid(),
  candidate_member_id uuid not null unique,
  candidate_universe_id uuid not null,
  prospective_run_id uuid not null,
  quote_status text not null check (quote_status in ('complete','unavailable')),
  quote_semantics text not null check (
    quote_semantics in ('provider_listing','user_entered_offer','unavailable')
  ),
  quote_market_series_id uuid references public.market_series(id) on delete restrict,
  quote_source_id uuid references public.data_sources(id) on delete restrict,
  quote_terms_review_id uuid references public.source_terms_reviews(id) on delete restrict,
  external_quote_id text check (
    external_quote_id is null or char_length(external_quote_id) between 1 and 700
  ),
  quote_observed_at timestamptz,
  captured_at timestamptz not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  offer_price numeric(16,4),
  tax_rate numeric(9,8),
  buy_shipping numeric(16,4),
  sell_fee_rate numeric(9,8),
  sell_fee_fixed numeric(16,4),
  sell_shipping numeric(16,4),
  liquidity_status text not null check (liquidity_status in ('source_backed','unknown','unavailable')),
  liquidity_haircut_rate numeric(9,8),
  quote_evidence_hash text check (
    quote_evidence_hash is null or quote_evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  liquidity_evidence_hash text check (
    liquidity_evidence_hash is null or liquidity_evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  unavailable_reason text check (
    unavailable_reason is null or char_length(unavailable_reason) between 1 and 700
  ),
  quote_hash text not null unique check (quote_hash ~ '^[0-9a-f]{64}$'),
  all_in_acquisition_cost numeric(16,4) generated always as (
    case when quote_status = 'complete'
      then offer_price * (1 + tax_rate) + buy_shipping
      else null
    end
  ) stored,
  break_even_resale_price numeric(16,4) generated always as (
    case when quote_status = 'complete'
      then (
        offer_price * (1 + tax_rate) + buy_shipping + sell_shipping + sell_fee_fixed
      ) / (1 - sell_fee_rate)
      else null
    end
  ) stored,
  liquidity_adjusted_break_even_reference numeric(16,4) generated always as (
    case when quote_status = 'complete' and liquidity_status = 'source_backed'
      then (
        offer_price * (1 + tax_rate) + buy_shipping + sell_shipping + sell_fee_fixed
      ) / ((1 - sell_fee_rate) * (1 - liquidity_haircut_rate))
      else null
    end
  ) stored,
  created_at timestamptz not null,
  foreign key (candidate_member_id, candidate_universe_id, prospective_run_id)
    references public.prospective_candidate_universe_members(
      id, candidate_universe_id, prospective_run_id
    ) on delete restrict,
  foreign key (quote_terms_review_id, quote_source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  check (
    (quote_source_id is null and quote_terms_review_id is null)
    or (quote_source_id is not null and quote_terms_review_id is not null)
  ),
  check (
    (
      quote_status = 'complete'
      and quote_semantics in ('provider_listing','user_entered_offer')
      and quote_observed_at is not null
      and offer_price > 0
      and tax_rate between 0 and 1
      and buy_shipping >= 0
      and sell_fee_rate >= 0 and sell_fee_rate < 1
      and sell_fee_fixed >= 0
      and sell_shipping >= 0
      and quote_evidence_hash is not null
      and unavailable_reason is null
      and liquidity_status in ('source_backed','unknown')
      and (quote_semantics = 'provider_listing' or liquidity_status = 'unknown')
      and (
        (liquidity_status = 'source_backed'
          and liquidity_haircut_rate is not null
          and liquidity_haircut_rate >= 0 and liquidity_haircut_rate < 1
          and liquidity_evidence_hash is not null)
        or
        (liquidity_status = 'unknown'
          and liquidity_haircut_rate is null
          and liquidity_evidence_hash is null)
      )
    )
    or
    (
      quote_status = 'unavailable'
      and quote_semantics = 'unavailable'
      and quote_market_series_id is null
      and quote_source_id is null
      and quote_terms_review_id is null
      and external_quote_id is null
      and quote_observed_at is null
      and offer_price is null
      and tax_rate is null
      and buy_shipping is null
      and sell_fee_rate is null
      and sell_fee_fixed is null
      and sell_shipping is null
      and liquidity_status = 'unavailable'
      and liquidity_haircut_rate is null
      and quote_evidence_hash is null
      and liquidity_evidence_hash is null
      and nullif(btrim(unavailable_reason), '') is not null
    )
  )
);

create index prospective_forecast_runs_maturity_idx
  on public.prospective_forecast_runs (matures_at, model_version_id, horizon_days);
create index prospective_candidate_members_series_idx
  on public.prospective_candidate_universe_members (market_series_id, created_at desc);

-- Prospective lineage is nullable for the pre-existing retrospective rows. A
-- composite foreign key prevents a prediction from mixing a member, universe,
-- and run that were not sealed together.
alter table public.card_forecast_predictions disable trigger card_forecast_predictions_append_only;
alter table public.card_forecast_predictions
  add column prospective_run_id uuid,
  add column candidate_universe_id uuid,
  add column prospective_candidate_member_id uuid,
  drop constraint card_forecast_predictions_evidence_mode_check,
  add constraint card_forecast_predictions_evidence_mode_check
    check (evidence_mode in ('retrospective','prospective')),
  add constraint card_forecast_predictions_prospective_lineage_check check (
    (
      evidence_mode = 'retrospective'
      and prospective_run_id is null
      and candidate_universe_id is null
      and prospective_candidate_member_id is null
    )
    or
    (
      evidence_mode = 'prospective'
      and prospective_run_id is not null
      and candidate_universe_id is not null
      and prospective_candidate_member_id is not null
    )
  ),
  add foreign key (
    prospective_candidate_member_id, candidate_universe_id, prospective_run_id
  ) references public.prospective_candidate_universe_members(
    id, candidate_universe_id, prospective_run_id
  ) on delete restrict;
alter table public.card_forecast_predictions enable trigger card_forecast_predictions_append_only;

create unique index card_forecast_predictions_prospective_member_unique
  on public.card_forecast_predictions (prospective_candidate_member_id)
  where prospective_candidate_member_id is not null;

alter table public.forecast_evaluations disable trigger forecast_evaluations_append_only;
alter table public.forecast_evaluations
  drop constraint forecast_evaluations_evidence_mode_check,
  add constraint forecast_evaluations_evidence_mode_check
    check (evidence_mode in ('retrospective','prospective'));
alter table public.forecast_evaluations enable trigger forecast_evaluations_append_only;

-- The pre-existing trigger name is retained. Retrospective insertion behaves as
-- before. Prospective mode is derived only from sealed foreign-key lineage and
-- a transaction-local marker set inside the guarded recording RPC.
create or replace function public.validate_forecast_prediction_series()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  snapshot_series uuid;
  snapshot_variant uuid;
  snapshot_source uuid;
  sealed_member public.prospective_candidate_universe_members%rowtype;
  sealed_run public.prospective_forecast_runs%rowtype;
begin
  select market_series_id, variant_id, source_id
    into snapshot_series, snapshot_variant, snapshot_source
  from public.trend_feature_snapshots where id = new.trend_snapshot_id;

  if new.prospective_candidate_member_id is null then
    if new.prospective_run_id is not null or new.candidate_universe_id is not null
       or new.evidence_mode <> 'retrospective' then
      raise exception 'Prospective evidence mode is database-derived and requires sealed ledger lineage';
    end if;
    if new.market_series_id is not null and (
      snapshot_series is distinct from new.market_series_id
      or snapshot_variant <> new.variant_id
      or snapshot_source <> new.source_id
    ) then
      raise exception 'Prediction and trend snapshot market series differ';
    end if;
    new.evidence_mode := 'retrospective';
    return new;
  end if;

  if current_setting('collectfolio.recording_prospective_forecast', true) <> 'on' then
    raise exception 'Prospective predictions must be recorded by the guarded atomic RPC';
  end if;

  select * into sealed_member
  from public.prospective_candidate_universe_members
  where id = new.prospective_candidate_member_id
    and candidate_universe_id = new.candidate_universe_id
    and prospective_run_id = new.prospective_run_id;
  select * into sealed_run
  from public.prospective_forecast_runs
  where id = new.prospective_run_id;

  if sealed_member.id is null or sealed_run.id is null
     or sealed_member.market_series_id <> new.market_series_id
     or sealed_member.trend_snapshot_id <> new.trend_snapshot_id
     or sealed_member.source_id <> new.source_id
     or sealed_member.terms_review_id <> new.terms_review_id
     or snapshot_series is distinct from new.market_series_id
     or snapshot_variant <> new.variant_id
     or snapshot_source <> new.source_id then
    raise exception 'Prospective prediction does not match its sealed exact-series member';
  end if;
  if sealed_run.model_version_id <> new.model_version_id
     or sealed_run.analytics_run_id <> new.analytics_run_id
     or sealed_run.origin <> new.origin
     or sealed_run.horizon_days <> new.horizon_days
     or sealed_run.matures_at <> new.matures_at
     or new.created_at <> sealed_run.origin then
    raise exception 'Prospective prediction does not match its database-authored run';
  end if;
  if clock_timestamp() >= sealed_run.matures_at then
    raise exception 'Prospective prediction cannot be recorded at or after maturity';
  end if;
  new.evidence_mode := 'prospective';
  return new;
end;
$$;

-- Seal the independently selected exact-series input inventory before any trend
-- snapshot exists. Candidate completeness is later checked against this receipt,
-- never inferred only from the rows that a trend run happened to write.
create or replace function public.seal_trend_expected_input_manifest(
  requested_trend_analytics_run_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  database_sealed_at timestamptz := clock_timestamp();
  manifest_id uuid := gen_random_uuid();
  trend_run public.analytics_runs%rowtype;
  policy jsonb;
  policy_source_id uuid;
  minimum_evidence numeric;
  maximum_feature_age_hours numeric;
  maximum_quote_age_hours numeric;
  policy_hash text;
  expected_count integer;
  expected_hash text;
  generated_manifest_hash text;
begin
  select * into trend_run
  from public.analytics_runs
  where id = requested_trend_analytics_run_id
  for update;
  policy := trend_run.config->'candidateUniversePolicy';

  if trend_run.id is null
     or trend_run.run_kind <> 'trend_build'
     or trend_run.status <> 'running'
     or trend_run.completed_at is not null
     or trend_run.dataset_hash is not null
     or trend_run.created_at > database_sealed_at
     or trend_run.started_at > database_sealed_at
     or trend_run.feature_cutoff is null then
    raise exception 'Expected-input manifest requires an unfinished immutable trend-build run';
  end if;
  if policy is null
     or jsonb_typeof(policy) is distinct from 'object'
     or not (policy ?& array[
       'version','cohortKey','game','sourceId','currency','language','conditionClass',
       'marketCondition','priceSemantics','finishes','minimumEvidenceQuality','purpose',
       'maximumFeatureAgeHours','maximumQuoteAgeHours'
     ])
     or policy - array[
       'version','cohortKey','game','sourceId','currency','language','conditionClass',
       'marketCondition','priceSemantics','finishes','minimumEvidenceQuality','purpose',
       'maximumFeatureAgeHours','maximumQuoteAgeHours'
     ] <> '{}'::jsonb
     or jsonb_typeof(policy->'finishes') is distinct from 'array'
     or jsonb_array_length(policy->'finishes') = 0
     or jsonb_typeof(policy->'minimumEvidenceQuality') is distinct from 'number'
     or jsonb_typeof(policy->'maximumFeatureAgeHours') is distinct from 'number'
     or jsonb_typeof(policy->'maximumQuoteAgeHours') is distinct from 'number'
     or exists (
       select 1 from jsonb_array_elements(policy->'finishes') value
       where jsonb_typeof(value) is distinct from 'string'
          or trim(both '"' from value::text) !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     ) then
    raise exception 'Expected-input manifest policy is incomplete or malformed';
  end if;

  policy_source_id := (policy->>'sourceId')::uuid;
  minimum_evidence := (policy->>'minimumEvidenceQuality')::numeric;
  maximum_feature_age_hours := (policy->>'maximumFeatureAgeHours')::numeric;
  maximum_quote_age_hours := (policy->>'maximumQuoteAgeHours')::numeric;
  if coalesce(policy->>'purpose', '') not in ('forecast_validation','after_cost_opportunity')
     or policy->>'game' is distinct from 'pokemon'
     or policy->>'cohortKey' is distinct from 'pokemon-en-raw-nm'
     or policy->>'currency' is distinct from 'USD'
     or policy->>'language' is distinct from 'en'
     or policy->>'conditionClass' is distinct from 'raw'
     or policy->>'marketCondition' is distinct from 'near-mint'
     or policy->>'priceSemantics' is distinct from 'market'
     or minimum_evidence < 0.55 or minimum_evidence > 1
     or maximum_feature_age_hours <= 0 or maximum_feature_age_hours > 168
     or maximum_quote_age_hours <= 0 or maximum_quote_age_hours > 168
     or nullif(btrim(policy->>'version'), '') is null then
    raise exception 'Expected-input manifest is restricted to the Pokémon English raw Near Mint USD pilot';
  end if;
  if trend_run.feature_cutoff > database_sealed_at
     or trend_run.feature_cutoff < database_sealed_at
          - maximum_feature_age_hours * interval '1 hour' then
    raise exception 'Expected-input manifest feature cutoff is stale or in the future';
  end if;
  if not exists (
    select 1
    from public.data_sources source
    join public.source_terms_reviews terms
      on terms.id = source.current_terms_review_id
     and terms.source_id = source.id
    where source.id = policy_source_id
      and source.active
      and terms.decision in ('research_only','approved')
      and terms.reviewed_at <= database_sealed_at
      and terms.created_at <= database_sealed_at
      and terms.commercial_use_allowed
      and terms.private_forecast_modeling_allowed
      and terms.prospective_capture_allowed
      and terms.exact_condition_labels_allowed
      and terms.retention_through_maturity_allowed
      and terms.predictive_derivatives_allowed
      and (terms.expires_at is null or terms.expires_at > database_sealed_at)
  ) then
    raise exception 'Expected-input manifest source rights are not active';
  end if;

  lock table public.trend_feature_snapshots in share row exclusive mode;
  if exists (
    select 1 from public.trend_feature_snapshots
    where analytics_run_id = trend_run.id
  ) then
    raise exception 'Expected-input manifest must be sealed before trend outputs exist';
  end if;

  select count(*), encode(digest(string_agg(concat_ws(':',
           eligible_series.id::text, eligible_series.identity_hash
         ), '||' order by eligible_series.id), 'sha256'), 'hex')
    into expected_count, expected_hash
  from public.market_series eligible_series
  join public.external_card_mappings eligible_mapping
    on eligible_mapping.id = eligible_series.mapping_id
   and eligible_mapping.source_id = eligible_series.source_id
   and eligible_mapping.variant_id = eligible_series.catalog_variant_id
  join public.catalog_variants eligible_variant
    on eligible_variant.id = eligible_series.catalog_variant_id
  join public.catalog_cards eligible_card on eligible_card.id = eligible_variant.card_id
  join public.catalog_sets eligible_set on eligible_set.id = eligible_card.set_id
  where eligible_set.game = policy->>'game'
    and eligible_series.source_id = policy_source_id
    and eligible_series.mapping_version = trend_run.mapping_version
    and eligible_series.currency = policy->>'currency'
    and eligible_series.language = policy->>'language'
    and eligible_series.condition_class = policy->>'conditionClass'
    and eligible_series.market_condition = policy->>'marketCondition'
    and eligible_series.price_semantics = policy->>'priceSemantics'
    and eligible_series.finish in (
      select jsonb_array_elements_text(policy->'finishes')
    )
    and eligible_mapping.review_status = 'approved'
    and eligible_mapping.mapping_confidence >= 0.98
    and eligible_mapping.superseded_at is null
    and exists (
      select 1
      from public.price_observations observation
      where observation.market_series_id = eligible_series.id
        and observation.observation_status = 'accepted'
        and observation.observed_at <= trend_run.feature_cutoff
        and observation.available_at <= trend_run.feature_cutoff
        and observation.observed_at >= trend_run.feature_cutoff
              - maximum_feature_age_hours * interval '1 hour'
    );
  if expected_count = 0 or expected_hash is null then
    raise exception 'Expected-input manifest found no independently eligible exact series';
  end if;

  policy_hash := encode(digest(policy::text, 'sha256'), 'hex');
  generated_manifest_hash := encode(digest(concat_ws('|',
    manifest_id::text, trend_run.id::text, trend_run.feature_cutoff::text,
    trend_run.mapping_version, policy_hash, expected_count::text, expected_hash,
    database_sealed_at::text
  ), 'sha256'), 'hex');
  insert into public.trend_expected_input_manifests (
    id, trend_analytics_run_id, feature_cutoff, selection_policy,
    selection_policy_hash, expected_series_count, expected_series_hash,
    sealed_at, manifest_hash, created_at
  ) values (
    manifest_id, trend_run.id, trend_run.feature_cutoff, policy,
    policy_hash, expected_count, expected_hash, database_sealed_at,
    generated_manifest_hash, database_sealed_at
  );
  return manifest_id;
end;
$$;

-- The one allowed writer creates the run, deterministic universe, cost record
-- for every member, and every prediction atomically. It accepts no origin,
-- created timestamp, evidence mode, universe ID, or lineage hash from callers.
create or replace function public.record_prospective_forecast_run(
  requested_run jsonb,
  requested_candidates jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recorded_origin timestamptz := clock_timestamp();
  run_id uuid := gen_random_uuid();
  universe_id uuid := gen_random_uuid();
  forecast_run public.analytics_runs%rowtype;
  trend_run public.analytics_runs%rowtype;
  model public.model_versions%rowtype;
  input_manifest public.trend_expected_input_manifests%rowtype;
  snapshot public.trend_feature_snapshots%rowtype;
  series public.market_series%rowtype;
  terms public.source_terms_reviews%rowtype;
  quote_series public.market_series%rowtype;
  quote_terms public.source_terms_reviews%rowtype;
  candidate jsonb;
  quote jsonb;
  policy jsonb;
  purpose text;
  policy_source_id uuid;
  horizon integer;
  minimum_evidence numeric;
  maximum_feature_age_hours numeric;
  maximum_quote_age_hours numeric;
  expected_count integer;
  supplied_count integer;
  actual_snapshot_count bigint;
  actual_series_count bigint;
  actual_series_hash text;
  selection_ordinal integer := 0;
  member_id uuid;
  prediction_id uuid;
  prediction_reasons text[];
  q10 numeric;
  q25 numeric;
  q50 numeric;
  q75 numeric;
  q90 numeric;
  probability_up numeric;
  confidence numeric;
  quote_observed_at timestamptz;
  policy_hash text;
  submission_hash text;
  universe_hash text;
  generated_run_hash text;
  generated_quote_hash text;
  generated_prediction_hash text;
begin
  if requested_run is null
     or not (requested_run ?& array[
       'analyticsRunId','trendAnalyticsRunId','modelVersionId','horizonDays',
       'purpose','selectionPolicy'
     ])
     or requested_run - array[
       'analyticsRunId','trendAnalyticsRunId','modelVersionId','horizonDays',
       'purpose','selectionPolicy'
     ] <> '{}'::jsonb then
    raise exception 'Prospective run accepts only preregistered run, model, horizon, purpose, and policy identifiers';
  end if;
  if jsonb_typeof(requested_candidates) <> 'array'
     or jsonb_array_length(requested_candidates) = 0
     or jsonb_array_length(requested_candidates) > 10000 then
    raise exception 'Prospective candidates must be a bounded non-empty array';
  end if;

  select * into forecast_run from public.analytics_runs
  where id = (requested_run->>'analyticsRunId')::uuid;
  select * into trend_run from public.analytics_runs
  where id = (requested_run->>'trendAnalyticsRunId')::uuid;
  select * into model from public.model_versions
  where id = (requested_run->>'modelVersionId')::uuid;
  horizon := (requested_run->>'horizonDays')::integer;
  purpose := requested_run->>'purpose';
  policy := requested_run->'selectionPolicy';

  if forecast_run.id is null or forecast_run.run_kind <> 'forecast_build'
     or forecast_run.status <> 'succeeded'
     or forecast_run.created_at > recorded_origin
     or forecast_run.completed_at > recorded_origin
     or forecast_run.dataset_hash is null then
    raise exception 'Prospective capture requires a completed immutable forecast-build run';
  end if;
  if trend_run.id is null or trend_run.run_kind <> 'trend_build'
     or trend_run.status <> 'succeeded'
     or trend_run.created_at > recorded_origin
     or trend_run.completed_at > recorded_origin
     or trend_run.dataset_hash is null then
    raise exception 'Prospective capture requires a completed immutable trend-build run';
  end if;
  if model.id is null or model.model_family <> 'quantile_return_forecast'
     or model.model_artifact_hash is null
     or model.created_at > recorded_origin
     or model.trained_through is null or model.trained_through > recorded_origin
     or not (horizon = any(model.allowed_horizons))
     or horizon not in (30,90) then
    raise exception 'Prospective capture requires a matured 30/90-day quantile model artifact';
  end if;
  if forecast_run.feature_version <> model.feature_version
     or forecast_run.mapping_version <> model.mapping_version
     or forecast_run.code_version <> model.code_version
     or trend_run.feature_version <> model.feature_version
     or trend_run.mapping_version <> model.mapping_version
     or trend_run.code_version <> model.code_version
     or trend_run.source_policy_hash <> forecast_run.source_policy_hash then
    raise exception 'Forecast run and immutable model artifact lineage differ';
  end if;
  if forecast_run.config->'candidateUniversePolicy' is distinct from policy then
    raise exception 'Candidate universe policy was not preregistered in the immutable forecast run';
  end if;
  if trend_run.config->'candidateUniversePolicy' is distinct from policy then
    raise exception 'Trend and forecast runs must share one preregistered candidate universe policy';
  end if;

  if jsonb_typeof(policy) <> 'object'
     or not (policy ?& array[
       'version','cohortKey','game','sourceId','currency','language','conditionClass',
       'marketCondition','priceSemantics','finishes','minimumEvidenceQuality','purpose',
       'maximumFeatureAgeHours','maximumQuoteAgeHours'
     ])
     or policy - array[
       'version','cohortKey','game','sourceId','currency','language','conditionClass',
       'marketCondition','priceSemantics','finishes','minimumEvidenceQuality','purpose',
       'maximumFeatureAgeHours','maximumQuoteAgeHours'
     ] <> '{}'::jsonb
     or jsonb_typeof(policy->'finishes') <> 'array'
     or jsonb_array_length(policy->'finishes') = 0
     or jsonb_typeof(policy->'minimumEvidenceQuality') <> 'number'
     or jsonb_typeof(policy->'maximumFeatureAgeHours') <> 'number'
     or jsonb_typeof(policy->'maximumQuoteAgeHours') <> 'number'
     or exists (
       select 1 from jsonb_array_elements(policy->'finishes') value
       where jsonb_typeof(value) <> 'string'
          or trim(both '"' from value::text) !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     ) then
    raise exception 'Candidate universe policy is incomplete or malformed';
  end if;

  policy_source_id := (policy->>'sourceId')::uuid;
  minimum_evidence := (policy->>'minimumEvidenceQuality')::numeric;
  maximum_feature_age_hours := (policy->>'maximumFeatureAgeHours')::numeric;
  maximum_quote_age_hours := (policy->>'maximumQuoteAgeHours')::numeric;
  if coalesce(purpose, '') not in ('forecast_validation','after_cost_opportunity')
     or policy->>'purpose' is distinct from purpose
     or policy->>'game' is distinct from 'pokemon'
     or policy->>'cohortKey' is distinct from 'pokemon-en-raw-nm'
     or policy->>'currency' is distinct from 'USD'
     or policy->>'language' is distinct from 'en'
     or policy->>'conditionClass' is distinct from 'raw'
     or policy->>'marketCondition' is distinct from 'near-mint'
     or policy->>'priceSemantics' is distinct from 'market'
     or minimum_evidence < 0.55 or minimum_evidence > 1
     or maximum_feature_age_hours <= 0 or maximum_feature_age_hours > 168
     or maximum_quote_age_hours <= 0 or maximum_quote_age_hours > 168
     or nullif(btrim(policy->>'version'), '') is null
     or nullif(btrim(policy->>'cohortKey'), '') is null then
    raise exception 'Prospective v1 is restricted to the preregistered Pokémon English raw Near Mint USD pilot';
  end if;
  if trend_run.feature_cutoff is null
     or trend_run.feature_cutoff > recorded_origin
     or trend_run.feature_cutoff < recorded_origin
          - maximum_feature_age_hours * interval '1 hour'
     or forecast_run.feature_cutoff is distinct from trend_run.feature_cutoff
     or exists (
       select 1 from public.trend_feature_snapshots run_snapshot
       where run_snapshot.analytics_run_id = trend_run.id
         and (
           run_snapshot.feature_cutoff is distinct from trend_run.feature_cutoff
           or run_snapshot.created_at > trend_run.completed_at
         )
     ) then
    raise exception 'Prospective features must come from one fresh completed point-in-time trend run';
  end if;

  policy_hash := encode(digest(policy::text, 'sha256'), 'hex');
  select * into input_manifest
  from public.trend_expected_input_manifests
  where trend_analytics_run_id = trend_run.id;
  if input_manifest.id is null
     or input_manifest.feature_cutoff <> trend_run.feature_cutoff
     or input_manifest.selection_policy is distinct from policy
     or input_manifest.selection_policy_hash <> policy_hash
     or input_manifest.sealed_at > trend_run.completed_at then
    raise exception 'Prospective capture requires an independent pre-execution input manifest';
  end if;
  select count(*) into actual_snapshot_count
  from public.trend_feature_snapshots
  where analytics_run_id = trend_run.id;
  select count(*), encode(digest(string_agg(concat_ws(':',
           actual_series.id::text, actual_series.identity_hash
         ), '||' order by actual_series.id), 'sha256'), 'hex')
    into actual_series_count, actual_series_hash
  from public.trend_feature_snapshots actual_snapshot
  join public.market_series actual_series
    on actual_series.id = actual_snapshot.market_series_id
  where actual_snapshot.analytics_run_id = trend_run.id;
  if actual_snapshot_count <> input_manifest.expected_series_count
     or actual_series_count <> input_manifest.expected_series_count
     or actual_series_hash <> input_manifest.expected_series_hash
     or trend_run.records_written <> input_manifest.expected_series_count then
    raise exception 'Succeeded trend run does not match its independently sealed exact-series input manifest';
  end if;

  select count(*) into expected_count
  from public.trend_feature_snapshots candidate_snapshot
  join public.market_series candidate_series
    on candidate_series.id = candidate_snapshot.market_series_id
  join public.catalog_variants candidate_variant
    on candidate_variant.id = candidate_series.catalog_variant_id
  join public.catalog_cards candidate_card
    on candidate_card.id = candidate_variant.card_id
  join public.catalog_sets candidate_set
    on candidate_set.id = candidate_card.set_id
  where candidate_snapshot.analytics_run_id = trend_run.id
    and candidate_set.game = policy->>'game'
    and candidate_snapshot.source_id = policy_source_id
    and candidate_series.source_id = policy_source_id
    and candidate_series.currency = policy->>'currency'
    and candidate_series.language = policy->>'language'
    and candidate_series.condition_class = policy->>'conditionClass'
    and candidate_series.market_condition = policy->>'marketCondition'
    and candidate_series.price_semantics = policy->>'priceSemantics'
    and candidate_series.finish in (
      select jsonb_array_elements_text(policy->'finishes')
    )
    and candidate_snapshot.evidence_quality >= minimum_evidence;
  supplied_count := jsonb_array_length(requested_candidates);
  if expected_count = 0
     or supplied_count <> expected_count
     or forecast_run.records_written <> expected_count then
    raise exception 'Supplied predictions do not cover the complete deterministic candidate universe';
  end if;
  if exists (
    select 1 from jsonb_array_elements(requested_candidates) item
    where jsonb_typeof(item) <> 'object'
       or not (item ?& array[
         'trendSnapshotId','q10','q25','q50','q75','q90','probabilityUp',
         'confidence','predictionStatus','reasonCodes','costQuote'
       ])
       or item - array[
         'trendSnapshotId','q10','q25','q50','q75','q90','probabilityUp',
         'confidence','predictionStatus','reasonCodes','costQuote'
       ] <> '{}'::jsonb
  ) then
    raise exception 'Prospective candidate payload contains caller-controlled lineage or unsupported fields';
  end if;
  if (
    select count(distinct item->>'trendSnapshotId')
    from jsonb_array_elements(requested_candidates) item
  ) <> supplied_count then
    raise exception 'Prospective candidate payload contains duplicate trend snapshots';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(requested_candidates) item
    left join public.trend_feature_snapshots candidate_snapshot
      on candidate_snapshot.id = (item->>'trendSnapshotId')::uuid
    left join public.market_series candidate_series
      on candidate_series.id = candidate_snapshot.market_series_id
    where candidate_snapshot.id is null
       or candidate_snapshot.analytics_run_id <> trend_run.id
       or candidate_snapshot.source_id <> policy_source_id
       or candidate_series.source_id <> policy_source_id
       or not exists (
         select 1
         from public.catalog_variants candidate_variant
         join public.catalog_cards candidate_card on candidate_card.id = candidate_variant.card_id
         join public.catalog_sets candidate_set on candidate_set.id = candidate_card.set_id
         where candidate_variant.id = candidate_series.catalog_variant_id
           and candidate_set.game = policy->>'game'
       )
       or candidate_series.currency <> policy->>'currency'
       or candidate_series.language <> policy->>'language'
       or candidate_series.condition_class <> policy->>'conditionClass'
       or candidate_series.market_condition <> policy->>'marketCondition'
       or candidate_series.price_semantics <> policy->>'priceSemantics'
       or not (candidate_series.finish in (
         select jsonb_array_elements_text(policy->'finishes')
       ))
       or candidate_snapshot.evidence_quality < minimum_evidence
  ) then
    raise exception 'Prospective candidate payload is not the preregistered exact-series universe';
  end if;

  submission_hash := encode(digest(requested_candidates::text, 'sha256'), 'hex');
  select encode(digest(concat_ws('|',
    trend_run.id::text, trend_run.dataset_hash, policy_hash,
    string_agg(concat_ws(':',
      candidate_series.identity_hash,
      candidate_snapshot.id::text,
      candidate_snapshot.snapshot_hash,
      candidate_snapshot.terms_review_id::text,
      candidate_snapshot.evidence_quality::text
    ), '||' order by candidate_series.identity_hash, candidate_snapshot.id)
  ), 'sha256'), 'hex') into universe_hash
  from public.trend_feature_snapshots candidate_snapshot
  join public.market_series candidate_series
    on candidate_series.id = candidate_snapshot.market_series_id
  join public.catalog_variants candidate_variant
    on candidate_variant.id = candidate_series.catalog_variant_id
  join public.catalog_cards candidate_card
    on candidate_card.id = candidate_variant.card_id
  join public.catalog_sets candidate_set
    on candidate_set.id = candidate_card.set_id
  where candidate_snapshot.analytics_run_id = trend_run.id
    and candidate_set.game = policy->>'game'
    and candidate_snapshot.source_id = policy_source_id
    and candidate_series.source_id = policy_source_id
    and candidate_series.currency = policy->>'currency'
    and candidate_series.language = policy->>'language'
    and candidate_series.condition_class = policy->>'conditionClass'
    and candidate_series.market_condition = policy->>'marketCondition'
    and candidate_series.price_semantics = policy->>'priceSemantics'
    and candidate_series.finish in (
      select jsonb_array_elements_text(policy->'finishes')
    )
    and candidate_snapshot.evidence_quality >= minimum_evidence;

  generated_run_hash := encode(digest(concat_ws('|',
    run_id::text, forecast_run.id::text, trend_run.id::text, model.id::text,
    input_manifest.id::text, input_manifest.manifest_hash,
    recorded_origin::text, horizon::text, model.model_artifact_hash,
    trend_run.dataset_hash, forecast_run.dataset_hash,
    forecast_run.source_policy_hash, policy_hash, universe_hash, submission_hash
  ), 'sha256'), 'hex');

  insert into public.prospective_forecast_runs (
    id, analytics_run_id, trend_analytics_run_id, input_manifest_id,
    input_manifest_hash, model_version_id, origin,
    horizon_days, matures_at, model_artifact_hash, feature_dataset_hash,
    forecast_dataset_hash, source_policy_hash, feature_version, mapping_version,
    code_version, submission_hash, run_hash, created_at
  ) values (
    run_id, forecast_run.id, trend_run.id, input_manifest.id,
    input_manifest.manifest_hash, model.id, recorded_origin,
    horizon, recorded_origin + make_interval(days => horizon),
    model.model_artifact_hash, trend_run.dataset_hash, forecast_run.dataset_hash,
    forecast_run.source_policy_hash, model.feature_version, model.mapping_version,
    model.code_version, submission_hash, generated_run_hash, recorded_origin
  );
  insert into public.prospective_candidate_universes (
    id, prospective_run_id, purpose, selection_policy, selection_policy_hash,
    candidate_count, universe_snapshot_hash, sealed_at, created_at
  ) values (
    universe_id, run_id, purpose, policy, policy_hash, expected_count,
    universe_hash, recorded_origin, recorded_origin
  );

  perform set_config('collectfolio.recording_prospective_forecast', 'on', true);

  for candidate in
    select item
    from jsonb_array_elements(requested_candidates) item
    join public.trend_feature_snapshots ordered_snapshot
      on ordered_snapshot.id = (item->>'trendSnapshotId')::uuid
    join public.market_series ordered_series
      on ordered_series.id = ordered_snapshot.market_series_id
    order by ordered_series.identity_hash, ordered_snapshot.id
  loop
    selection_ordinal := selection_ordinal + 1;
    select * into snapshot from public.trend_feature_snapshots
      where id = (candidate->>'trendSnapshotId')::uuid;
    select * into series from public.market_series where id = snapshot.market_series_id;
    select * into terms from public.source_terms_reviews where id = snapshot.terms_review_id;

    if snapshot.feature_cutoff is distinct from trend_run.feature_cutoff
       or snapshot.feature_cutoff > recorded_origin
       or snapshot.feature_cutoff < recorded_origin
            - maximum_feature_age_hours * interval '1 hour'
       or snapshot.created_at > trend_run.completed_at
       or snapshot.created_at > recorded_origin
       or snapshot.market_series_id is null
       or series.id is null or series.catalog_variant_id <> snapshot.variant_id
       or series.source_id <> snapshot.source_id
       or not exists (
         select 1
         from public.catalog_variants candidate_variant
         join public.catalog_cards candidate_card on candidate_card.id = candidate_variant.card_id
         join public.catalog_sets candidate_set on candidate_set.id = candidate_card.set_id
         where candidate_variant.id = series.catalog_variant_id
           and candidate_set.game = 'pokemon'
       )
       or not exists (
         select 1
         from public.external_card_mappings current_mapping
         where current_mapping.id = series.mapping_id
           and current_mapping.source_id = series.source_id
           and current_mapping.variant_id = series.catalog_variant_id
           and current_mapping.review_status = 'approved'
           and current_mapping.mapping_confidence >= 0.98
           and current_mapping.superseded_at is null
       )
       or terms.id is null or terms.source_id <> snapshot.source_id
       or terms.id is distinct from (
         select current_terms_review_id from public.data_sources where id = snapshot.source_id
       )
       or terms.decision not in ('research_only','approved')
       or terms.reviewed_at > recorded_origin
       or terms.created_at > recorded_origin
       or not terms.commercial_use_allowed
       or not terms.private_forecast_modeling_allowed
       or not terms.prospective_capture_allowed
       or not terms.exact_condition_labels_allowed
       or not terms.retention_through_maturity_allowed
       or not terms.predictive_derivatives_allowed
       or (terms.expires_at is not null
         and terms.expires_at <= recorded_origin + make_interval(days => horizon)) then
      raise exception 'Candidate source rights, mapping, or point-in-time lineage is not prospectively eligible';
    end if;

    if jsonb_typeof(candidate->'reasonCodes') <> 'array'
       or exists (
         select 1 from jsonb_array_elements(candidate->'reasonCodes') reason
         where jsonb_typeof(reason) <> 'string'
            or trim(both '"' from reason::text) !~ '^[a-z0-9][a-z0-9_-]{1,79}$'
       ) then
      raise exception 'Prediction reason codes are malformed';
    end if;
    q10 := (candidate->>'q10')::numeric;
    q25 := (candidate->>'q25')::numeric;
    q50 := (candidate->>'q50')::numeric;
    q75 := (candidate->>'q75')::numeric;
    q90 := (candidate->>'q90')::numeric;
    probability_up := (candidate->>'probabilityUp')::numeric;
    confidence := (candidate->>'confidence')::numeric;
    if q10 <= 0 or q10 > q25 or q25 > q50 or q50 > q75 or q75 > q90
       or probability_up < 0 or probability_up > 1
       or confidence < 0 or confidence > 100
       or candidate->>'predictionStatus' not in ('research_only','quarantined') then
      raise exception 'Prospective prediction values are invalid';
    end if;
    select array_agg(code order by code) into prediction_reasons
    from (
      select jsonb_array_elements_text(candidate->'reasonCodes') as code
      union select 'operator_model_review_required'
      union select 'private_prospective_shadow'
      union select 'public_forecast_disabled'
    ) required_codes;

    insert into public.prospective_candidate_universe_members (
      candidate_universe_id, prospective_run_id, market_series_id,
      trend_snapshot_id, source_id, terms_review_id, selection_ordinal,
      evidence_quality, trend_snapshot_hash, created_at
    ) values (
      universe_id, run_id, series.id, snapshot.id, snapshot.source_id,
      snapshot.terms_review_id, selection_ordinal, snapshot.evidence_quality,
      snapshot.snapshot_hash, recorded_origin
    ) returning id into member_id;

    quote := candidate->'costQuote';
    quote_series := null;
    quote_terms := null;
    if jsonb_typeof(quote) <> 'object' or quote->>'status' not in ('complete','unavailable') then
      raise exception 'Every prospective candidate requires an origin-time cost-quote state';
    end if;
    if quote->>'status' = 'unavailable' then
      if purpose <> 'forecast_validation'
         or not (quote ?& array['status','semantics','unavailableReason'])
         or quote - array['status','semantics','unavailableReason'] <> '{}'::jsonb
         or quote->>'semantics' <> 'unavailable'
         or nullif(btrim(quote->>'unavailableReason'), '') is null then
        raise exception 'After-cost universes require complete cost and liquidity evidence';
      end if;
      generated_quote_hash := encode(digest(concat_ws('|',
        member_id::text, universe_id::text, run_id::text, recorded_origin::text,
        series.currency, 'unavailable', quote->>'unavailableReason'
      ), 'sha256'), 'hex');
      insert into public.prospective_acquisition_cost_quotes (
        candidate_member_id, candidate_universe_id, prospective_run_id,
        quote_status, quote_semantics, captured_at, currency, liquidity_status,
        unavailable_reason, quote_hash, created_at
      ) values (
        member_id, universe_id, run_id, 'unavailable', 'unavailable',
        recorded_origin, series.currency, 'unavailable',
        btrim(quote->>'unavailableReason'), generated_quote_hash, recorded_origin
      );
    else
      if not (quote ?& array[
        'status','semantics','observedAt','evidenceHash','offerPrice','taxRate',
        'buyShipping','sellFeeRate','sellFeeFixed','sellShipping',
        'liquidityStatus','liquidityHaircutRate','liquidityEvidenceHash'
      ]) then
        raise exception 'Complete cost quotes require every acquisition, exit, and liquidity field';
      end if;
      if quote->>'semantics' = 'provider_listing' then
        if not (quote ?& array[
          'quoteMarketSeriesId','termsReviewId','externalQuoteId'
        ])
           or quote - array[
             'status','semantics','observedAt','evidenceHash','offerPrice','taxRate',
             'buyShipping','sellFeeRate','sellFeeFixed','sellShipping',
             'liquidityStatus','liquidityHaircutRate','liquidityEvidenceHash',
             'quoteMarketSeriesId','termsReviewId','externalQuoteId'
           ] <> '{}'::jsonb then
          raise exception 'Provider cost quotes require exact-series and immutable source lineage';
        end if;
        select * into quote_series from public.market_series
          where id = (quote->>'quoteMarketSeriesId')::uuid;
        select * into quote_terms from public.source_terms_reviews
          where id = (quote->>'termsReviewId')::uuid;
        if quote_series.id is null
           or quote_series.catalog_variant_id <> series.catalog_variant_id
           or quote_series.currency <> series.currency
           or quote_series.language <> series.language
           or quote_series.finish <> series.finish
           or quote_series.condition_class <> series.condition_class
           or quote_series.market_condition <> series.market_condition
           or not exists (
             select 1
             from public.external_card_mappings current_quote_mapping
             where current_quote_mapping.id = quote_series.mapping_id
               and current_quote_mapping.source_id = quote_series.source_id
               and current_quote_mapping.variant_id = quote_series.catalog_variant_id
               and current_quote_mapping.review_status = 'approved'
               and current_quote_mapping.mapping_confidence >= 0.98
               and current_quote_mapping.superseded_at is null
           )
           or quote_terms.id is null or quote_terms.source_id <> quote_series.source_id
           or quote_terms.id is distinct from (
             select current_terms_review_id from public.data_sources
             where id = quote_series.source_id
           )
           or quote_terms.decision not in ('research_only','approved')
           or quote_terms.reviewed_at > recorded_origin
           or quote_terms.created_at > recorded_origin
           or not quote_terms.commercial_use_allowed
           or not quote_terms.prospective_capture_allowed
           or not quote_terms.retention_through_maturity_allowed
           or not quote_terms.predictive_derivatives_allowed
           or (
             quote->>'liquidityStatus' = 'source_backed'
             and not quote_terms.liquidity_derivation_allowed
           )
           or (quote_terms.expires_at is not null
             and quote_terms.expires_at
               <= recorded_origin + make_interval(days => horizon)) then
          raise exception 'Provider quote does not have current exact-series prospective rights';
        end if;
      elsif quote->>'semantics' = 'user_entered_offer' then
        if quote - array[
          'status','semantics','observedAt','evidenceHash','offerPrice','taxRate',
          'buyShipping','sellFeeRate','sellFeeFixed','sellShipping',
           'liquidityStatus','liquidityHaircutRate','liquidityEvidenceHash'
        ] <> '{}'::jsonb
           or quote->>'liquidityStatus' <> 'unknown'
           or jsonb_typeof(quote->'liquidityHaircutRate') <> 'null'
           or jsonb_typeof(quote->'liquidityEvidenceHash') <> 'null' then
          raise exception 'User-entered cost quotes cannot claim provider lineage or source-backed liquidity';
        end if;
      else
        raise exception 'Complete cost quote semantics are unsupported';
      end if;

      quote_observed_at := (quote->>'observedAt')::timestamptz;
      if quote_observed_at > recorded_origin
         or quote_observed_at < recorded_origin
              - maximum_quote_age_hours * interval '1 hour'
         or (quote->>'offerPrice')::numeric <= 0
         or (quote->>'taxRate')::numeric < 0 or (quote->>'taxRate')::numeric > 1
         or (quote->>'buyShipping')::numeric < 0
         or (quote->>'sellFeeRate')::numeric < 0
         or (quote->>'sellFeeRate')::numeric >= 1
         or (quote->>'sellFeeFixed')::numeric < 0
         or (quote->>'sellShipping')::numeric < 0
         or quote->>'evidenceHash' !~ '^[0-9a-f]{64}$'
         or quote->>'liquidityStatus' not in ('source_backed','unknown')
         or (
           quote->>'liquidityStatus' = 'source_backed'
           and (
             (quote->>'liquidityHaircutRate')::numeric < 0
             or (quote->>'liquidityHaircutRate')::numeric >= 1
             or quote->>'liquidityEvidenceHash' !~ '^[0-9a-f]{64}$'
           )
         )
         or (
           quote->>'liquidityStatus' = 'unknown'
           and (
             jsonb_typeof(quote->'liquidityHaircutRate') <> 'null'
             or jsonb_typeof(quote->'liquidityEvidenceHash') <> 'null'
           )
         )
         or (
           purpose = 'after_cost_opportunity'
           and (
             quote->>'semantics' <> 'provider_listing'
             or quote->>'liquidityStatus' <> 'source_backed'
           )
         ) then
        raise exception 'Cost quote is stale, incomplete, or lacks required liquidity evidence';
      end if;

      generated_quote_hash := encode(digest(concat_ws('|',
        member_id::text, universe_id::text, run_id::text, quote->>'semantics',
        coalesce(quote_series.id::text, ''), coalesce(quote_terms.id::text, ''),
        coalesce(quote->>'externalQuoteId', ''), quote_observed_at::text,
        recorded_origin::text, series.currency, quote->>'offerPrice', quote->>'taxRate',
        quote->>'buyShipping', quote->>'sellFeeRate', quote->>'sellFeeFixed',
        quote->>'sellShipping', quote->>'liquidityStatus',
        coalesce(quote->>'liquidityHaircutRate', ''), quote->>'evidenceHash',
        coalesce(quote->>'liquidityEvidenceHash', '')
      ), 'sha256'), 'hex');
      insert into public.prospective_acquisition_cost_quotes (
        candidate_member_id, candidate_universe_id, prospective_run_id,
        quote_status, quote_semantics, quote_market_series_id, quote_source_id,
        quote_terms_review_id, external_quote_id, quote_observed_at, captured_at,
        currency, offer_price, tax_rate, buy_shipping, sell_fee_rate,
        sell_fee_fixed, sell_shipping, liquidity_status, liquidity_haircut_rate,
        quote_evidence_hash, liquidity_evidence_hash, quote_hash, created_at
      ) values (
        member_id, universe_id, run_id, 'complete', quote->>'semantics',
        quote_series.id, quote_series.source_id, quote_terms.id,
        nullif(quote->>'externalQuoteId', ''), quote_observed_at, recorded_origin,
        series.currency, (quote->>'offerPrice')::numeric,
        (quote->>'taxRate')::numeric, (quote->>'buyShipping')::numeric,
        (quote->>'sellFeeRate')::numeric, (quote->>'sellFeeFixed')::numeric,
        (quote->>'sellShipping')::numeric, quote->>'liquidityStatus',
        (quote->>'liquidityHaircutRate')::numeric,
        quote->>'evidenceHash', quote->>'liquidityEvidenceHash',
        generated_quote_hash, recorded_origin
      );
    end if;

    prediction_id := gen_random_uuid();
    generated_prediction_hash := encode(digest(concat_ws('|',
      prediction_id::text, run_id::text, universe_id::text, member_id::text,
      model.id::text, snapshot.id::text, series.id::text, recorded_origin::text,
      horizon::text, snapshot.price_current::text, q10::text, q25::text,
      q50::text, q75::text, q90::text, probability_up::text, confidence::text,
      candidate->>'predictionStatus', array_to_string(prediction_reasons, ','),
      trend_run.dataset_hash, model.model_artifact_hash
    ), 'sha256'), 'hex');
    insert into public.card_forecast_predictions (
      id, analytics_run_id, model_version_id, trend_snapshot_id, variant_id,
      source_id, terms_review_id, origin, feature_cutoff, horizon_days, matures_at,
      currency, current_price, q10, q25, q50, q75, q90, probability_up,
      confidence, prediction_status, reason_codes, dataset_hash, feature_version,
      mapping_version, code_version, prediction_hash, created_at, market_series_id,
      evidence_mode, prospective_run_id, candidate_universe_id,
      prospective_candidate_member_id
    ) values (
      prediction_id, forecast_run.id, model.id, snapshot.id, snapshot.variant_id,
      snapshot.source_id, snapshot.terms_review_id, recorded_origin,
      snapshot.feature_cutoff, horizon,
      recorded_origin + make_interval(days => horizon), series.currency,
      snapshot.price_current, q10, q25, q50, q75, q90, probability_up,
      confidence, candidate->>'predictionStatus', prediction_reasons,
      trend_run.dataset_hash, model.feature_version, model.mapping_version,
      model.code_version, generated_prediction_hash, recorded_origin, series.id,
      'prospective', run_id, universe_id, member_id
    );
  end loop;

  if selection_ordinal <> expected_count
     or (select count(*) from public.prospective_candidate_universe_members
         where candidate_universe_id = universe_id) <> expected_count
     or (select count(*) from public.prospective_acquisition_cost_quotes
         where candidate_universe_id = universe_id) <> expected_count
     or (select count(*) from public.card_forecast_predictions
         where candidate_universe_id = universe_id) <> expected_count then
    raise exception 'Atomic prospective packet is incomplete';
  end if;
  if clock_timestamp() > recorded_origin + interval '5 minutes' then
    raise exception 'Prospective packet exceeded the database-enforced recording window';
  end if;
  return run_id;
end;
$$;

-- For prospective rows, the database overwrites both evaluation timestamps and
-- seals the RPC-derived outcome hash again with that database-authored instant.
-- Retrospective evaluation behavior from 0016 remains unchanged.
create or replace function public.validate_forecast_evaluation_lineage()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  prediction_mode text;
  prediction_maturity timestamptz;
  prediction_series uuid;
  candidate_member uuid;
  evaluation_run_kind text;
  evaluation_run_status text;
  evaluation_run_cutoff timestamptz;
  evaluation_run_completed_at timestamptz;
  requested_evaluated_at timestamptz;
  database_evaluated_at timestamptz;
begin
  requested_evaluated_at := new.evaluated_at;
  select evidence_mode, matures_at, market_series_id,
         prospective_candidate_member_id
    into prediction_mode, prediction_maturity, prediction_series,
         candidate_member
  from public.card_forecast_predictions where id = new.prediction_id;
  if prediction_maturity is null or prediction_maturity <> new.maturity then
    raise exception 'Forecast evaluation maturity does not match its prediction';
  end if;
  if new.evidence_mode <> prediction_mode then
    raise exception 'Prediction and evaluation evidence modes differ';
  end if;

  select run_kind, status, feature_cutoff, completed_at
    into evaluation_run_kind, evaluation_run_status, evaluation_run_cutoff,
         evaluation_run_completed_at
  from public.analytics_runs where id = new.analytics_run_id
  for share;

  if prediction_mode = 'prospective' then
    database_evaluated_at := clock_timestamp();
    if exists (
      select 1 from public.model_scorecards scorecard
      where scorecard.analytics_run_id = new.analytics_run_id
    ) then
      raise exception 'Prospective evaluation run is frozen after scorecard creation';
    end if;
    if candidate_member is null
       or prediction_series is null
       or database_evaluated_at < prediction_maturity then
      raise exception 'Prospective evaluation requires actual database-time maturity and sealed candidate lineage';
    end if;
    if evaluation_run_kind <> 'forecast_evaluation'
       or evaluation_run_status <> 'succeeded'
       or evaluation_run_cutoff is distinct from requested_evaluated_at
       or evaluation_run_completed_at is distinct from requested_evaluated_at
       or evaluation_run_completed_at < prediction_maturity
       or evaluation_run_completed_at > database_evaluated_at
       or evaluation_run_completed_at
            < database_evaluated_at - interval '5 minutes' then
      raise exception 'Prospective evaluation requires a fresh succeeded point-in-time evaluation run';
    end if;
    new.evaluated_at := database_evaluated_at;
    new.created_at := database_evaluated_at;
    new.evaluation_hash := encode(digest(concat_ws('|',
      new.evaluation_hash, database_evaluated_at::text
    ), 'sha256'), 'hex');
  else
    if new.evaluated_at < prediction_maturity then
      raise exception 'Forecast evaluation timing does not match its prediction';
    end if;
    if evaluation_run_kind <> 'forecast_evaluation'
       or evaluation_run_status not in ('succeeded','partial')
       or evaluation_run_cutoff is distinct from new.evaluated_at
       or evaluation_run_completed_at is distinct from new.evaluated_at then
      raise exception 'Forecast evaluation must belong to its completed point-in-time evaluation run';
    end if;
  end if;
  if new.evaluation_status = 'scored' and prediction_series is not null
     and coalesce(current_setting('collectfolio.recording_scored_evaluation', true), '') <> 'on' then
    raise exception 'Insert immutable target-observation membership before recording a scored exact-series evaluation';
  end if;
  return new;
end;
$$;

-- Keep 0016's model_scorecards evidence-mode constraint retrospective-only.
-- A future guarded RPC must derive prospective scope, membership, hashes, and
-- metrics atomically before prospective scorecards can exist.

-- Every prospective table is immutable and private. Service workers may read
-- receipts, but only the guarded security-definer RPC may create them.
create trigger trend_expected_input_manifests_append_only
  before update or delete on public.trend_expected_input_manifests
  for each row execute function public.reject_append_only_mutation();
create trigger prospective_forecast_runs_append_only
  before update or delete on public.prospective_forecast_runs
  for each row execute function public.reject_append_only_mutation();
create trigger prospective_candidate_universes_append_only
  before update or delete on public.prospective_candidate_universes
  for each row execute function public.reject_append_only_mutation();
create trigger prospective_candidate_members_append_only
  before update or delete on public.prospective_candidate_universe_members
  for each row execute function public.reject_append_only_mutation();
create trigger prospective_cost_quotes_append_only
  before update or delete on public.prospective_acquisition_cost_quotes
  for each row execute function public.reject_append_only_mutation();

alter table public.trend_expected_input_manifests enable row level security;
alter table public.prospective_forecast_runs enable row level security;
alter table public.prospective_candidate_universes enable row level security;
alter table public.prospective_candidate_universe_members enable row level security;
alter table public.prospective_acquisition_cost_quotes enable row level security;

revoke all on public.trend_expected_input_manifests,
  public.prospective_forecast_runs,
  public.prospective_candidate_universes,
  public.prospective_candidate_universe_members,
  public.prospective_acquisition_cost_quotes
  from public, anon, authenticated, service_role;
grant select on public.trend_expected_input_manifests,
  public.prospective_forecast_runs,
  public.prospective_candidate_universes,
  public.prospective_candidate_universe_members,
  public.prospective_acquisition_cost_quotes
  to service_role;

revoke execute on function public.seal_trend_expected_input_manifest(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.seal_trend_expected_input_manifest(uuid)
  to service_role;
revoke execute on function public.record_prospective_forecast_run(jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_prospective_forecast_run(jsonb,jsonb)
  to service_role;
revoke execute on function public.validate_forecast_evaluation_lineage()
  from public, anon, authenticated, service_role;

do $$
begin
  if coalesce((
    select enabled from public.product_feature_flags
    where key = 'public_price_intelligence'
  ), false) then
    raise exception 'Prospective ledger must leave public_price_intelligence disabled';
  end if;
  if to_regprocedure('public.publish_forecast_intelligence(uuid)') is not null then
    raise exception 'Prospective ledger must not install a public forecast publisher';
  end if;
  if has_table_privilege('anon', 'public.trend_expected_input_manifests', 'SELECT')
     or has_table_privilege('authenticated', 'public.trend_expected_input_manifests', 'SELECT')
     or has_table_privilege('anon', 'public.prospective_forecast_runs', 'SELECT')
     or has_table_privilege('authenticated', 'public.prospective_forecast_runs', 'SELECT')
     or has_table_privilege('anon', 'public.prospective_candidate_universes', 'SELECT')
     or has_table_privilege('authenticated', 'public.prospective_candidate_universes', 'SELECT')
     or has_table_privilege('anon', 'public.prospective_acquisition_cost_quotes', 'SELECT')
     or has_table_privilege('authenticated', 'public.prospective_acquisition_cost_quotes', 'SELECT') then
    raise exception 'Prospective forecast and cost evidence must remain private';
  end if;
  if has_table_privilege('service_role', 'public.trend_expected_input_manifests', 'INSERT')
     or has_table_privilege('service_role', 'public.prospective_forecast_runs', 'INSERT')
     or has_table_privilege('service_role', 'public.prospective_candidate_universes', 'INSERT')
     or has_table_privilege('service_role', 'public.prospective_candidate_universe_members', 'INSERT')
     or has_table_privilege('service_role', 'public.prospective_acquisition_cost_quotes', 'INSERT') then
    raise exception 'Service role must create prospective evidence only through the guarded RPC';
  end if;
  if has_function_privilege('anon', 'public.record_prospective_forecast_run(jsonb,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.record_prospective_forecast_run(jsonb,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.record_prospective_forecast_run(jsonb,jsonb)', 'EXECUTE') then
    raise exception 'Prospective recording RPC ACL is incorrect';
  end if;
  if has_function_privilege('anon', 'public.seal_trend_expected_input_manifest(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.seal_trend_expected_input_manifest(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.seal_trend_expected_input_manifest(uuid)', 'EXECUTE') then
    raise exception 'Expected-input manifest RPC ACL is incorrect';
  end if;
end;
$$;

commit;
