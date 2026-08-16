-- CollectFolio Forecast Engine v1: immutable exact-market-series lineage.
--
-- This migration installs only the private evidence plane required to qualify
-- 30/90-day forecasts. It deliberately creates no Tier-4 publication RPC and
-- fails if public price intelligence is enabled. Public promotion remains a
-- later migration after prospective evidence and an independently reviewed
-- source contract exist.

begin;

do $$
begin
  if coalesce((
    select enabled from public.product_feature_flags
    where key = 'public_price_intelligence'
  ), false) then
    raise exception 'Apply Forecast Engine v1 only while public_price_intelligence is disabled';
  end if;
end;
$$;

create table public.market_series (
  id uuid primary key default gen_random_uuid(),
  catalog_variant_id uuid not null references public.catalog_variants(id) on delete restrict,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  mapping_id uuid not null,
  provider_product_id text not null check (char_length(provider_product_id) between 1 and 700),
  provider_variant_key text not null default '' check (char_length(provider_variant_key) <= 700),
  mapping_version text not null check (char_length(mapping_version) between 1 and 160),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  language text not null check (language ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  finish text not null check (finish ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  condition_class text not null check (condition_class in ('raw','graded','sealed','other')),
  market_condition text not null check (
    market_condition <> 'unspecified'
    and market_condition ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  price_semantics text not null check (price_semantics ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  identity_hash text not null unique check (identity_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (mapping_id, source_id, catalog_variant_id)
    references public.external_card_mappings(id, source_id, variant_id) on delete restrict,
  unique (
    catalog_variant_id, source_id, mapping_id, provider_product_id,
    provider_variant_key, mapping_version, currency, language, finish,
    condition_class, market_condition, price_semantics
  )
);

create or replace function public.validate_market_series_lineage()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  mapping public.external_card_mappings%rowtype;
  variant public.catalog_variants%rowtype;
  expected_hash text;
begin
  select * into mapping
  from public.external_card_mappings
  where id = new.mapping_id
    and source_id = new.source_id
    and variant_id = new.catalog_variant_id;

  if mapping.id is null
     or mapping.review_status <> 'approved'
     or mapping.mapping_confidence < 0.98
     or mapping.superseded_at is not null
     or mapping.external_product_id <> new.provider_product_id
     or mapping.external_variant_key <> new.provider_variant_key
     or mapping.mapping_version <> new.mapping_version then
    raise exception 'Market series requires the current exact approved provider mapping';
  end if;

  select * into variant
  from public.catalog_variants where id = new.catalog_variant_id;
  if variant.id is null
     or variant.language <> new.language
     or variant.finish <> new.finish
     or variant.raw_condition_class <> new.condition_class then
    raise exception 'Market series language, finish, and condition class must match the catalog variant';
  end if;

  expected_hash := encode(digest(
    concat_ws('|',
      new.catalog_variant_id::text, new.source_id::text, new.mapping_id::text,
      new.provider_product_id, new.provider_variant_key, new.mapping_version,
      new.currency, new.language, new.finish, new.condition_class,
      new.market_condition, new.price_semantics
    ), 'sha256'
  ), 'hex');
  if new.identity_hash <> expected_hash then
    raise exception 'Market-series identity hash does not match its immutable fields';
  end if;
  return new;
end;
$$;

create trigger market_series_validate_lineage
  before insert on public.market_series
  for each row execute function public.validate_market_series_lineage();
create trigger market_series_append_only
  before update or delete on public.market_series
  for each row execute function public.reject_append_only_mutation();
alter table public.market_series enable row level security;
revoke all on public.market_series from public, anon, authenticated, service_role;
grant select, insert on public.market_series to service_role;
revoke execute on function public.validate_market_series_lineage()
  from public, anon, authenticated, service_role;

alter table public.watchlist_items add column market_condition text;

alter table public.price_observations disable trigger price_observations_append_only;
alter table public.price_observations
  add column market_series_id uuid references public.market_series(id) on delete restrict;
alter table public.price_observations enable trigger price_observations_append_only;
create index price_observations_market_series_time_idx
  on public.price_observations (market_series_id, observed_at desc, available_at desc)
  where market_series_id is not null;

create or replace function public.validate_price_observation_lineage()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  mapping_status text;
  mapping_confidence numeric;
  mapping_superseded_at timestamptz;
  source_active boolean;
  source_current_review uuid;
  terms_decision text;
  terms_expiry timestamptz;
  series public.market_series%rowtype;
begin
  select review_status, external_card_mappings.mapping_confidence, superseded_at
    into mapping_status, mapping_confidence, mapping_superseded_at
  from public.external_card_mappings
  where id = new.mapping_id and source_id = new.source_id and variant_id = new.variant_id;

  if mapping_status is null then
    raise exception 'Exact source-to-variant mapping does not exist';
  end if;
  if new.observation_status <> 'quarantined'
     and (mapping_status <> 'approved' or mapping_confidence < 0.98
          or mapping_superseded_at is not null) then
    raise exception 'Accepted observations require a current approved mapping with confidence >= 0.98';
  end if;

  select source.active, source.current_terms_review_id, review.decision, review.expires_at
    into source_active, source_current_review, terms_decision, terms_expiry
  from public.data_sources source
  join public.source_terms_reviews review
    on review.id = new.terms_review_id and review.source_id = source.id
  where source.id = new.source_id;
  if not coalesce(source_active, false)
     or source_current_review is distinct from new.terms_review_id
     or terms_decision not in ('research_only','approved')
     or (terms_expiry is not null and terms_expiry <= new.ingested_at) then
    raise exception 'Observation source terms are inactive, stale, or not approved for research';
  end if;

  if new.market_series_id is not null then
    select * into series from public.market_series where id = new.market_series_id;
    if series.id is null
       or series.mapping_id <> new.mapping_id
       or series.source_id <> new.source_id
       or series.catalog_variant_id <> new.variant_id
       or series.currency <> new.currency
       or series.price_semantics <> new.price_semantics then
      raise exception 'Observation does not match its immutable market series';
    end if;
  elsif new.observation_status <> 'quarantined' then
    raise exception 'New accepted observations require market_series_id';
  end if;
  return new;
end;
$$;

alter table public.trend_feature_snapshots disable trigger trend_feature_snapshots_append_only;
alter table public.trend_feature_snapshots
  add column market_series_id uuid references public.market_series(id) on delete restrict;
do $$
declare
  legacy_unique name;
begin
  select constraint_row.conname into legacy_unique
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.trend_feature_snapshots'::regclass
    and constraint_row.contype = 'u'
    and pg_get_constraintdef(constraint_row.oid)
          = 'UNIQUE (analytics_run_id, variant_id, source_id)';
  if legacy_unique is null then
    raise exception 'Legacy trend snapshot run/variant/source uniqueness is absent';
  end if;
  execute format(
    'alter table public.trend_feature_snapshots drop constraint %I',
    legacy_unique
  );
end;
$$;
alter table public.trend_feature_snapshots enable trigger trend_feature_snapshots_append_only;
create unique index trend_feature_snapshots_market_series_run_idx
  on public.trend_feature_snapshots (analytics_run_id, market_series_id)
  where market_series_id is not null;
create unique index trend_feature_snapshots_legacy_run_idx
  on public.trend_feature_snapshots (analytics_run_id, variant_id, source_id)
  where market_series_id is null;

-- Serialize each snapshot insert with analytics-run finalization. Without this
-- guard, an append-only row could still be added after a trend run had been
-- marked succeeded, changing the supposedly frozen feature universe.
create or replace function public.guard_trend_snapshot_run_state()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  snapshot_run public.analytics_runs%rowtype;
begin
  select * into snapshot_run
  from public.analytics_runs
  where id = new.analytics_run_id
  for share;

  if not found
     or snapshot_run.run_kind <> 'trend_build'
     or snapshot_run.status <> 'running'
     or snapshot_run.completed_at is not null then
    raise exception 'Trend snapshots require a running unfinished trend_build analytics run';
  end if;
  if new.feature_cutoff is distinct from snapshot_run.feature_cutoff then
    raise exception 'Trend snapshot feature cutoff must match its analytics run';
  end if;
  return new;
end;
$$;
create trigger trend_feature_snapshots_000_guard_run
  before insert on public.trend_feature_snapshots
  for each row execute function public.guard_trend_snapshot_run_state();
revoke execute on function public.guard_trend_snapshot_run_state()
  from public, anon, authenticated, service_role;

alter table public.card_forecast_predictions disable trigger card_forecast_predictions_append_only;
alter table public.card_forecast_predictions
  add column market_series_id uuid references public.market_series(id) on delete restrict,
  add column evidence_mode text not null default 'retrospective';
do $$
declare
  legacy_unique name;
begin
  select constraint_row.conname into legacy_unique
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.card_forecast_predictions'::regclass
    and constraint_row.contype = 'u'
    and pg_get_constraintdef(constraint_row.oid)
          = 'UNIQUE (model_version_id, variant_id, origin, horizon_days)';
  if legacy_unique is null then
    raise exception 'Legacy forecast model/variant/origin/horizon uniqueness is absent';
  end if;
  execute format(
    'alter table public.card_forecast_predictions drop constraint %I',
    legacy_unique
  );
end;
$$;
alter table public.card_forecast_predictions
  add constraint card_forecast_predictions_evidence_mode_check
    check (evidence_mode = 'retrospective');
alter table public.card_forecast_predictions enable trigger card_forecast_predictions_append_only;
create unique index card_forecast_predictions_market_series_unique
  on public.card_forecast_predictions (model_version_id, market_series_id, origin, horizon_days)
  where market_series_id is not null;
create unique index card_forecast_predictions_legacy_unique
  on public.card_forecast_predictions (model_version_id, variant_id, origin, horizon_days)
  where market_series_id is null;

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
begin
  select market_series_id, variant_id, source_id
    into snapshot_series, snapshot_variant, snapshot_source
  from public.trend_feature_snapshots where id = new.trend_snapshot_id;
  if new.market_series_id is not null and (
    snapshot_series is distinct from new.market_series_id
    or snapshot_variant <> new.variant_id
    or snapshot_source <> new.source_id
  ) then
    raise exception 'Prediction and trend snapshot market series differ';
  end if;
  if new.evidence_mode <> 'retrospective' then
    raise exception 'Forecast Engine v1 cannot accept caller-declared prospective evidence';
  end if;
  return new;
end;
$$;
create trigger card_forecast_predictions_validate_series
  before insert on public.card_forecast_predictions
  for each row execute function public.validate_forecast_prediction_series();
revoke execute on function public.validate_forecast_prediction_series()
  from public, anon, authenticated, service_role;

alter table public.forecast_evaluations disable trigger forecast_evaluations_append_only;
alter table public.forecast_evaluations
  add column evidence_mode text not null default 'retrospective',
  add constraint forecast_evaluations_evidence_mode_check
    check (evidence_mode = 'retrospective');
alter table public.forecast_evaluations enable trigger forecast_evaluations_append_only;

create table public.forecast_evaluation_observations (
  evaluation_id uuid not null references public.forecast_evaluations(id) on delete restrict,
  observation_id uuid not null references public.price_observations(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (evaluation_id, observation_id)
);

create or replace function public.validate_forecast_evaluation_observation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  evaluation_status text;
  window_start timestamptz;
  window_end timestamptz;
  prediction_series uuid;
  observation_series uuid;
  observation_time timestamptz;
  observation_available timestamptz;
  observation_status text;
begin
  select evaluation.evaluation_status, evaluation.target_window_start,
         evaluation.target_window_end, prediction.market_series_id
    into evaluation_status, window_start, window_end, prediction_series
  from public.forecast_evaluations evaluation
  join public.card_forecast_predictions prediction on prediction.id = evaluation.prediction_id
  where evaluation.id = new.evaluation_id;
  select market_series_id, observed_at, available_at, price_observations.observation_status
    into observation_series, observation_time, observation_available, observation_status
  from public.price_observations where id = new.observation_id;
  if evaluation_status <> 'scored'
     or prediction_series is null
     or observation_series is distinct from prediction_series
     or observation_status <> 'accepted'
     or observation_time not between window_start and window_end
     or observation_available > window_end then
    raise exception 'Evaluation observation is not accepted same-series point-in-time label evidence';
  end if;
  return new;
end;
$$;
create trigger forecast_evaluation_observations_validate
  before insert on public.forecast_evaluation_observations
  for each row execute function public.validate_forecast_evaluation_observation();
create trigger forecast_evaluation_observations_append_only
  before update or delete on public.forecast_evaluation_observations
  for each row execute function public.reject_append_only_mutation();
alter table public.forecast_evaluation_observations enable row level security;
revoke all on public.forecast_evaluation_observations
  from public, anon, authenticated, service_role;
grant select on public.forecast_evaluation_observations to service_role;
revoke execute on function public.validate_forecast_evaluation_observation()
  from public, anon, authenticated, service_role;

create or replace function public.validate_forecast_evaluation_lineage()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  prediction_maturity timestamptz;
  prediction_mode text;
  prediction_series uuid;
  evaluation_run_kind text;
  evaluation_run_status text;
  evaluation_run_cutoff timestamptz;
  evaluation_run_completed_at timestamptz;
begin
  select matures_at, evidence_mode, market_series_id
    into prediction_maturity, prediction_mode, prediction_series
  from public.card_forecast_predictions where id = new.prediction_id;
  if prediction_maturity is null or prediction_maturity <> new.maturity
     or new.evaluated_at < prediction_maturity then
    raise exception 'Forecast evaluation timing does not match its prediction';
  end if;
  if new.evidence_mode <> prediction_mode then
    raise exception 'Prediction and evaluation evidence modes differ';
  end if;
  select run_kind, status, feature_cutoff, completed_at
    into evaluation_run_kind, evaluation_run_status, evaluation_run_cutoff,
         evaluation_run_completed_at
  from public.analytics_runs where id = new.analytics_run_id;
  if evaluation_run_kind <> 'forecast_evaluation'
     or evaluation_run_status not in ('succeeded','partial')
     or evaluation_run_cutoff is distinct from new.evaluated_at
     or evaluation_run_completed_at is distinct from new.evaluated_at then
    raise exception 'Forecast evaluation must belong to its completed point-in-time evaluation run';
  end if;
  if new.evidence_mode = 'prospective' and prediction_series is null then
    raise exception 'Prospective evaluation requires immutable market-series lineage';
  end if;
  if new.evaluation_status = 'scored' and prediction_series is not null
     and coalesce(current_setting('collectfolio.recording_scored_evaluation', true), '') <> 'on' then
    raise exception 'Insert immutable target-observation membership before recording a scored exact-series evaluation';
  end if;
  return new;
end;
$$;

-- Realized outcome fields are derived by the database, not supplied by callers.
create or replace function public.record_scored_forecast_evaluation(
  requested_evaluation jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  evaluation public.forecast_evaluations%rowtype;
  observation_id uuid;
  target_observation_ids uuid[];
  derived_price numeric;
  exact_price numeric;
  prediction public.card_forecast_predictions%rowtype;
  derived_pinball jsonb;
  derived_hash text;
  observation_count integer;
begin
  if requested_evaluation is null
     or not (requested_evaluation ?& array['id','analytics_run_id','prediction_id','evaluated_at'])
     or requested_evaluation - array['id','analytics_run_id','prediction_id','evaluated_at'] <> '{}'::jsonb then
    raise exception 'Scored evaluation accepts only identity, run, prediction, and evaluation time';
  end if;
  select * into prediction from public.card_forecast_predictions
  where id = (requested_evaluation->>'prediction_id')::uuid;
  if prediction.id is null or prediction.market_series_id is null then
    raise exception 'Scored exact-series evaluation requires an exact-series prediction';
  end if;

  select array_agg(candidate.id order by candidate.observed_at, candidate.id)
    into target_observation_ids
  from (
    select distinct on (observation.observed_at)
           observation.id, observation.observed_at
    from public.price_observations observation
    where observation.market_series_id = prediction.market_series_id
      and observation.observation_status = 'accepted'
      and observation.observed_at between prediction.matures_at - interval '6 days'
                                      and prediction.matures_at
      and observation.available_at <= prediction.matures_at
    order by observation.observed_at, observation.available_at desc, observation.id desc
  ) candidate;
  observation_count := coalesce(cardinality(target_observation_ids), 0);
  if observation_count = 0 then
    raise exception 'No canonical same-series observations exist in the maturity window';
  end if;

  select percentile_cont(0.5) within group (order by observation.market_price)
    into derived_price
  from public.price_observations observation
  where observation.id = any(target_observation_ids);
  select observation.market_price into exact_price
  from public.price_observations observation
  where observation.id = any(target_observation_ids)
    and (observation.observed_at at time zone 'UTC')::date
        = (prediction.matures_at at time zone 'UTC')::date
  order by observation.observed_at desc, observation.available_at desc, observation.id desc
  limit 1;

  derived_pinball := jsonb_build_object(
    '0.10', case when derived_price >= prediction.q10
      then 0.10 * (derived_price - prediction.q10)
      else 0.90 * (prediction.q10 - derived_price) end,
    '0.25', case when derived_price >= prediction.q25
      then 0.25 * (derived_price - prediction.q25)
      else 0.75 * (prediction.q25 - derived_price) end,
    '0.50', 0.50 * abs(derived_price - prediction.q50),
    '0.75', case when derived_price >= prediction.q75
      then 0.75 * (derived_price - prediction.q75)
      else 0.25 * (prediction.q75 - derived_price) end,
    '0.90', case when derived_price >= prediction.q90
      then 0.90 * (derived_price - prediction.q90)
      else 0.10 * (prediction.q90 - derived_price) end
  );
  derived_hash := encode(digest(concat_ws('|',
    requested_evaluation->>'id', requested_evaluation->>'analytics_run_id',
    prediction.id::text, prediction.matures_at::text,
    requested_evaluation->>'evaluated_at', derived_price::text,
    coalesce(exact_price::text, ''), observation_count::text,
    array_to_string(target_observation_ids, ',')
  ), 'sha256'), 'hex');

  perform set_config('collectfolio.recording_scored_evaluation', 'on', true);

  insert into public.forecast_evaluations (
    id, analytics_run_id, prediction_id, maturity, evaluated_at,
    evaluation_status, unscorable_reason, target_window_start, target_window_end,
    realized_price, exact_date_price, observation_count, absolute_log_error,
    absolute_percentage_error, direction_correct, brier_component,
    pinball_losses, evaluation_hash, evidence_mode
  ) values (
    (requested_evaluation->>'id')::uuid,
    (requested_evaluation->>'analytics_run_id')::uuid,
    prediction.id, prediction.matures_at,
    (requested_evaluation->>'evaluated_at')::timestamptz,
    'scored', null,
    prediction.matures_at - interval '6 days', prediction.matures_at,
    derived_price, exact_price, observation_count,
    abs(ln(prediction.q50 / derived_price)),
    abs(prediction.q50 - derived_price) / derived_price,
    (prediction.q50 >= prediction.current_price) = (derived_price >= prediction.current_price),
    power(prediction.probability_up -
      case when derived_price > prediction.current_price then 1 else 0 end, 2),
    derived_pinball,
    derived_hash,
    prediction.evidence_mode
  ) returning * into evaluation;

  foreach observation_id in array target_observation_ids loop
    insert into public.forecast_evaluation_observations (evaluation_id, observation_id)
    values (evaluation.id, observation_id);
  end loop;

  return evaluation.id;
end;
$$;

create or replace function public.record_unscorable_forecast_evaluation(
  requested_evaluation jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  evaluation_id uuid;
  prediction public.card_forecast_predictions%rowtype;
  derived_hash text;
begin
  if requested_evaluation is null
     or not (requested_evaluation ?& array['id','analytics_run_id','prediction_id','evaluated_at'])
     or requested_evaluation - array['id','analytics_run_id','prediction_id','evaluated_at'] <> '{}'::jsonb then
    raise exception 'Unscorable evaluation accepts only identity, run, prediction, and evaluation time';
  end if;
  select * into prediction from public.card_forecast_predictions
  where id = (requested_evaluation->>'prediction_id')::uuid;
  if prediction.id is null or prediction.market_series_id is null then
    raise exception 'Unscorable exact-series evaluation requires an exact-series prediction';
  end if;
  if exists (
    select 1 from public.price_observations observation
    where observation.market_series_id = prediction.market_series_id
      and observation.observation_status = 'accepted'
      and observation.observed_at between prediction.matures_at - interval '6 days'
                                      and prediction.matures_at
      and observation.available_at <= prediction.matures_at
  ) then
    raise exception 'A forecast with canonical maturity observations cannot be marked unscorable';
  end if;
  derived_hash := encode(digest(concat_ws('|',
    requested_evaluation->>'id', requested_evaluation->>'analytics_run_id',
    prediction.id::text, prediction.matures_at::text,
    requested_evaluation->>'evaluated_at', 'unscorable',
    'no_accepted_same_series_maturity_observations'
  ), 'sha256'), 'hex');

  insert into public.forecast_evaluations (
    id, analytics_run_id, prediction_id, maturity, evaluated_at,
    evaluation_status, unscorable_reason, target_window_start, target_window_end,
    realized_price, exact_date_price, observation_count, absolute_log_error,
    absolute_percentage_error, direction_correct, brier_component,
    pinball_losses, evaluation_hash, evidence_mode
  ) values (
    (requested_evaluation->>'id')::uuid,
    (requested_evaluation->>'analytics_run_id')::uuid,
    prediction.id, prediction.matures_at,
    (requested_evaluation->>'evaluated_at')::timestamptz,
    'unscorable', 'no_accepted_same_series_maturity_observations',
    prediction.matures_at - interval '6 days', prediction.matures_at,
    null, null, 0, null, null, null, null, '{}'::jsonb,
    derived_hash, prediction.evidence_mode
  ) returning id into evaluation_id;
  return evaluation_id;
end;
$$;

revoke insert on public.forecast_evaluations from service_role;
revoke execute on function public.record_scored_forecast_evaluation(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.record_unscorable_forecast_evaluation(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_scored_forecast_evaluation(jsonb)
  to service_role;
grant execute on function public.record_unscorable_forecast_evaluation(jsonb)
  to service_role;

alter table public.model_scorecards disable trigger model_scorecards_append_only;
alter table public.model_scorecards
  add column evidence_mode text not null default 'retrospective',
  add constraint model_scorecards_evidence_mode_check
    check (evidence_mode = 'retrospective');
alter table public.model_scorecards enable trigger model_scorecards_append_only;

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
  evaluation_run uuid;
  scorecard_horizon integer;
  scorecard_model uuid;
  scorecard_run uuid;
  scorecard_mode text;
  scorecard_origin_start timestamptz;
  scorecard_origin_end timestamptz;
  expected_reason_codes text[];
  target_membership_count bigint;
  stored_observation_count integer;
begin
  if exists (select 1 from public.model_promotion_reviews where scorecard_id = new.scorecard_id) then
    raise exception 'Scorecard membership is frozen after its first review';
  end if;
  select evaluation.evaluation_status, evaluation.evidence_mode, evaluation.analytics_run_id,
         evaluation.observation_count, prediction.horizon_days, prediction.model_version_id,
         prediction.prediction_status, prediction.origin, prediction.market_series_id
    into stored_status, evaluation_mode, evaluation_run, stored_observation_count,
         prediction_horizon, prediction_model, prediction_status, prediction_origin,
         prediction_series
  from public.forecast_evaluations evaluation
  join public.card_forecast_predictions prediction on prediction.id = evaluation.prediction_id
  where evaluation.id = new.evaluation_id;
  select horizon_days, model_version_id, analytics_run_id, evidence_mode,
         origin_start, origin_end
    into scorecard_horizon, scorecard_model, scorecard_run, scorecard_mode,
         scorecard_origin_start, scorecard_origin_end
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
  if scorecard_mode = 'prospective' and prediction_series is null then
    raise exception 'Prospective scorecard membership requires immutable market series';
  end if;
  if stored_status = 'scored' and prediction_series is not null then
    select count(*) into target_membership_count
    from public.forecast_evaluation_observations
    where evaluation_id = new.evaluation_id;
    if target_membership_count = 0 or target_membership_count <> stored_observation_count then
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
    when prediction_status = 'quarantined' then array['quarantined_prediction_excluded']
    when stored_status = 'unscorable' then array['unscorable_target_excluded']
    else array[]::text[]
  end;
  if not new.included_in_metrics and new.reason_codes <> expected_reason_codes then
    raise exception 'Excluded scorecard membership reason is inconsistent';
  end if;
  return new;
end;
$$;

-- Retrospective evidence can still be reviewed for research, but it cannot
-- authorize a public model. Prospective publication remains deliberately absent.
create or replace function public.validate_model_promotion_review_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  scorecard_model uuid;
  scorecard_mode text;
  recommendation text;
  policy_hash text;
  membership_hash text;
  policy jsonb;
  scorecard_metrics jsonb;
  scorecard_created_at timestamptz;
  scorecard_evaluation_count integer;
  scorecard_matured_count integer;
  scorecard_unscorable_count integer;
  scorecard_excluded_count integer;
  scorecard_run uuid;
  scorecard_horizon integer;
  scorecard_origin_start timestamptz;
  scorecard_origin_end timestamptz;
  membership_count bigint;
  expected_membership_count bigint;
  included_count bigint;
  unscorable_count bigint;
  excluded_count bigint;
  invalid_membership boolean;
begin
  select scorecard.model_version_id, scorecard.evidence_mode,
         scorecard.promotion_recommendation,
         scorecard.promotion_policy_hash, scorecard.evaluation_membership_hash,
         scorecard.promotion_policy, scorecard.metrics, scorecard.created_at,
         scorecard.evaluation_count, scorecard.matured_count,
         scorecard.unscorable_count, scorecard.excluded_count,
         scorecard.analytics_run_id, scorecard.horizon_days,
         scorecard.origin_start, scorecard.origin_end
  into scorecard_model, scorecard_mode, recommendation, policy_hash,
       membership_hash, policy, scorecard_metrics, scorecard_created_at,
       scorecard_evaluation_count, scorecard_matured_count,
       scorecard_unscorable_count, scorecard_excluded_count, scorecard_run,
       scorecard_horizon, scorecard_origin_start, scorecard_origin_end
  from public.model_scorecards scorecard
  where scorecard.id = new.scorecard_id;

  if scorecard_model is null or scorecard_model <> new.model_version_id then
    raise exception 'Promotion review model does not match its scorecard';
  end if;
  if new.created_at < scorecard_created_at then
    raise exception 'Promotion review cannot predate its scorecard';
  end if;
  if new.decision = 'approved' and scorecard_mode <> 'prospective' then
    raise exception 'Retrospective evidence cannot authorize model promotion';
  end if;
  if new.decision = 'approved' then
    if auth.uid() is null
       or new.reviewer_user_id is distinct from auth.uid()
       or coalesce(auth.jwt()->'app_metadata'->>'price_intelligence_operator', 'false') <> 'true' then
      raise exception 'Approved promotion requires the authenticated price-intelligence operator';
    end if;

    select count(*),
           count(*) filter (where membership.included_in_metrics),
           count(*) filter (
             where prediction.prediction_status = 'research_only'
               and evaluation.evaluation_status = 'unscorable'
           ),
           count(*) filter (where prediction.prediction_status = 'quarantined'),
           coalesce(bool_or(
             membership.included_in_metrics is distinct from (
               prediction.prediction_status = 'research_only'
               and evaluation.evaluation_status = 'scored'
             )
             or evaluation.evidence_mode is distinct from scorecard_mode
             or prediction.evidence_mode is distinct from scorecard_mode
             or (
               evaluation.evaluation_status = 'scored'
               and evaluation.observation_count <> (
                 select count(*)
                 from public.forecast_evaluation_observations target
                 where target.evaluation_id = evaluation.id
               )
             )
           ), false)
    into membership_count, included_count, unscorable_count, excluded_count,
         invalid_membership
    from public.model_scorecard_evaluations membership
    join public.forecast_evaluations evaluation
      on evaluation.id = membership.evaluation_id
    join public.card_forecast_predictions prediction
      on prediction.id = evaluation.prediction_id
    where membership.scorecard_id = new.scorecard_id;

    select count(*) into expected_membership_count
    from public.forecast_evaluations evaluation
    join public.card_forecast_predictions prediction
      on prediction.id = evaluation.prediction_id
    where evaluation.analytics_run_id = scorecard_run
      and prediction.model_version_id = scorecard_model
      and prediction.horizon_days = scorecard_horizon
      and prediction.origin between scorecard_origin_start and scorecard_origin_end
      and evaluation.evidence_mode = scorecard_mode
      and prediction.evidence_mode = scorecard_mode;

    if recommendation <> 'eligible_for_operator_review'
       or policy_hash = repeat('0', 64)
       or membership_hash = repeat('0', 64)
       or policy->>'version' = 'legacy-unversioned'
       or membership_count <> scorecard_matured_count
       or membership_count <> expected_membership_count
       or included_count <> scorecard_evaluation_count
       or unscorable_count <> scorecard_unscorable_count
       or excluded_count <> scorecard_excluded_count
       or invalid_membership then
      raise exception 'Approved promotion requires complete versioned scorecard membership';
    end if;

    if coalesce(jsonb_array_length(policy->'requiredBaselines'), 0) <> 5
       or not policy @> jsonb_build_object(
         'requiredBaselines',
         jsonb_build_array('no_change', 'damped_momentum', 'market_index', 'lifecycle_cohort', 'structural_convergence')
       )
       or scorecard_metrics->'missingRequiredBaselines' is distinct from '[]'::jsonb
       or jsonb_typeof(policy->'minimumCases') is distinct from 'number'
       or jsonb_typeof(policy->'minimumBaselineLift') is distinct from 'number'
       or jsonb_typeof(policy->'interval80CoverageMin') is distinct from 'number'
       or jsonb_typeof(policy->'interval80CoverageMax') is distinct from 'number'
       or jsonb_typeof(policy->'maximumBrierScore') is distinct from 'number'
       or jsonb_typeof(scorecard_metrics->'count') is distinct from 'number'
       or jsonb_typeof(scorecard_metrics->'interval80Coverage') is distinct from 'number'
       or jsonb_typeof(scorecard_metrics->'brierScore') is distinct from 'number'
       or coalesce((scorecard_metrics->>'count')::integer, -1) <> scorecard_evaluation_count
       or coalesce((policy->>'minimumCases')::integer, 2147483647) > scorecard_evaluation_count
       or coalesce((scorecard_metrics->>'interval80Coverage')::numeric, -1)
            not between (policy->>'interval80CoverageMin')::numeric
                and (policy->>'interval80CoverageMax')::numeric
       or coalesce((scorecard_metrics->>'brierScore')::numeric, 2)
            > (policy->>'maximumBrierScore')::numeric
       or exists (
         select 1
         from jsonb_array_elements_text(policy->'requiredBaselines') baseline(name)
         where jsonb_typeof(scorecard_metrics->'baselineResults'->baseline.name)
                 is distinct from 'number'
            or (scorecard_metrics->'baselineResults'->>baseline.name)::numeric
                 < (policy->>'minimumBaselineLift')::numeric
       ) then
      raise exception 'Approved promotion does not satisfy the declared five-baseline policy';
    end if;

    -- Even a fully valid prospective scorecard cannot publish in v1.
    raise exception 'Forecast Engine v1 has no public promotion path; use a later reviewed migration';
  end if;
  return new;
end;
$$;

do $$
begin
  if coalesce((select enabled from public.product_feature_flags where key = 'public_price_intelligence'), false) then
    raise exception 'Forecast Engine v1 must leave public_price_intelligence disabled';
  end if;
  if to_regprocedure('public.publish_forecast_intelligence(uuid)') is not null then
    raise exception 'Forecast Engine v1 must not install a public forecast publisher';
  end if;
  if has_table_privilege('anon', 'public.market_series', 'SELECT')
     or has_table_privilege('authenticated', 'public.market_series', 'SELECT')
     or has_table_privilege('anon', 'public.forecast_evaluation_observations', 'SELECT')
     or has_table_privilege('authenticated', 'public.forecast_evaluation_observations', 'SELECT') then
    raise exception 'Exact-series forecast evidence must remain private';
  end if;
end;
$$;

commit;
