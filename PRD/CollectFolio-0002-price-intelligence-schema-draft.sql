-- CollectFolio Price Intelligence
-- Draft migration: 0002_price_intelligence.sql
-- Review before applying. Assumes 0001_initial.sql and public.set_updated_at() exist.

begin;

-- ---------------------------------------------------------------------------
-- Source governance
-- ---------------------------------------------------------------------------
create table if not exists public.data_sources (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  source_type text not null,
  terms_url text,
  commercial_use_allowed boolean not null default false,
  public_raw_display_allowed boolean not null default false,
  public_derived_display_allowed boolean not null default false,
  attribution_required boolean not null default false,
  attribution_text text,
  review_status text not null default 'pending'
    check (review_status in ('pending','research_only','approved','rejected','expired')),
  reviewed_at timestamptz,
  review_notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.source_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id) on delete restrict,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running'
    check (status in ('running','succeeded','partial','failed','cancelled')),
  records_read bigint not null default 0,
  records_written bigint not null default 0,
  records_quarantined bigint not null default 0,
  raw_payload_hash text,
  parser_version text,
  error_summary text,
  metadata jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Canonical Pokemon catalog and source mapping
-- ---------------------------------------------------------------------------
create table if not exists public.catalog_sets (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  name text not null,
  series text,
  language text not null default 'en',
  release_date date,
  printed_total integer,
  total integer,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.catalog_cards (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.catalog_sets(id) on delete cascade,
  canonical_key text not null unique,
  name text not null,
  number text not null,
  rarity text,
  artist text,
  supertype text,
  subtypes text[] not null default '{}',
  pokedex_numbers integer[] not null default '{}',
  release_date date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.catalog_variants (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.catalog_cards(id) on delete cascade,
  canonical_key text not null unique,
  language text not null default 'en',
  edition text not null default '',
  finish text not null default '',
  variant_name text not null default '',
  raw_condition_class text not null default 'raw',
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.external_card_mappings (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id) on delete cascade,
  external_product_id text not null,
  external_variant_key text not null default '',
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  mapping_confidence numeric(5,4) not null check (mapping_confidence between 0 and 1),
  mapping_method text not null,
  mapping_version text not null,
  review_status text not null default 'pending'
    check (review_status in ('pending','approved','rejected','quarantined')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_product_id, external_variant_key)
);

-- ---------------------------------------------------------------------------
-- Price observations
-- ---------------------------------------------------------------------------
create table if not exists public.latest_prices (
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  price_subtype text not null,
  currency text not null default 'USD',
  market_price numeric(14,4),
  low_price numeric(14,4),
  mid_price numeric(14,4),
  high_price numeric(14,4),
  observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  quality_score numeric(5,4) not null default 0 check (quality_score between 0 and 1),
  public_display_allowed boolean not null default false,
  source_record_hash text,
  metadata jsonb not null default '{}'::jsonb,
  primary key (variant_id, source_id, price_subtype)
);

create table if not exists public.price_snapshots (
  id bigint generated always as identity primary key,
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  price_subtype text not null,
  currency text not null default 'USD',
  market_price numeric(14,4),
  observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  quality_score numeric(5,4) not null default 0 check (quality_score between 0 and 1),
  source_record_hash text,
  metadata jsonb not null default '{}'::jsonb,
  unique (variant_id, source_id, price_subtype, observed_at)
);

create index if not exists price_snapshots_variant_date_idx
  on public.price_snapshots (variant_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- Pull rates and sealed products
-- ---------------------------------------------------------------------------
create table if not exists public.pull_rate_sources (
  id uuid primary key default gen_random_uuid(),
  publisher text not null,
  title text not null,
  url text not null,
  published_at timestamptz,
  retrieved_at timestamptz not null default now(),
  sample_size integer,
  methodology text,
  region text,
  language text,
  confidence_grade text,
  metadata jsonb not null default '{}'::jsonb,
  unique (url)
);

create table if not exists public.set_pull_rates (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.catalog_sets(id) on delete cascade,
  pull_rate_source_id uuid not null references public.pull_rate_sources(id) on delete restrict,
  rarity_slot text not null,
  probability numeric(12,10) check (probability > 0 and probability <= 1),
  ci_lower numeric(12,10),
  ci_upper numeric(12,10),
  one_in_packs numeric(14,4),
  eligible_count integer check (eligible_count > 0),
  specific_probability numeric(14,12),
  specific_one_in_packs numeric(16,4),
  equal_distribution_assumed boolean not null default true,
  collation_notes text,
  effective_from date,
  effective_to date,
  version text not null,
  review_status text not null default 'pending'
    check (review_status in ('pending','approved','rejected','provisional')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (set_id, pull_rate_source_id, rarity_slot, version)
);

create table if not exists public.sealed_products (
  id uuid primary key default gen_random_uuid(),
  set_id uuid references public.catalog_sets(id) on delete set null,
  canonical_key text not null unique,
  name text not null,
  product_type text not null,
  packs_per_product numeric(10,2),
  msrp numeric(14,4),
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sealed_price_snapshots (
  id bigint generated always as identity primary key,
  sealed_product_id uuid not null references public.sealed_products(id) on delete cascade,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  market_price numeric(14,4),
  unit_pack_price numeric(14,4),
  observed_at timestamptz not null,
  quality_score numeric(5,4) not null default 0 check (quality_score between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  unique (sealed_product_id, source_id, observed_at)
);

-- ---------------------------------------------------------------------------
-- Watchlists, alerts, and user-generated demand
-- ---------------------------------------------------------------------------
create table if not exists public.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Watchlist',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists watchlists_one_default_per_user_idx
  on public.watchlists (user_id) where is_default;

create table if not exists public.watchlist_items (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references public.watchlists(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  target_price numeric(14,4),
  alert_percent_change numeric(8,4),
  alert_trend_change boolean not null default false,
  alert_range_change boolean not null default false,
  alert_forecast_change boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (watchlist_id, variant_id)
);

create table if not exists public.watchlist_deletions (
  user_id uuid not null references auth.users(id) on delete cascade,
  watchlist_item_id uuid not null,
  deleted_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, watchlist_item_id)
);

create table if not exists public.alert_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  alert_type text not null,
  event_key text not null,
  payload jsonb not null default '{}'::jsonb,
  triggered_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, event_key)
);

create table if not exists public.demand_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  variant_id uuid references public.catalog_variants(id) on delete cascade,
  event_type text not null,
  event_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists demand_events_variant_date_idx
  on public.demand_events (variant_id, event_at desc);

create table if not exists public.aggregate_demand_snapshots (
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  watch_adds integer not null default 0,
  watch_removes integer not null default 0,
  searches integer not null default 0,
  portfolio_adds integer not null default 0,
  views integer not null default 0,
  unique_users integer not null default 0,
  privacy_threshold_met boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (variant_id, period_start, period_end)
);

create table if not exists public.artwork_pairwise_votes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  variant_a_id uuid not null references public.catalog_variants(id) on delete cascade,
  variant_b_id uuid not null references public.catalog_variants(id) on delete cascade,
  winner_variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  presented_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (variant_a_id <> variant_b_id),
  check (winner_variant_id = variant_a_id or winner_variant_id = variant_b_id)
);

create table if not exists public.artwork_score_snapshots (
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  model_version text not null,
  score numeric(10,6) not null,
  lower_bound numeric(10,6),
  upper_bound numeric(10,6),
  vote_count integer not null default 0,
  calculated_at timestamptz not null,
  primary key (variant_id, model_version, calculated_at)
);

-- ---------------------------------------------------------------------------
-- Models, runs, forecasts, and evaluation
-- ---------------------------------------------------------------------------
create table if not exists public.model_versions (
  id uuid primary key default gen_random_uuid(),
  model_type text not null,
  name text not null,
  version text not null,
  cohort text not null,
  horizon_days integer,
  code_commit text not null,
  training_cutoff timestamptz not null,
  feature_version text not null,
  dataset_hash text not null,
  parameters jsonb not null default '{}'::jsonb,
  status text not null default 'candidate'
    check (status in ('candidate','challenger','champion','retired','quarantined')),
  created_at timestamptz not null default now(),
  promoted_at timestamptz,
  unique (name, version, cohort, horizon_days)
);

create table if not exists public.model_runs (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references public.model_versions(id) on delete restrict,
  run_type text not null,
  prediction_origin timestamptz,
  feature_cutoff timestamptz not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running'
    check (status in ('running','succeeded','partial','failed','cancelled')),
  row_count bigint not null default 0,
  artifact_uri text,
  metrics jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.card_fair_value_estimates (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  model_run_id uuid not null references public.model_runs(id) on delete cascade,
  observed_price numeric(14,4),
  estimate_q10 numeric(14,4),
  estimate_q25 numeric(14,4),
  estimate_q50 numeric(14,4),
  estimate_q75 numeric(14,4),
  estimate_q90 numeric(14,4),
  position text not null
    check (position in ('below_range','within_range','above_range','insufficient')),
  confidence_score numeric(5,2) not null check (confidence_score between 0 and 100),
  feature_contributions jsonb not null default '{}'::jsonb,
  public_display_allowed boolean not null default false,
  generated_at timestamptz not null default now(),
  unique (variant_id, model_run_id)
);

create table if not exists public.card_forecasts (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  model_run_id uuid not null references public.model_runs(id) on delete cascade,
  horizon_days integer not null check (horizon_days in (7,30,90,180,365)),
  prediction_origin timestamptz not null,
  matures_at timestamptz not null,
  current_price numeric(14,4) not null,
  return_q10 numeric(14,8),
  return_q25 numeric(14,8),
  return_q50 numeric(14,8),
  return_q75 numeric(14,8),
  return_q90 numeric(14,8),
  price_q10 numeric(14,4),
  price_q25 numeric(14,4),
  price_q50 numeric(14,4),
  price_q75 numeric(14,4),
  price_q90 numeric(14,4),
  probability_up numeric(8,6) check (probability_up between 0 and 1),
  confidence_score numeric(5,2) not null check (confidence_score between 0 and 100),
  feature_snapshot_hash text not null,
  public_display_allowed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (variant_id, model_run_id, horizon_days),
  check (
    price_q10 is null or price_q25 is null or price_q50 is null or
    price_q75 is null or price_q90 is null or
    (price_q10 <= price_q25 and price_q25 <= price_q50 and
     price_q50 <= price_q75 and price_q75 <= price_q90)
  )
);

create index if not exists card_forecasts_variant_origin_idx
  on public.card_forecasts (variant_id, prediction_origin desc);
create index if not exists card_forecasts_maturity_idx
  on public.card_forecasts (matures_at) where public_display_allowed;

create table if not exists public.prediction_evaluations (
  forecast_id uuid primary key references public.card_forecasts(id) on delete cascade,
  evaluation_rule text not null,
  realized_price numeric(14,4),
  realized_return numeric(14,8),
  absolute_error numeric(14,4),
  percentage_error numeric(14,8),
  log_return_error numeric(14,8),
  direction_correct boolean,
  interval_50_hit boolean,
  interval_80_hit boolean,
  status text not null
    check (status in ('open','matured','evaluated','unscorable','invalidated_data_error')),
  evaluated_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.model_metrics (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references public.model_versions(id) on delete cascade,
  horizon_days integer,
  cohort text not null,
  period_start date,
  period_end date,
  metric_name text not null,
  metric_value numeric(18,8),
  sample_count integer not null default 0,
  is_public boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.data_quality_flags (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  flag_code text not null,
  severity text not null check (severity in ('info','warning','error','critical')),
  details jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (entity_type, entity_id, flag_code, opened_at)
);

-- ---------------------------------------------------------------------------
-- Updated-at triggers
-- ---------------------------------------------------------------------------
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'data_sources','catalog_sets','catalog_cards','catalog_variants',
    'external_card_mappings','set_pull_rates','sealed_products',
    'watchlists','watchlist_items'
  ]
  loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      table_name, table_name
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.data_sources enable row level security;
alter table public.source_ingestion_runs enable row level security;
alter table public.catalog_sets enable row level security;
alter table public.catalog_cards enable row level security;
alter table public.catalog_variants enable row level security;
alter table public.external_card_mappings enable row level security;
alter table public.latest_prices enable row level security;
alter table public.price_snapshots enable row level security;
alter table public.pull_rate_sources enable row level security;
alter table public.set_pull_rates enable row level security;
alter table public.sealed_products enable row level security;
alter table public.sealed_price_snapshots enable row level security;
alter table public.watchlists enable row level security;
alter table public.watchlist_items enable row level security;
alter table public.watchlist_deletions enable row level security;
alter table public.alert_events enable row level security;
alter table public.demand_events enable row level security;
alter table public.aggregate_demand_snapshots enable row level security;
alter table public.artwork_pairwise_votes enable row level security;
alter table public.artwork_score_snapshots enable row level security;
alter table public.model_versions enable row level security;
alter table public.model_runs enable row level security;
alter table public.card_fair_value_estimates enable row level security;
alter table public.card_forecasts enable row level security;
alter table public.prediction_evaluations enable row level security;
alter table public.model_metrics enable row level security;
alter table public.data_quality_flags enable row level security;

-- User-owned tables
create policy watchlists_select_own on public.watchlists for select using (user_id = auth.uid());
create policy watchlists_insert_own on public.watchlists for insert with check (user_id = auth.uid());
create policy watchlists_update_own on public.watchlists for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy watchlists_delete_own on public.watchlists for delete using (user_id = auth.uid());

create policy watchlist_items_select_own on public.watchlist_items for select using (user_id = auth.uid());
create policy watchlist_items_insert_own on public.watchlist_items for insert with check (user_id = auth.uid());
create policy watchlist_items_update_own on public.watchlist_items for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy watchlist_items_delete_own on public.watchlist_items for delete using (user_id = auth.uid());

create policy watchlist_deletions_select_own on public.watchlist_deletions for select using (user_id = auth.uid());
create policy watchlist_deletions_insert_own on public.watchlist_deletions for insert with check (user_id = auth.uid());
create policy watchlist_deletions_delete_own on public.watchlist_deletions for delete using (user_id = auth.uid());

create policy alert_events_select_own on public.alert_events for select using (user_id = auth.uid());
create policy alert_events_insert_own on public.alert_events for insert with check (user_id = auth.uid());
create policy alert_events_update_own on public.alert_events for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy alert_events_delete_own on public.alert_events for delete using (user_id = auth.uid());

create policy demand_events_select_own on public.demand_events for select using (user_id = auth.uid());
create policy demand_events_insert_own on public.demand_events for insert with check (user_id = auth.uid());

create policy artwork_votes_select_own on public.artwork_pairwise_votes for select using (user_id = auth.uid());
create policy artwork_votes_insert_own on public.artwork_pairwise_votes for insert with check (user_id = auth.uid());

-- Public catalog/reference reads
create policy catalog_sets_public_read on public.catalog_sets for select using (true);
create policy catalog_cards_public_read on public.catalog_cards for select using (true);
create policy catalog_variants_public_read on public.catalog_variants for select using (active);
create policy approved_pull_sources_public_read on public.pull_rate_sources for select using (true);
create policy approved_pull_rates_public_read on public.set_pull_rates for select using (review_status = 'approved');
create policy sealed_products_public_read on public.sealed_products for select using (true);
create policy artwork_scores_public_read on public.artwork_score_snapshots for select using (true);
create policy aggregate_demand_public_read on public.aggregate_demand_snapshots for select using (privacy_threshold_met);

-- Rights-filtered intelligence reads
create policy latest_prices_public_read on public.latest_prices for select using (public_display_allowed);
create policy fair_values_public_read on public.card_fair_value_estimates for select using (public_display_allowed);
create policy forecasts_public_read on public.card_forecasts for select using (public_display_allowed);
create policy public_model_versions_read on public.model_versions for select using (status in ('champion','retired'));
create policy public_model_metrics_read on public.model_metrics for select using (is_public);
create policy public_evaluations_read on public.prediction_evaluations for select using (
  exists (
    select 1 from public.card_forecasts f
    where f.id = forecast_id and f.public_display_allowed
  )
);

-- No client policies are created for restricted raw research/ops tables.

-- Grants

grant usage on schema public to anon, authenticated;
grant select on public.catalog_sets, public.catalog_cards, public.catalog_variants,
  public.pull_rate_sources, public.set_pull_rates, public.sealed_products,
  public.latest_prices, public.aggregate_demand_snapshots,
  public.artwork_score_snapshots, public.model_versions,
  public.card_fair_value_estimates, public.card_forecasts,
  public.prediction_evaluations, public.model_metrics
  to anon, authenticated;

grant select, insert, update, delete on public.watchlists, public.watchlist_items,
  public.watchlist_deletions, public.alert_events
  to authenticated;

grant select, insert on public.demand_events, public.artwork_pairwise_votes
  to authenticated;

commit;
