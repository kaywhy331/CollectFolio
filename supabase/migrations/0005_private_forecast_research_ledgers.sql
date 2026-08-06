-- CollectFolio private forecast research ledgers
-- Adds immutable model, prediction, evaluation, and scorecard evidence. Nothing
-- in this migration publishes a forecast or changes public feature flags.

begin;

alter table public.analytics_runs
  drop constraint if exists analytics_runs_run_kind_check;
alter table public.analytics_runs
  add constraint analytics_runs_run_kind_check check (run_kind in (
    'catalog_sync','mapping_build','trend_build','walk_forward','publication_build',
    'model_training','forecast_build','forecast_evaluation'
  ));

create table public.model_versions (
  id uuid primary key default gen_random_uuid(),
  model_key text not null check (char_length(model_key) between 1 and 120),
  version text not null check (char_length(version) between 1 and 120),
  model_family text not null check (model_family in (
    'no_change_baseline','damped_momentum_baseline','structural_fair_value',
    'quantile_return_forecast'
  )),
  research_only boolean not null default true check (research_only),
  allowed_horizons integer[] not null,
  training_dataset_hash text not null check (training_dataset_hash ~ '^[0-9a-f]{64}$'),
  feature_version text not null,
  mapping_version text not null,
  code_version text not null,
  model_artifact_hash text check (model_artifact_hash is null or model_artifact_hash ~ '^[0-9a-f]{64}$'),
  trained_through timestamptz,
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 131072),
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (model_key, version),
  check (cardinality(allowed_horizons) > 0),
  check (allowed_horizons <@ array[7,30,90,180,365])
);

create table public.card_forecast_predictions (
  id uuid primary key default gen_random_uuid(),
  analytics_run_id uuid not null references public.analytics_runs(id) on delete restrict,
  model_version_id uuid not null references public.model_versions(id) on delete restrict,
  trend_snapshot_id uuid not null references public.trend_feature_snapshots(id) on delete restrict,
  variant_id uuid not null references public.catalog_variants(id) on delete restrict,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  origin timestamptz not null,
  feature_cutoff timestamptz not null,
  horizon_days integer not null check (horizon_days in (7,30,90,180,365)),
  matures_at timestamptz not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  current_price numeric(16,4) not null check (current_price > 0),
  q10 numeric(16,4) not null check (q10 > 0),
  q25 numeric(16,4) not null check (q25 > 0),
  q50 numeric(16,4) not null check (q50 > 0),
  q75 numeric(16,4) not null check (q75 > 0),
  q90 numeric(16,4) not null check (q90 > 0),
  probability_up numeric(7,6) not null check (probability_up between 0 and 1),
  confidence numeric(7,4) not null check (confidence between 0 and 100),
  prediction_status text not null check (prediction_status in ('research_only','quarantined')),
  reason_codes text[] not null default '{}',
  dataset_hash text not null check (dataset_hash ~ '^[0-9a-f]{64}$'),
  feature_version text not null,
  mapping_version text not null,
  code_version text not null,
  prediction_hash text not null unique check (prediction_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  check (feature_cutoff <= origin),
  check (matures_at = origin + make_interval(days => horizon_days)),
  check (q10 <= q25 and q25 <= q50 and q50 <= q75 and q75 <= q90),
  unique (model_version_id, variant_id, origin, horizon_days)
);

create index card_forecast_predictions_maturity_idx
  on public.card_forecast_predictions (matures_at, prediction_status);
create index card_forecast_predictions_variant_origin_idx
  on public.card_forecast_predictions (variant_id, origin desc, horizon_days);

create table public.forecast_evaluations (
  id uuid primary key default gen_random_uuid(),
  analytics_run_id uuid not null references public.analytics_runs(id) on delete restrict,
  prediction_id uuid not null unique references public.card_forecast_predictions(id) on delete restrict,
  maturity timestamptz not null,
  evaluated_at timestamptz not null,
  realized_price numeric(16,4) not null check (realized_price > 0),
  exact_date_price numeric(16,4) check (exact_date_price is null or exact_date_price > 0),
  observation_count integer not null check (observation_count > 0),
  absolute_log_error numeric not null check (absolute_log_error >= 0),
  absolute_percentage_error numeric not null check (absolute_percentage_error >= 0),
  direction_correct boolean not null,
  brier_component numeric check (brier_component is null or brier_component between 0 and 1),
  pinball_losses jsonb not null default '{}'::jsonb
    check (jsonb_typeof(pinball_losses) = 'object' and octet_length(pinball_losses::text) <= 16384),
  evaluation_hash text not null unique check (evaluation_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check (evaluated_at >= maturity)
);

create or replace function public.validate_forecast_evaluation_lineage()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  prediction_maturity timestamptz;
begin
  select matures_at into prediction_maturity
  from public.card_forecast_predictions
  where id = new.prediction_id;

  if prediction_maturity is null or prediction_maturity <> new.maturity then
    raise exception 'Forecast evaluation maturity does not match its prediction';
  end if;
  if new.evaluated_at < prediction_maturity then
    raise exception 'Forecast evaluation occurred before maturity';
  end if;
  return new;
end;
$$;

create trigger forecast_evaluations_validate_lineage
  before insert on public.forecast_evaluations
  for each row execute function public.validate_forecast_evaluation_lineage();

create table public.model_scorecards (
  id uuid primary key default gen_random_uuid(),
  analytics_run_id uuid not null references public.analytics_runs(id) on delete restrict,
  model_version_id uuid not null references public.model_versions(id) on delete restrict,
  horizon_days integer not null check (horizon_days in (7,30,90,180,365)),
  cohort_key text not null check (char_length(cohort_key) between 1 and 200),
  origin_start timestamptz not null,
  origin_end timestamptz not null,
  evaluation_count integer not null check (evaluation_count > 0),
  metrics jsonb not null check (
    jsonb_typeof(metrics) = 'object' and octet_length(metrics::text) <= 131072
  ),
  promotion_recommendation text not null check (promotion_recommendation in (
    'insufficient','reject','eligible_for_operator_review'
  )),
  reason_codes text[] not null default '{}',
  scorecard_hash text not null unique check (scorecard_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check (origin_end >= origin_start),
  unique (model_version_id, horizon_days, cohort_key, origin_start, origin_end)
);

create table public.model_promotion_reviews (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references public.model_versions(id) on delete restrict,
  scorecard_id uuid not null references public.model_scorecards(id) on delete restrict,
  decision text not null check (decision in ('approved','rejected','deferred')),
  leakage_tests_attested boolean not null default false,
  source_rights_attested boolean not null default false,
  baseline_lift_attested boolean not null default false,
  interval_calibration_attested boolean not null default false,
  cohort_regression_attested boolean not null default false,
  model_card_hash text not null check (model_card_hash ~ '^[0-9a-f]{64}$'),
  reviewer_user_id uuid references auth.users(id) on delete set null,
  reviewer_label text not null check (char_length(reviewer_label) between 1 and 160),
  notes text not null default '' check (char_length(notes) <= 4000),
  created_at timestamptz not null default now(),
  check (
    decision <> 'approved'
    or (
      leakage_tests_attested and source_rights_attested and baseline_lift_attested
      and interval_calibration_attested and cohort_regression_attested
    )
  )
);

create index model_promotion_reviews_latest_idx
  on public.model_promotion_reviews (model_version_id, created_at desc);

create trigger model_versions_append_only
  before update or delete on public.model_versions
  for each row execute function public.reject_append_only_mutation();
create trigger card_forecast_predictions_append_only
  before update or delete on public.card_forecast_predictions
  for each row execute function public.reject_append_only_mutation();
create trigger forecast_evaluations_append_only
  before update or delete on public.forecast_evaluations
  for each row execute function public.reject_append_only_mutation();
create trigger model_scorecards_append_only
  before update or delete on public.model_scorecards
  for each row execute function public.reject_append_only_mutation();
create trigger model_promotion_reviews_append_only
  before update or delete on public.model_promotion_reviews
  for each row execute function public.reject_append_only_mutation();

alter table public.model_versions enable row level security;
alter table public.card_forecast_predictions enable row level security;
alter table public.forecast_evaluations enable row level security;
alter table public.model_scorecards enable row level security;
alter table public.model_promotion_reviews enable row level security;

revoke all on public.model_versions, public.card_forecast_predictions,
  public.forecast_evaluations, public.model_scorecards, public.model_promotion_reviews
  from public, anon, authenticated, service_role;
grant select, insert on public.model_versions, public.card_forecast_predictions,
  public.forecast_evaluations, public.model_scorecards, public.model_promotion_reviews
  to service_role;

revoke execute on function public.validate_forecast_evaluation_lineage()
  from public, anon, authenticated, service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'model_versions','card_forecast_predictions','forecast_evaluations',
    'model_scorecards','model_promotion_reviews'
  ]
  loop
    if not (
      select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = table_name
    ) then
      raise exception 'Forecast research table % must have RLS enabled', table_name;
    end if;
    if has_table_privilege('anon', format('public.%I', table_name), 'SELECT')
       or has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT') then
      raise exception 'Forecast research table % must not be browser-readable', table_name;
    end if;
    if not has_table_privilege('service_role', format('public.%I', table_name), 'SELECT')
       or not has_table_privilege('service_role', format('public.%I', table_name), 'INSERT')
       or has_table_privilege('service_role', format('public.%I', table_name), 'UPDATE')
       or has_table_privilege('service_role', format('public.%I', table_name), 'DELETE') then
      raise exception 'Forecast research table % must be service append-only', table_name;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.validate_forecast_evaluation_lineage()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.validate_forecast_evaluation_lineage()', 'EXECUTE') then
    raise exception 'Forecast trigger helper must not be browser-executable';
  end if;
end;
$$;

commit;
