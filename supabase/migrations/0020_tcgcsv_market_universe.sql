-- CollectFolio private TCGCSV market-universe data plane.
--
-- The source archive and provider-native catalog are retained for private,
-- research-only analysis.  Nothing in this migration grants browser access,
-- creates canonical mappings, publishes a price, or enables a forecast flag.

begin;

do $$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'collectfolio_tcgcsv_ingest'
  ) then
    create role collectfolio_tcgcsv_ingest
      nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  elsif exists (
    select 1 from pg_roles
    where rolname = 'collectfolio_tcgcsv_ingest'
      and (
        rolcanlogin or rolinherit or rolsuper or rolcreatedb
        or rolcreaterole or rolbypassrls
      )
  ) or exists (
    select 1
    from pg_auth_members membership
    join pg_roles member_role on member_role.oid = membership.member
    where member_role.rolname = 'collectfolio_tcgcsv_ingest'
  ) then
    raise exception 'collectfolio_tcgcsv_ingest must remain a restricted NOLOGIN role';
  end if;
end;
$$;

create table public.tcgcsv_archive_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  archive_date date not null,
  source_updated_at timestamptz not null,
  source_available_at timestamptz not null,
  archive_sha256 text not null check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_bytes bigint not null check (archive_bytes > 0),
  expanded_bytes bigint not null check (expanded_bytes >= archive_bytes),
  object_uri text not null check (
    char_length(object_uri) between 8 and 2000
    and object_uri ~ '^s3://[^/?#@]+/[^?#@]+$'
  ),
  parquet_uri text not null check (
    char_length(parquet_uri) between 8 and 2000
    and parquet_uri ~ '^s3://[^/?#@]+/[^?#@]+$'
  ),
  parquet_sha256 text not null check (parquet_sha256 ~ '^[0-9a-f]{64}$'),
  parquet_bytes bigint not null check (parquet_bytes > 0),
  feature_object_uri text not null check (
    char_length(feature_object_uri) between 8 and 2000
    and feature_object_uri ~ '^s3://[^/?#@]+/[^?#@]+$'
  ),
  set_feature_object_uri text not null check (
    char_length(set_feature_object_uri) between 8 and 2000
    and set_feature_object_uri ~ '^s3://[^/?#@]+/[^?#@]+$'
  ),
  scope_sha256 text not null check (scope_sha256 ~ '^[0-9a-f]{64}$'),
  normalized_csv_sha256 text not null check (normalized_csv_sha256 ~ '^[0-9a-f]{64}$'),
  feature_csv_sha256 text not null check (feature_csv_sha256 ~ '^[0-9a-f]{64}$'),
  set_feature_csv_sha256 text not null check (set_feature_csv_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version text not null check (char_length(parser_version) between 1 and 160),
  run_identity_sha256 text not null unique check (run_identity_sha256 ~ '^[0-9a-f]{64}$'),
  expected_category_count integer not null check (expected_category_count > 0),
  expected_group_count integer not null check (expected_group_count > 0),
  expected_price_count bigint not null check (expected_price_count > 0),
  expected_feature_count bigint not null check (expected_feature_count >= 0),
  expected_set_feature_count integer not null check (expected_set_feature_count >= 0),
  status text not null default 'staging' check (status in ('staging','sealed')),
  started_at timestamptz not null default clock_timestamp(),
  sealed_at timestamptz,
  current_state_applied boolean,
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 32768
  ),
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  unique (source_id, archive_date),
  check (archive_date = source_updated_at::date),
  check (source_available_at >= source_updated_at),
  check ((status = 'staging' and sealed_at is null) or (status = 'sealed' and sealed_at is not null)),
  check (
    (status = 'staging' and current_state_applied is null)
    or (status = 'sealed' and current_state_applied is not null)
  )
);

create table public.tcgcsv_archive_run_categories (
  run_id uuid not null references public.tcgcsv_archive_runs(id) on delete restrict,
  category_id integer not null check (category_id > 0),
  primary key (run_id, category_id)
);

create table public.tcgcsv_archive_group_receipts (
  run_id uuid not null references public.tcgcsv_archive_runs(id) on delete restrict,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  member_path text not null check (char_length(member_path) between 1 and 1000),
  member_sha256 text not null check (member_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer not null check (row_count >= 0),
  member_bytes integer not null check (member_bytes > 0),
  primary key (run_id, category_id, group_id),
  foreign key (run_id, category_id)
    references public.tcgcsv_archive_run_categories(run_id, category_id) on delete restrict
);

create table public.tcgcsv_price_stage (
  run_id uuid not null references public.tcgcsv_archive_runs(id) on delete cascade,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  product_id bigint not null check (product_id > 0),
  subtype_name text not null check (char_length(subtype_name) between 1 and 200),
  series_sha256 text not null check (series_sha256 ~ '^[0-9a-f]{64}$'),
  low_price numeric(16,4) check (low_price is null or low_price >= 0),
  mid_price numeric(16,4) check (mid_price is null or mid_price >= 0),
  high_price numeric(16,4) check (high_price is null or high_price >= 0),
  market_price numeric(16,4) check (market_price is null or market_price >= 0),
  direct_low_price numeric(16,4) check (direct_low_price is null or direct_low_price >= 0),
  price_tuple_sha256 text not null check (price_tuple_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (run_id, category_id, group_id, product_id, subtype_name),
  foreign key (run_id, category_id, group_id)
    references public.tcgcsv_archive_group_receipts(run_id, category_id, group_id)
    on delete cascade
);

create table public.tcgcsv_market_feature_stage (
  run_id uuid not null references public.tcgcsv_archive_runs(id) on delete cascade,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  product_id bigint not null check (product_id > 0),
  subtype_name text not null check (char_length(subtype_name) between 1 and 200),
  series_sha256 text not null check (series_sha256 ~ '^[0-9a-f]{64}$'),
  current_price numeric(16,4) check (current_price is null or current_price >= 0),
  return_7d double precision,
  return_30d double precision,
  return_90d double precision,
  return_180d double precision,
  return_365d double precision,
  daily_log_slope_30d double precision,
  volatility_30d double precision check (volatility_30d is null or volatility_30d >= 0),
  max_drawdown_365d double precision check (
    max_drawdown_365d is null or max_drawdown_365d between 0 and 1
  ),
  history_density_365d double precision check (
    history_density_365d is null or history_density_365d between 0 and 1
  ),
  trend_status text not null check (
    trend_status in ('strong_rise','rise','stable','fall','strong_fall','insufficient')
  ),
  trend_confidence double precision check (trend_confidence is null or trend_confidence between 0 and 100),
  opportunity_score double precision check (opportunity_score is null or opportunity_score between 0 and 100),
  opportunity_status text not null check (
    opportunity_status in ('candidate','neutral','risk','insufficient')
  ),
  forecast_estimates jsonb not null default '{}'::jsonb check (
    jsonb_typeof(forecast_estimates) = 'object'
    and octet_length(forecast_estimates::text) <= 32768
  ),
  forecast_model_key text not null check (char_length(forecast_model_key) between 1 and 160),
  estimate_status text not null check (
    estimate_status in ('research_only','insufficient','quarantined')
  ),
  feature_sha256 text not null check (feature_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (run_id, category_id, group_id, product_id, subtype_name),
  foreign key (run_id, category_id, group_id, product_id, subtype_name)
    references public.tcgcsv_price_stage(
      run_id, category_id, group_id, product_id, subtype_name
    ) on delete cascade
);

create table public.tcgcsv_set_feature_stage (
  run_id uuid not null references public.tcgcsv_archive_runs(id) on delete cascade,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  series_count integer not null check (series_count >= 0),
  priced_series_count integer not null check (
    priced_series_count >= 0 and priced_series_count <= series_count
  ),
  median_return_30d double precision,
  breadth_30d double precision check (breadth_30d is null or breadth_30d between 0 and 1),
  median_volatility_30d double precision check (
    median_volatility_30d is null or median_volatility_30d >= 0
  ),
  hotness_score double precision check (hotness_score is null or hotness_score between 0 and 100),
  feature_status text not null check (feature_status in ('available','insufficient')),
  feature_sha256 text not null check (feature_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (run_id, category_id, group_id),
  foreign key (run_id, category_id, group_id)
    references public.tcgcsv_archive_group_receipts(run_id, category_id, group_id)
    on delete cascade
);

create table public.tcgcsv_price_current (
  source_id uuid not null references public.data_sources(id) on delete restrict,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  product_id bigint not null check (product_id > 0),
  subtype_name text not null check (char_length(subtype_name) between 1 and 200),
  series_sha256 text not null check (series_sha256 ~ '^[0-9a-f]{64}$'),
  low_price numeric(16,4) check (low_price is null or low_price >= 0),
  mid_price numeric(16,4) check (mid_price is null or mid_price >= 0),
  high_price numeric(16,4) check (high_price is null or high_price >= 0),
  market_price numeric(16,4) check (market_price is null or market_price >= 0),
  direct_low_price numeric(16,4) check (direct_low_price is null or direct_low_price >= 0),
  price_tuple_sha256 text not null check (price_tuple_sha256 ~ '^[0-9a-f]{64}$'),
  first_seen_on date not null,
  price_changed_on date not null,
  changed_by_run_id uuid not null references public.tcgcsv_archive_runs(id) on delete restrict,
  primary key (source_id, category_id, group_id, product_id, subtype_name),
  check (first_seen_on <= price_changed_on)
);

create index tcgcsv_price_current_product_idx
  on public.tcgcsv_price_current (source_id, product_id, subtype_name);
create index tcgcsv_price_current_market_idx
  on public.tcgcsv_price_current (source_id, market_price desc)
  where market_price is not null;

create table public.tcgcsv_market_features_current (
  source_id uuid not null references public.data_sources(id) on delete restrict,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  product_id bigint not null check (product_id > 0),
  subtype_name text not null check (char_length(subtype_name) between 1 and 200),
  series_sha256 text not null check (series_sha256 ~ '^[0-9a-f]{64}$'),
  current_price numeric(16,4) check (current_price is null or current_price >= 0),
  return_7d double precision,
  return_30d double precision,
  return_90d double precision,
  return_180d double precision,
  return_365d double precision,
  daily_log_slope_30d double precision,
  volatility_30d double precision check (volatility_30d is null or volatility_30d >= 0),
  max_drawdown_365d double precision check (
    max_drawdown_365d is null or max_drawdown_365d between 0 and 1
  ),
  history_density_365d double precision check (
    history_density_365d is null or history_density_365d between 0 and 1
  ),
  trend_status text not null check (
    trend_status in ('strong_rise','rise','stable','fall','strong_fall','insufficient')
  ),
  trend_confidence double precision check (trend_confidence is null or trend_confidence between 0 and 100),
  opportunity_score double precision check (opportunity_score is null or opportunity_score between 0 and 100),
  opportunity_status text not null check (
    opportunity_status in ('candidate','neutral','risk','insufficient')
  ),
  forecast_estimates jsonb not null default '{}'::jsonb check (
    jsonb_typeof(forecast_estimates) = 'object'
    and octet_length(forecast_estimates::text) <= 32768
  ),
  forecast_model_key text not null check (char_length(forecast_model_key) between 1 and 160),
  estimate_status text not null check (
    estimate_status in ('research_only','insufficient','quarantined')
  ),
  feature_sha256 text not null check (feature_sha256 ~ '^[0-9a-f]{64}$'),
  changed_by_run_id uuid not null references public.tcgcsv_archive_runs(id) on delete restrict,
  primary key (source_id, category_id, group_id, product_id, subtype_name),
  foreign key (source_id, category_id, group_id, product_id, subtype_name)
    references public.tcgcsv_price_current(
      source_id, category_id, group_id, product_id, subtype_name
    ) on delete cascade
);

create index tcgcsv_market_features_opportunity_idx
  on public.tcgcsv_market_features_current (source_id, opportunity_score desc)
  where estimate_status = 'research_only' and opportunity_score is not null;
create index tcgcsv_market_features_trend_idx
  on public.tcgcsv_market_features_current (source_id, return_30d desc)
  where return_30d is not null;

create table public.tcgcsv_set_features_current (
  source_id uuid not null references public.data_sources(id) on delete restrict,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  series_count integer not null check (series_count >= 0),
  priced_series_count integer not null check (
    priced_series_count >= 0 and priced_series_count <= series_count
  ),
  median_return_30d double precision,
  breadth_30d double precision check (breadth_30d is null or breadth_30d between 0 and 1),
  median_volatility_30d double precision check (
    median_volatility_30d is null or median_volatility_30d >= 0
  ),
  hotness_score double precision check (hotness_score is null or hotness_score between 0 and 100),
  feature_status text not null check (feature_status in ('available','insufficient')),
  feature_sha256 text not null check (feature_sha256 ~ '^[0-9a-f]{64}$'),
  changed_by_run_id uuid not null references public.tcgcsv_archive_runs(id) on delete restrict,
  primary key (source_id, category_id, group_id)
);

create index tcgcsv_set_features_hotness_idx
  on public.tcgcsv_set_features_current (source_id, hotness_score desc)
  where feature_status = 'available';

create table public.tcgcsv_catalog_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  source_updated_at timestamptz not null,
  scope_sha256 text not null check (scope_sha256 ~ '^[0-9a-f]{64}$'),
  catalog_content_sha256 text not null check (catalog_content_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version text not null check (char_length(parser_version) between 1 and 160),
  run_identity_sha256 text not null unique check (run_identity_sha256 ~ '^[0-9a-f]{64}$'),
  expected_category_count integer not null check (expected_category_count > 0),
  expected_group_count integer not null check (expected_group_count >= 0),
  expected_product_count bigint not null check (expected_product_count >= 0),
  status text not null default 'staging' check (status in ('staging','sealed','partial')),
  started_at timestamptz not null default clock_timestamp(),
  sealed_at timestamptz,
  current_state_applied boolean,
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 32768
  ),
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  unique (source_id, source_updated_at),
  check (
    (status = 'staging' and sealed_at is null)
    or (status in ('sealed','partial') and sealed_at is not null)
  ),
  check (
    (status = 'staging' and current_state_applied is null)
    or (status in ('sealed','partial') and current_state_applied is not null)
  )
);

create table public.tcgcsv_category_stage (
  run_id uuid not null references public.tcgcsv_catalog_runs(id) on delete cascade,
  category_id integer not null check (category_id > 0),
  name text not null check (char_length(name) between 1 and 300),
  display_name text not null default '' check (char_length(display_name) <= 300),
  is_card_category boolean not null,
  category_sha256 text not null check (category_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 32768
  ),
  primary key (run_id, category_id)
);

create table public.tcgcsv_group_stage (
  run_id uuid not null references public.tcgcsv_catalog_runs(id) on delete cascade,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  name text not null check (char_length(name) between 1 and 500),
  abbreviation text not null default '' check (char_length(abbreviation) <= 120),
  published_on date,
  modified_on text not null default '' check (char_length(modified_on) <= 160),
  group_sha256 text not null check (group_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 32768
  ),
  primary key (run_id, category_id, group_id),
  foreign key (run_id, category_id)
    references public.tcgcsv_category_stage(run_id, category_id) on delete cascade
);

create table public.tcgcsv_product_stage (
  run_id uuid not null references public.tcgcsv_catalog_runs(id) on delete cascade,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  product_id bigint not null check (product_id > 0),
  name text not null check (char_length(name) between 1 and 700),
  clean_name text not null default '' check (char_length(clean_name) <= 700),
  card_number text not null default '' check (char_length(card_number) <= 160),
  rarity text not null default '' check (char_length(rarity) <= 300),
  card_type text not null default '' check (char_length(card_type) <= 300),
  modified_on text not null default '' check (char_length(modified_on) <= 160),
  product_sha256 text not null check (product_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 65536
  ),
  primary key (run_id, category_id, group_id, product_id),
  foreign key (run_id, category_id, group_id)
    references public.tcgcsv_group_stage(run_id, category_id, group_id) on delete cascade
);

create table public.tcgcsv_categories_current (
  source_id uuid not null references public.data_sources(id) on delete restrict,
  category_id integer not null check (category_id > 0),
  name text not null check (char_length(name) between 1 and 300),
  display_name text not null default '' check (char_length(display_name) <= 300),
  is_card_category boolean not null,
  category_sha256 text not null check (category_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 32768
  ),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  changed_at timestamptz not null,
  changed_by_run_id uuid not null references public.tcgcsv_catalog_runs(id) on delete restrict,
  primary key (source_id, category_id),
  check (first_seen_at <= changed_at and changed_at <= last_seen_at)
);

create table public.tcgcsv_groups_current (
  source_id uuid not null references public.data_sources(id) on delete restrict,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  name text not null check (char_length(name) between 1 and 500),
  abbreviation text not null default '' check (char_length(abbreviation) <= 120),
  published_on date,
  modified_on text not null default '' check (char_length(modified_on) <= 160),
  group_sha256 text not null check (group_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 32768
  ),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  changed_at timestamptz not null,
  changed_by_run_id uuid not null references public.tcgcsv_catalog_runs(id) on delete restrict,
  primary key (source_id, category_id, group_id),
  foreign key (source_id, category_id)
    references public.tcgcsv_categories_current(source_id, category_id) on delete restrict,
  check (first_seen_at <= changed_at and changed_at <= last_seen_at)
);

create index tcgcsv_groups_current_name_idx
  on public.tcgcsv_groups_current (source_id, category_id, name);

create table public.tcgcsv_products_current (
  source_id uuid not null references public.data_sources(id) on delete restrict,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  product_id bigint not null check (product_id > 0),
  name text not null check (char_length(name) between 1 and 700),
  clean_name text not null default '' check (char_length(clean_name) <= 700),
  card_number text not null default '' check (char_length(card_number) <= 160),
  rarity text not null default '' check (char_length(rarity) <= 300),
  card_type text not null default '' check (char_length(card_type) <= 300),
  modified_on text not null default '' check (char_length(modified_on) <= 160),
  product_sha256 text not null check (product_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 65536
  ),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  changed_at timestamptz not null,
  changed_by_run_id uuid not null references public.tcgcsv_catalog_runs(id) on delete restrict,
  primary key (source_id, category_id, group_id, product_id),
  foreign key (source_id, category_id, group_id)
    references public.tcgcsv_groups_current(source_id, category_id, group_id) on delete restrict,
  check (first_seen_at <= changed_at and changed_at <= last_seen_at)
);

create index tcgcsv_products_current_identity_idx
  on public.tcgcsv_products_current (source_id, category_id, group_id, card_number, name);
create index tcgcsv_products_current_product_idx
  on public.tcgcsv_products_current (source_id, product_id);

create table public.tcgcsv_unresolved_products (
  source_id uuid not null references public.data_sources(id) on delete restrict,
  category_id integer not null check (category_id > 0),
  group_id integer not null check (group_id > 0),
  product_id bigint not null check (product_id > 0),
  first_seen_on date not null,
  last_seen_on date not null,
  occurrence_count bigint not null default 1 check (occurrence_count > 0),
  resolved_at timestamptz,
  primary key (source_id, category_id, group_id, product_id),
  check (first_seen_on <= last_seen_on)
);

create index tcgcsv_unresolved_products_open_idx
  on public.tcgcsv_unresolved_products (source_id, category_id, group_id, last_seen_on desc)
  where resolved_at is null;

create table public.tcgcsv_sync_state (
  source_id uuid primary key references public.data_sources(id) on delete restrict,
  latest_archive_run_id uuid references public.tcgcsv_archive_runs(id) on delete restrict,
  latest_archive_date date,
  latest_source_updated_at timestamptz,
  latest_catalog_run_id uuid references public.tcgcsv_catalog_runs(id) on delete restrict,
  latest_catalog_updated_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check ((latest_archive_run_id is null) = (latest_archive_date is null)),
  check ((latest_catalog_run_id is null) = (latest_catalog_updated_at is null))
);

create or replace function public.assert_tcgcsv_private_research_source(
  requested_source_id uuid,
  requested_terms_review_id uuid,
  checked_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_row public.data_sources%rowtype;
  review_row public.source_terms_reviews%rowtype;
begin
  if checked_at is null then
    raise exception 'TCGCSV rights check requires a timestamp';
  end if;

  select * into source_row
  from public.data_sources
  where id = requested_source_id
  for share;
  select * into review_row
  from public.source_terms_reviews
  where id = requested_terms_review_id
    and source_id = requested_source_id
  for share;

  if source_row.id is null
     or review_row.id is null
     or source_row.code <> 'tcgcsv-research'
     or not source_row.active
     or source_row.current_terms_review_id is distinct from review_row.id
     or review_row.decision <> 'research_only'
     or review_row.commercial_use_allowed
     or review_row.catalog_metadata_allowed
     or review_row.image_display_allowed
     or review_row.public_raw_display_allowed
     or review_row.public_derived_display_allowed
     or review_row.expires_at is null
     or review_row.expires_at <= checked_at then
    raise exception 'TCGCSV market-universe ingestion requires the current unexpired private research-only review';
  end if;
end;
$$;

create or replace function public.tcgcsv_archive_run_is_open(requested_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.tcgcsv_archive_runs
    where id = requested_run_id and status = 'staging'
  )
$$;

create or replace function public.tcgcsv_catalog_run_is_open(requested_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.tcgcsv_catalog_runs
    where id = requested_run_id and status = 'staging'
  )
$$;

create or replace function public.begin_tcgcsv_archive_run(
  requested_source_id uuid,
  requested_terms_review_id uuid,
  requested_archive_date date,
  requested_source_updated_at timestamptz,
  requested_source_available_at timestamptz,
  requested_archive_sha256 text,
  requested_archive_bytes bigint,
  requested_expanded_bytes bigint,
  requested_object_uri text,
  requested_parquet_uri text,
  requested_parquet_sha256 text,
  requested_parquet_bytes bigint,
  requested_feature_object_uri text,
  requested_set_feature_object_uri text,
  requested_scope_sha256 text,
  requested_normalized_csv_sha256 text,
  requested_feature_csv_sha256 text,
  requested_set_feature_csv_sha256 text,
  requested_parser_version text,
  requested_category_count integer,
  requested_group_count integer,
  requested_price_count bigint,
  requested_feature_count bigint,
  requested_set_feature_count integer,
  requested_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  identity_sha256 text;
  existing_run public.tcgcsv_archive_runs%rowtype;
  created_id uuid;
begin
  perform public.assert_tcgcsv_private_research_source(
    requested_source_id, requested_terms_review_id, clock_timestamp()
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'collectfolio:tcgcsv:archive:' || requested_source_id::text, 0
  ));

  identity_sha256 := encode(digest(concat_ws('|',
    requested_source_id::text,
    requested_terms_review_id::text,
    requested_archive_date::text,
    requested_source_updated_at::text,
    requested_source_available_at::text,
    requested_archive_sha256,
    requested_object_uri,
    requested_parquet_uri,
    requested_feature_object_uri,
    requested_set_feature_object_uri,
    requested_scope_sha256,
    requested_normalized_csv_sha256,
    requested_feature_csv_sha256,
    requested_set_feature_csv_sha256,
    requested_parser_version
  ), 'sha256'), 'hex');

  select * into existing_run
  from public.tcgcsv_archive_runs
  where run_identity_sha256 = identity_sha256
  for update;
  if existing_run.id is not null then
    if existing_run.source_available_at <> requested_source_available_at
       or existing_run.archive_sha256 <> requested_archive_sha256
       or existing_run.archive_bytes <> requested_archive_bytes
       or existing_run.expanded_bytes <> requested_expanded_bytes
       or existing_run.parquet_sha256 <> requested_parquet_sha256
       or existing_run.parquet_bytes <> requested_parquet_bytes
       or existing_run.object_uri <> requested_object_uri
       or existing_run.parquet_uri <> requested_parquet_uri
       or existing_run.feature_object_uri <> requested_feature_object_uri
       or existing_run.set_feature_object_uri <> requested_set_feature_object_uri
       or existing_run.scope_sha256 <> requested_scope_sha256
       or existing_run.normalized_csv_sha256 <> requested_normalized_csv_sha256
       or existing_run.feature_csv_sha256 <> requested_feature_csv_sha256
       or existing_run.set_feature_csv_sha256 <> requested_set_feature_csv_sha256
       or existing_run.parser_version <> requested_parser_version
       or existing_run.expected_category_count <> requested_category_count
       or existing_run.expected_group_count <> requested_group_count
       or existing_run.expected_price_count <> requested_price_count
       or existing_run.expected_feature_count <> requested_feature_count
       or existing_run.expected_set_feature_count <> requested_set_feature_count then
      raise exception 'TCGCSV archive replay conflicts with its immutable manifest';
    end if;
    return existing_run.id;
  end if;

  if exists (
    select 1 from public.tcgcsv_archive_runs
    where source_id = requested_source_id and archive_date = requested_archive_date
  ) then
    raise exception 'TCGCSV archive date already exists with different identity; operator review required';
  end if;

  insert into public.tcgcsv_archive_runs (
    source_id, terms_review_id, archive_date, source_updated_at, source_available_at,
    archive_sha256, archive_bytes, expanded_bytes, object_uri,
    parquet_uri, parquet_sha256, parquet_bytes,
    feature_object_uri, set_feature_object_uri, scope_sha256,
    normalized_csv_sha256, feature_csv_sha256, set_feature_csv_sha256,
    parser_version, run_identity_sha256, expected_category_count,
    expected_group_count, expected_price_count, expected_feature_count,
    expected_set_feature_count, metadata
  ) values (
    requested_source_id, requested_terms_review_id, requested_archive_date,
    requested_source_updated_at, requested_source_available_at,
    lower(requested_archive_sha256),
    requested_archive_bytes, requested_expanded_bytes, requested_object_uri,
    requested_parquet_uri, lower(requested_parquet_sha256), requested_parquet_bytes,
    requested_feature_object_uri, requested_set_feature_object_uri,
    lower(requested_scope_sha256), lower(requested_normalized_csv_sha256),
    lower(requested_feature_csv_sha256), lower(requested_set_feature_csv_sha256),
    requested_parser_version, identity_sha256,
    requested_category_count, requested_group_count, requested_price_count,
    requested_feature_count, requested_set_feature_count,
    coalesce(requested_metadata, '{}'::jsonb)
  ) returning id into created_id;
  return created_id;
end;
$$;

create or replace function public.begin_tcgcsv_catalog_run(
  requested_source_id uuid,
  requested_terms_review_id uuid,
  requested_source_updated_at timestamptz,
  requested_scope_sha256 text,
  requested_catalog_content_sha256 text,
  requested_parser_version text,
  requested_category_count integer,
  requested_group_count integer,
  requested_product_count bigint,
  requested_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  identity_sha256 text;
  existing_run public.tcgcsv_catalog_runs%rowtype;
  created_id uuid;
begin
  perform public.assert_tcgcsv_private_research_source(
    requested_source_id, requested_terms_review_id, clock_timestamp()
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'collectfolio:tcgcsv:catalog:' || requested_source_id::text, 0
  ));
  identity_sha256 := encode(digest(concat_ws('|',
    requested_source_id::text,
    requested_terms_review_id::text,
    requested_source_updated_at::text,
    requested_scope_sha256,
    requested_catalog_content_sha256,
    requested_parser_version
  ), 'sha256'), 'hex');

  select * into existing_run
  from public.tcgcsv_catalog_runs
  where run_identity_sha256 = identity_sha256
  for update;
  if existing_run.id is not null then
    if existing_run.scope_sha256 <> requested_scope_sha256
       or existing_run.catalog_content_sha256 <> requested_catalog_content_sha256
       or existing_run.parser_version <> requested_parser_version
       or existing_run.expected_category_count <> requested_category_count
       or existing_run.expected_group_count <> requested_group_count
       or existing_run.expected_product_count <> requested_product_count then
      raise exception 'TCGCSV catalog replay conflicts with its immutable manifest';
    end if;
    return existing_run.id;
  end if;

  if exists (
    select 1 from public.tcgcsv_catalog_runs
    where source_id = requested_source_id
      and source_updated_at = requested_source_updated_at
  ) then
    raise exception 'TCGCSV catalog source timestamp already exists with different content; operator review required';
  end if;

  insert into public.tcgcsv_catalog_runs (
    source_id, terms_review_id, source_updated_at, scope_sha256, catalog_content_sha256,
    parser_version, run_identity_sha256, expected_category_count,
    expected_group_count, expected_product_count, metadata
  ) values (
    requested_source_id, requested_terms_review_id, requested_source_updated_at,
    lower(requested_scope_sha256), lower(requested_catalog_content_sha256),
    requested_parser_version, identity_sha256,
    requested_category_count, requested_group_count, requested_product_count,
    coalesce(requested_metadata, '{}'::jsonb)
  ) returning id into created_id;
  return created_id;
end;
$$;

create or replace function public.finalize_tcgcsv_archive_run(requested_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  run_row public.tcgcsv_archive_runs%rowtype;
  actual_category_count bigint;
  actual_group_count bigint;
  actual_price_count bigint;
  actual_feature_count bigint;
  actual_set_feature_count bigint;
  apply_current_state boolean;
begin
  select * into run_row
  from public.tcgcsv_archive_runs
  where id = requested_run_id
  for update;
  if run_row.id is null then
    raise exception 'TCGCSV archive run does not exist';
  end if;
  if run_row.status = 'sealed' then
    return jsonb_build_object(
      'runId', run_row.id,
      'status', run_row.status,
      'currentStateApplied', run_row.current_state_applied,
      'priceCount', run_row.expected_price_count,
      'featureCount', run_row.expected_feature_count
    );
  end if;

  perform public.assert_tcgcsv_private_research_source(
    run_row.source_id, run_row.terms_review_id, clock_timestamp()
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'collectfolio:tcgcsv:archive:' || run_row.source_id::text, 0
  ));
  select not exists (
    select 1
    from public.tcgcsv_sync_state state
    where state.source_id = run_row.source_id
      and (
        state.latest_archive_date > run_row.archive_date
        or state.latest_source_updated_at > run_row.source_updated_at
      )
  ) into apply_current_state;

  select count(*) into actual_category_count
    from public.tcgcsv_archive_run_categories where run_id = run_row.id;
  select count(*) into actual_group_count
    from public.tcgcsv_archive_group_receipts where run_id = run_row.id;
  select count(*) into actual_price_count
    from public.tcgcsv_price_stage where run_id = run_row.id;
  select count(*) into actual_feature_count
    from public.tcgcsv_market_feature_stage where run_id = run_row.id;
  select count(*) into actual_set_feature_count
    from public.tcgcsv_set_feature_stage where run_id = run_row.id;

  if actual_category_count <> run_row.expected_category_count
     or actual_group_count <> run_row.expected_group_count
     or actual_price_count <> run_row.expected_price_count
     or actual_feature_count <> run_row.expected_feature_count
     or actual_set_feature_count <> run_row.expected_set_feature_count
     or actual_feature_count <> actual_price_count
     or actual_set_feature_count <> actual_group_count then
    raise exception 'TCGCSV archive staging counts do not match the sealed manifest';
  end if;
  if (select coalesce(sum(row_count), 0)
      from public.tcgcsv_archive_group_receipts where run_id = run_row.id)
      <> actual_price_count then
    raise exception 'TCGCSV archive group receipts do not cover the staged price rows';
  end if;
  if exists (
    select 1 from public.tcgcsv_price_stage price
    where price.run_id = run_row.id
      and price.price_tuple_sha256 <> encode(digest(
        '{"directLowPrice":'
        || coalesce(to_jsonb(price.direct_low_price::text)::text, 'null')
        || ',"highPrice":'
        || coalesce(to_jsonb(price.high_price::text)::text, 'null')
        || ',"lowPrice":'
        || coalesce(to_jsonb(price.low_price::text)::text, 'null')
        || ',"marketPrice":'
        || coalesce(to_jsonb(price.market_price::text)::text, 'null')
        || ',"midPrice":'
        || coalesce(to_jsonb(price.mid_price::text)::text, 'null')
        || '}', 'sha256'
      ), 'hex')
  ) then
    raise exception 'TCGCSV staged price tuple hash is invalid';
  end if;
  if exists (
    select 1 from public.tcgcsv_price_stage price
    where price.run_id = run_row.id
      and price.series_sha256 <> encode(digest(concat_ws('|',
        price.category_id::text, price.group_id::text,
        price.product_id::text, price.subtype_name
      ), 'sha256'), 'hex')
  ) or exists (
    select 1
    from public.tcgcsv_market_feature_stage feature
    join public.tcgcsv_price_stage price
      on price.run_id = feature.run_id
     and price.category_id = feature.category_id
     and price.group_id = feature.group_id
     and price.product_id = feature.product_id
     and price.subtype_name = feature.subtype_name
    where feature.run_id = run_row.id
      and feature.series_sha256 <> price.series_sha256
  ) then
    raise exception 'TCGCSV staged series identity hash is invalid';
  end if;
  if exists (
    select 1 from public.tcgcsv_market_feature_stage feature
    where feature.run_id = run_row.id
      and concat_ws('|',
        feature.return_7d::text, feature.return_30d::text,
        feature.return_90d::text, feature.return_180d::text,
        feature.return_365d::text, feature.daily_log_slope_30d::text,
        feature.volatility_30d::text, feature.max_drawdown_365d::text,
        feature.history_density_365d::text, feature.trend_confidence::text,
        feature.opportunity_score::text
      ) ~ '(NaN|Infinity)'
  ) then
    raise exception 'TCGCSV market features must be finite';
  end if;

  if apply_current_state then
  insert into public.tcgcsv_price_current (
    source_id, category_id, group_id, product_id, subtype_name,
    series_sha256, low_price, mid_price, high_price, market_price,
    direct_low_price, price_tuple_sha256, first_seen_on,
    price_changed_on, changed_by_run_id
  )
  select
    run_row.source_id, price.category_id, price.group_id, price.product_id,
    price.subtype_name, price.series_sha256, price.low_price, price.mid_price,
    price.high_price, price.market_price, price.direct_low_price,
    price.price_tuple_sha256, run_row.archive_date, run_row.archive_date, run_row.id
  from public.tcgcsv_price_stage price
  where price.run_id = run_row.id
  on conflict (source_id, category_id, group_id, product_id, subtype_name)
  do update set
    series_sha256 = excluded.series_sha256,
    low_price = excluded.low_price,
    mid_price = excluded.mid_price,
    high_price = excluded.high_price,
    market_price = excluded.market_price,
    direct_low_price = excluded.direct_low_price,
    price_tuple_sha256 = excluded.price_tuple_sha256,
    price_changed_on = excluded.price_changed_on,
    changed_by_run_id = excluded.changed_by_run_id
  where row(
    public.tcgcsv_price_current.low_price,
    public.tcgcsv_price_current.mid_price,
    public.tcgcsv_price_current.high_price,
    public.tcgcsv_price_current.market_price,
    public.tcgcsv_price_current.direct_low_price,
    public.tcgcsv_price_current.price_tuple_sha256
  ) is distinct from row(
    excluded.low_price, excluded.mid_price, excluded.high_price,
    excluded.market_price, excluded.direct_low_price, excluded.price_tuple_sha256
  );

  delete from public.tcgcsv_price_current current_price
  using public.tcgcsv_archive_run_categories category
  where category.run_id = run_row.id
    and current_price.source_id = run_row.source_id
    and current_price.category_id = category.category_id
    and not exists (
      select 1 from public.tcgcsv_price_stage staged
      where staged.run_id = run_row.id
        and staged.category_id = current_price.category_id
        and staged.group_id = current_price.group_id
        and staged.product_id = current_price.product_id
        and staged.subtype_name = current_price.subtype_name
    );

  insert into public.tcgcsv_market_features_current (
    source_id, category_id, group_id, product_id, subtype_name,
    series_sha256, current_price, return_7d, return_30d, return_90d,
    return_180d, return_365d, daily_log_slope_30d, volatility_30d,
    max_drawdown_365d, history_density_365d, trend_status,
    trend_confidence, opportunity_score, opportunity_status,
    forecast_estimates, forecast_model_key, estimate_status,
    feature_sha256, changed_by_run_id
  )
  select
    run_row.source_id, feature.category_id, feature.group_id,
    feature.product_id, feature.subtype_name, feature.series_sha256,
    feature.current_price, feature.return_7d, feature.return_30d,
    feature.return_90d, feature.return_180d, feature.return_365d,
    feature.daily_log_slope_30d, feature.volatility_30d,
    feature.max_drawdown_365d, feature.history_density_365d,
    feature.trend_status, feature.trend_confidence,
    feature.opportunity_score, feature.opportunity_status,
    feature.forecast_estimates, feature.forecast_model_key,
    feature.estimate_status, feature.feature_sha256, run_row.id
  from public.tcgcsv_market_feature_stage feature
  where feature.run_id = run_row.id
  on conflict (source_id, category_id, group_id, product_id, subtype_name)
  do update set
    series_sha256 = excluded.series_sha256,
    current_price = excluded.current_price,
    return_7d = excluded.return_7d,
    return_30d = excluded.return_30d,
    return_90d = excluded.return_90d,
    return_180d = excluded.return_180d,
    return_365d = excluded.return_365d,
    daily_log_slope_30d = excluded.daily_log_slope_30d,
    volatility_30d = excluded.volatility_30d,
    max_drawdown_365d = excluded.max_drawdown_365d,
    history_density_365d = excluded.history_density_365d,
    trend_status = excluded.trend_status,
    trend_confidence = excluded.trend_confidence,
    opportunity_score = excluded.opportunity_score,
    opportunity_status = excluded.opportunity_status,
    forecast_estimates = excluded.forecast_estimates,
    forecast_model_key = excluded.forecast_model_key,
    estimate_status = excluded.estimate_status,
    feature_sha256 = excluded.feature_sha256,
    changed_by_run_id = excluded.changed_by_run_id
  -- feature_sha256 is a caller-authored content checksum, not an authenticity
  -- proof. Concrete values participate in change detection so a stale checksum
  -- can never suppress a real feature or estimate update.
  where row(
    public.tcgcsv_market_features_current.series_sha256,
    public.tcgcsv_market_features_current.current_price,
    public.tcgcsv_market_features_current.return_7d,
    public.tcgcsv_market_features_current.return_30d,
    public.tcgcsv_market_features_current.return_90d,
    public.tcgcsv_market_features_current.return_180d,
    public.tcgcsv_market_features_current.return_365d,
    public.tcgcsv_market_features_current.daily_log_slope_30d,
    public.tcgcsv_market_features_current.volatility_30d,
    public.tcgcsv_market_features_current.max_drawdown_365d,
    public.tcgcsv_market_features_current.history_density_365d,
    public.tcgcsv_market_features_current.trend_status,
    public.tcgcsv_market_features_current.trend_confidence,
    public.tcgcsv_market_features_current.opportunity_score,
    public.tcgcsv_market_features_current.opportunity_status,
    public.tcgcsv_market_features_current.forecast_estimates,
    public.tcgcsv_market_features_current.forecast_model_key,
    public.tcgcsv_market_features_current.estimate_status,
    public.tcgcsv_market_features_current.feature_sha256
  ) is distinct from row(
    excluded.series_sha256, excluded.current_price, excluded.return_7d,
    excluded.return_30d, excluded.return_90d, excluded.return_180d,
    excluded.return_365d, excluded.daily_log_slope_30d,
    excluded.volatility_30d, excluded.max_drawdown_365d,
    excluded.history_density_365d, excluded.trend_status,
    excluded.trend_confidence, excluded.opportunity_score,
    excluded.opportunity_status, excluded.forecast_estimates,
    excluded.forecast_model_key, excluded.estimate_status,
    excluded.feature_sha256
  );

  insert into public.tcgcsv_set_features_current (
    source_id, category_id, group_id, series_count, priced_series_count,
    median_return_30d, breadth_30d, median_volatility_30d,
    hotness_score, feature_status, feature_sha256, changed_by_run_id
  )
  select
    run_row.source_id, feature.category_id, feature.group_id,
    feature.series_count, feature.priced_series_count,
    feature.median_return_30d, feature.breadth_30d,
    feature.median_volatility_30d, feature.hotness_score,
    feature.feature_status, feature.feature_sha256, run_row.id
  from public.tcgcsv_set_feature_stage feature
  where feature.run_id = run_row.id
  on conflict (source_id, category_id, group_id)
  do update set
    series_count = excluded.series_count,
    priced_series_count = excluded.priced_series_count,
    median_return_30d = excluded.median_return_30d,
    breadth_30d = excluded.breadth_30d,
    median_volatility_30d = excluded.median_volatility_30d,
    hotness_score = excluded.hotness_score,
    feature_status = excluded.feature_status,
    feature_sha256 = excluded.feature_sha256,
    changed_by_run_id = excluded.changed_by_run_id
  -- As above, compare the actual set metrics as well as the caller checksum.
  where row(
    public.tcgcsv_set_features_current.series_count,
    public.tcgcsv_set_features_current.priced_series_count,
    public.tcgcsv_set_features_current.median_return_30d,
    public.tcgcsv_set_features_current.breadth_30d,
    public.tcgcsv_set_features_current.median_volatility_30d,
    public.tcgcsv_set_features_current.hotness_score,
    public.tcgcsv_set_features_current.feature_status,
    public.tcgcsv_set_features_current.feature_sha256
  ) is distinct from row(
    excluded.series_count, excluded.priced_series_count,
    excluded.median_return_30d, excluded.breadth_30d,
    excluded.median_volatility_30d, excluded.hotness_score,
    excluded.feature_status, excluded.feature_sha256
  );

  delete from public.tcgcsv_set_features_current current_feature
  using public.tcgcsv_archive_run_categories category
  where category.run_id = run_row.id
    and current_feature.source_id = run_row.source_id
    and current_feature.category_id = category.category_id
    and not exists (
      select 1 from public.tcgcsv_set_feature_stage staged
      where staged.run_id = run_row.id
        and staged.category_id = current_feature.category_id
        and staged.group_id = current_feature.group_id
    );

  insert into public.tcgcsv_unresolved_products (
    source_id, category_id, group_id, product_id,
    first_seen_on, last_seen_on, occurrence_count
  )
  select
    run_row.source_id, price.category_id, price.group_id, price.product_id,
    run_row.archive_date, run_row.archive_date, count(*)
  from public.tcgcsv_price_stage price
  left join public.tcgcsv_products_current product
    on product.source_id = run_row.source_id
   and product.category_id = price.category_id
   and product.group_id = price.group_id
   and product.product_id = price.product_id
  where price.run_id = run_row.id and product.product_id is null
  group by price.category_id, price.group_id, price.product_id
  on conflict (source_id, category_id, group_id, product_id)
  do update set
    last_seen_on = excluded.last_seen_on,
    occurrence_count = public.tcgcsv_unresolved_products.occurrence_count
      + excluded.occurrence_count,
    resolved_at = null;

  update public.tcgcsv_unresolved_products unresolved
  set resolved_at = clock_timestamp()
  where unresolved.source_id = run_row.source_id
    and unresolved.resolved_at is null
    and exists (
      select 1 from public.tcgcsv_products_current product
      where product.source_id = unresolved.source_id
        and product.category_id = unresolved.category_id
        and product.group_id = unresolved.group_id
        and product.product_id = unresolved.product_id
    );

  insert into public.tcgcsv_sync_state (
    source_id, latest_archive_run_id, latest_archive_date,
    latest_source_updated_at, updated_at
  ) values (
    run_row.source_id, run_row.id, run_row.archive_date,
    run_row.source_updated_at, clock_timestamp()
  )
  on conflict (source_id) do update set
    latest_archive_run_id = excluded.latest_archive_run_id,
    latest_archive_date = excluded.latest_archive_date,
    latest_source_updated_at = excluded.latest_source_updated_at,
    updated_at = excluded.updated_at
  where public.tcgcsv_sync_state.latest_archive_date is null
     or public.tcgcsv_sync_state.latest_archive_date <= excluded.latest_archive_date;
  end if;

  update public.tcgcsv_archive_runs
  set status = 'sealed',
      sealed_at = clock_timestamp(),
      current_state_applied = apply_current_state
  where id = run_row.id;

  delete from public.tcgcsv_market_feature_stage where run_id = run_row.id;
  delete from public.tcgcsv_set_feature_stage where run_id = run_row.id;
  delete from public.tcgcsv_price_stage where run_id = run_row.id;

  return jsonb_build_object(
    'runId', run_row.id,
    'status', 'sealed',
    'currentStateApplied', apply_current_state,
    'archiveDate', run_row.archive_date,
    'categoryCount', actual_category_count,
    'groupCount', actual_group_count,
    'priceCount', actual_price_count,
    'featureCount', actual_feature_count,
    'setFeatureCount', actual_set_feature_count
  );
end;
$$;

create or replace function public.finalize_tcgcsv_catalog_run(
  requested_run_id uuid,
  completed_with_gaps boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  run_row public.tcgcsv_catalog_runs%rowtype;
  actual_category_count bigint;
  actual_group_count bigint;
  actual_product_count bigint;
  completed_status text;
  apply_current_state boolean;
begin
  select * into run_row
  from public.tcgcsv_catalog_runs
  where id = requested_run_id
  for update;
  if run_row.id is null then
    raise exception 'TCGCSV catalog run does not exist';
  end if;
  if run_row.status <> 'staging' then
    return jsonb_build_object(
      'runId', run_row.id,
      'status', run_row.status,
      'currentStateApplied', run_row.current_state_applied,
      'categoryCount', run_row.expected_category_count,
      'groupCount', run_row.expected_group_count,
      'productCount', run_row.expected_product_count
    );
  end if;
  perform public.assert_tcgcsv_private_research_source(
    run_row.source_id, run_row.terms_review_id, clock_timestamp()
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'collectfolio:tcgcsv:catalog:' || run_row.source_id::text, 0
  ));
  select not exists (
    select 1
    from public.tcgcsv_sync_state state
    where state.source_id = run_row.source_id
      and state.latest_catalog_updated_at > run_row.source_updated_at
  ) into apply_current_state;

  select count(*) into actual_category_count
    from public.tcgcsv_category_stage where run_id = run_row.id;
  select count(*) into actual_group_count
    from public.tcgcsv_group_stage where run_id = run_row.id;
  select count(*) into actual_product_count
    from public.tcgcsv_product_stage where run_id = run_row.id;
  if actual_category_count <> run_row.expected_category_count
     or actual_group_count <> run_row.expected_group_count
     or actual_product_count <> run_row.expected_product_count then
    raise exception 'TCGCSV catalog staging counts do not match the sealed manifest';
  end if;

  if apply_current_state then
  insert into public.tcgcsv_categories_current (
    source_id, category_id, name, display_name, is_card_category,
    category_sha256, metadata, first_seen_at, last_seen_at,
    changed_at, changed_by_run_id
  )
  select
    run_row.source_id, category.category_id, category.name,
    category.display_name, category.is_card_category,
    category.category_sha256, category.metadata, run_row.source_updated_at,
    run_row.source_updated_at, run_row.source_updated_at, run_row.id
  from public.tcgcsv_category_stage category
  where category.run_id = run_row.id
  on conflict (source_id, category_id) do update set
    name = excluded.name,
    display_name = excluded.display_name,
    is_card_category = excluded.is_card_category,
    metadata = excluded.metadata,
    last_seen_at = greatest(
      public.tcgcsv_categories_current.last_seen_at, excluded.last_seen_at
    ),
    changed_at = case
      when row(
        public.tcgcsv_categories_current.name,
        public.tcgcsv_categories_current.display_name,
        public.tcgcsv_categories_current.is_card_category,
        public.tcgcsv_categories_current.metadata
      ) is distinct from row(
        excluded.name, excluded.display_name, excluded.is_card_category, excluded.metadata
      )
      then excluded.changed_at else public.tcgcsv_categories_current.changed_at end,
    changed_by_run_id = case
      when row(
        public.tcgcsv_categories_current.name,
        public.tcgcsv_categories_current.display_name,
        public.tcgcsv_categories_current.is_card_category,
        public.tcgcsv_categories_current.metadata
      ) is distinct from row(
        excluded.name, excluded.display_name, excluded.is_card_category, excluded.metadata
      )
      then excluded.changed_by_run_id else public.tcgcsv_categories_current.changed_by_run_id end,
    category_sha256 = excluded.category_sha256;

  insert into public.tcgcsv_groups_current (
    source_id, category_id, group_id, name, abbreviation, published_on,
    modified_on, group_sha256, metadata, first_seen_at, last_seen_at,
    changed_at, changed_by_run_id
  )
  select
    run_row.source_id, group_row.category_id, group_row.group_id,
    group_row.name, group_row.abbreviation, group_row.published_on,
    group_row.modified_on, group_row.group_sha256, group_row.metadata,
    run_row.source_updated_at, run_row.source_updated_at,
    run_row.source_updated_at, run_row.id
  from public.tcgcsv_group_stage group_row
  where group_row.run_id = run_row.id
  on conflict (source_id, category_id, group_id) do update set
    name = excluded.name,
    abbreviation = excluded.abbreviation,
    published_on = excluded.published_on,
    modified_on = excluded.modified_on,
    metadata = excluded.metadata,
    last_seen_at = greatest(public.tcgcsv_groups_current.last_seen_at, excluded.last_seen_at),
    changed_at = case
      when row(
        public.tcgcsv_groups_current.name,
        public.tcgcsv_groups_current.abbreviation,
        public.tcgcsv_groups_current.published_on,
        public.tcgcsv_groups_current.modified_on,
        public.tcgcsv_groups_current.metadata
      ) is distinct from row(
        excluded.name, excluded.abbreviation, excluded.published_on,
        excluded.modified_on, excluded.metadata
      )
      then excluded.changed_at else public.tcgcsv_groups_current.changed_at end,
    changed_by_run_id = case
      when row(
        public.tcgcsv_groups_current.name,
        public.tcgcsv_groups_current.abbreviation,
        public.tcgcsv_groups_current.published_on,
        public.tcgcsv_groups_current.modified_on,
        public.tcgcsv_groups_current.metadata
      ) is distinct from row(
        excluded.name, excluded.abbreviation, excluded.published_on,
        excluded.modified_on, excluded.metadata
      )
      then excluded.changed_by_run_id else public.tcgcsv_groups_current.changed_by_run_id end,
    group_sha256 = excluded.group_sha256;

  insert into public.tcgcsv_products_current (
    source_id, category_id, group_id, product_id, name, clean_name,
    card_number, rarity, card_type, modified_on, product_sha256,
    metadata, first_seen_at, last_seen_at, changed_at, changed_by_run_id
  )
  select
    run_row.source_id, product.category_id, product.group_id,
    product.product_id, product.name, product.clean_name,
    product.card_number, product.rarity, product.card_type,
    product.modified_on, product.product_sha256, product.metadata,
    run_row.source_updated_at, run_row.source_updated_at,
    run_row.source_updated_at, run_row.id
  from public.tcgcsv_product_stage product
  where product.run_id = run_row.id
  on conflict (source_id, category_id, group_id, product_id) do update set
    name = excluded.name,
    clean_name = excluded.clean_name,
    card_number = excluded.card_number,
    rarity = excluded.rarity,
    card_type = excluded.card_type,
    modified_on = excluded.modified_on,
    metadata = excluded.metadata,
    last_seen_at = greatest(public.tcgcsv_products_current.last_seen_at, excluded.last_seen_at),
    changed_at = case
      when row(
        public.tcgcsv_products_current.name,
        public.tcgcsv_products_current.clean_name,
        public.tcgcsv_products_current.card_number,
        public.tcgcsv_products_current.rarity,
        public.tcgcsv_products_current.card_type,
        public.tcgcsv_products_current.modified_on,
        public.tcgcsv_products_current.metadata
      ) is distinct from row(
        excluded.name, excluded.clean_name, excluded.card_number,
        excluded.rarity, excluded.card_type, excluded.modified_on, excluded.metadata
      )
      then excluded.changed_at else public.tcgcsv_products_current.changed_at end,
    changed_by_run_id = case
      when row(
        public.tcgcsv_products_current.name,
        public.tcgcsv_products_current.clean_name,
        public.tcgcsv_products_current.card_number,
        public.tcgcsv_products_current.rarity,
        public.tcgcsv_products_current.card_type,
        public.tcgcsv_products_current.modified_on,
        public.tcgcsv_products_current.metadata
      ) is distinct from row(
        excluded.name, excluded.clean_name, excluded.card_number,
        excluded.rarity, excluded.card_type, excluded.modified_on, excluded.metadata
      )
      then excluded.changed_by_run_id else public.tcgcsv_products_current.changed_by_run_id end,
    product_sha256 = excluded.product_sha256;

  update public.tcgcsv_unresolved_products unresolved
  set resolved_at = clock_timestamp()
  where unresolved.source_id = run_row.source_id
    and unresolved.resolved_at is null
    and exists (
      select 1 from public.tcgcsv_products_current product
      where product.source_id = unresolved.source_id
        and product.category_id = unresolved.category_id
        and product.group_id = unresolved.group_id
        and product.product_id = unresolved.product_id
    );

  insert into public.tcgcsv_sync_state (
    source_id, latest_catalog_run_id, latest_catalog_updated_at, updated_at
  ) values (
    run_row.source_id, run_row.id, run_row.source_updated_at, clock_timestamp()
  )
  on conflict (source_id) do update set
    latest_catalog_run_id = excluded.latest_catalog_run_id,
    latest_catalog_updated_at = excluded.latest_catalog_updated_at,
    updated_at = excluded.updated_at
  where public.tcgcsv_sync_state.latest_catalog_updated_at is null
     or public.tcgcsv_sync_state.latest_catalog_updated_at <= excluded.latest_catalog_updated_at;
  end if;

  completed_status := case when completed_with_gaps then 'partial' else 'sealed' end;
  update public.tcgcsv_catalog_runs
  set status = completed_status,
      sealed_at = clock_timestamp(),
      current_state_applied = apply_current_state
  where id = run_row.id;

  delete from public.tcgcsv_product_stage where run_id = run_row.id;
  delete from public.tcgcsv_group_stage where run_id = run_row.id;
  delete from public.tcgcsv_category_stage where run_id = run_row.id;

  return jsonb_build_object(
    'runId', run_row.id,
    'status', completed_status,
    'currentStateApplied', apply_current_state,
    'categoryCount', actual_category_count,
    'groupCount', actual_group_count,
    'productCount', actual_product_count
  );
end;
$$;

alter table public.tcgcsv_archive_runs enable row level security;
alter table public.tcgcsv_archive_run_categories enable row level security;
alter table public.tcgcsv_archive_group_receipts enable row level security;
alter table public.tcgcsv_price_stage enable row level security;
alter table public.tcgcsv_market_feature_stage enable row level security;
alter table public.tcgcsv_set_feature_stage enable row level security;
alter table public.tcgcsv_price_current enable row level security;
alter table public.tcgcsv_market_features_current enable row level security;
alter table public.tcgcsv_set_features_current enable row level security;
alter table public.tcgcsv_catalog_runs enable row level security;
alter table public.tcgcsv_category_stage enable row level security;
alter table public.tcgcsv_group_stage enable row level security;
alter table public.tcgcsv_product_stage enable row level security;
alter table public.tcgcsv_categories_current enable row level security;
alter table public.tcgcsv_groups_current enable row level security;
alter table public.tcgcsv_products_current enable row level security;
alter table public.tcgcsv_unresolved_products enable row level security;
alter table public.tcgcsv_sync_state enable row level security;

create policy tcgcsv_archive_categories_ingest
  on public.tcgcsv_archive_run_categories
  for insert to collectfolio_tcgcsv_ingest
  with check (public.tcgcsv_archive_run_is_open(run_id));
create policy tcgcsv_archive_groups_ingest
  on public.tcgcsv_archive_group_receipts
  for insert to collectfolio_tcgcsv_ingest
  with check (public.tcgcsv_archive_run_is_open(run_id));
create policy tcgcsv_prices_ingest
  on public.tcgcsv_price_stage
  for insert to collectfolio_tcgcsv_ingest
  with check (public.tcgcsv_archive_run_is_open(run_id));
create policy tcgcsv_market_features_ingest
  on public.tcgcsv_market_feature_stage
  for insert to collectfolio_tcgcsv_ingest
  with check (public.tcgcsv_archive_run_is_open(run_id));
create policy tcgcsv_set_features_ingest
  on public.tcgcsv_set_feature_stage
  for insert to collectfolio_tcgcsv_ingest
  with check (public.tcgcsv_archive_run_is_open(run_id));
create policy tcgcsv_categories_ingest
  on public.tcgcsv_category_stage
  for insert to collectfolio_tcgcsv_ingest
  with check (public.tcgcsv_catalog_run_is_open(run_id));
create policy tcgcsv_groups_ingest
  on public.tcgcsv_group_stage
  for insert to collectfolio_tcgcsv_ingest
  with check (public.tcgcsv_catalog_run_is_open(run_id));
create policy tcgcsv_products_ingest
  on public.tcgcsv_product_stage
  for insert to collectfolio_tcgcsv_ingest
  with check (public.tcgcsv_catalog_run_is_open(run_id));

create policy tcgcsv_categories_backend_read
  on public.tcgcsv_categories_current
  for select to collectfolio_tcgcsv_ingest using (true);
create policy tcgcsv_groups_backend_read
  on public.tcgcsv_groups_current
  for select to collectfolio_tcgcsv_ingest using (true);
create policy tcgcsv_products_backend_read
  on public.tcgcsv_products_current
  for select to collectfolio_tcgcsv_ingest using (true);
create policy tcgcsv_archive_runs_backend_read
  on public.tcgcsv_archive_runs
  for select to collectfolio_tcgcsv_ingest using (true);
create policy tcgcsv_catalog_runs_backend_read
  on public.tcgcsv_catalog_runs
  for select to collectfolio_tcgcsv_ingest using (true);
create policy tcgcsv_prices_backend_read
  on public.tcgcsv_price_current
  for select to collectfolio_tcgcsv_ingest using (true);
create policy tcgcsv_unresolved_backend_read
  on public.tcgcsv_unresolved_products
  for select to collectfolio_tcgcsv_ingest using (true);
create policy tcgcsv_sync_state_backend_read
  on public.tcgcsv_sync_state
  for select to collectfolio_tcgcsv_ingest using (true);

revoke all on table
  public.tcgcsv_archive_runs,
  public.tcgcsv_archive_run_categories,
  public.tcgcsv_archive_group_receipts,
  public.tcgcsv_price_stage,
  public.tcgcsv_market_feature_stage,
  public.tcgcsv_set_feature_stage,
  public.tcgcsv_price_current,
  public.tcgcsv_market_features_current,
  public.tcgcsv_set_features_current,
  public.tcgcsv_catalog_runs,
  public.tcgcsv_category_stage,
  public.tcgcsv_group_stage,
  public.tcgcsv_product_stage,
  public.tcgcsv_categories_current,
  public.tcgcsv_groups_current,
  public.tcgcsv_products_current,
  public.tcgcsv_unresolved_products,
  public.tcgcsv_sync_state
from public, anon, authenticated, service_role, collectfolio_tcgcsv_ingest;

grant select on table
  public.tcgcsv_archive_runs,
  public.tcgcsv_archive_run_categories,
  public.tcgcsv_archive_group_receipts,
  public.tcgcsv_price_stage,
  public.tcgcsv_market_feature_stage,
  public.tcgcsv_set_feature_stage,
  public.tcgcsv_price_current,
  public.tcgcsv_market_features_current,
  public.tcgcsv_set_features_current,
  public.tcgcsv_catalog_runs,
  public.tcgcsv_category_stage,
  public.tcgcsv_group_stage,
  public.tcgcsv_product_stage,
  public.tcgcsv_categories_current,
  public.tcgcsv_groups_current,
  public.tcgcsv_products_current,
  public.tcgcsv_unresolved_products,
  public.tcgcsv_sync_state
to service_role;

grant usage on schema public to collectfolio_tcgcsv_ingest;
grant insert on table
  public.tcgcsv_archive_run_categories,
  public.tcgcsv_archive_group_receipts,
  public.tcgcsv_price_stage,
  public.tcgcsv_market_feature_stage,
  public.tcgcsv_set_feature_stage,
  public.tcgcsv_category_stage,
  public.tcgcsv_group_stage,
  public.tcgcsv_product_stage
to collectfolio_tcgcsv_ingest;
grant select on table
  public.tcgcsv_archive_runs,
  public.tcgcsv_catalog_runs,
  public.tcgcsv_price_current,
  public.tcgcsv_categories_current,
  public.tcgcsv_groups_current,
  public.tcgcsv_products_current,
  public.tcgcsv_unresolved_products,
  public.tcgcsv_sync_state
to collectfolio_tcgcsv_ingest;

revoke execute on function public.assert_tcgcsv_private_research_source(uuid, uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.tcgcsv_archive_run_is_open(uuid)
  from public, anon, authenticated;
revoke execute on function public.tcgcsv_catalog_run_is_open(uuid)
  from public, anon, authenticated;
revoke execute on function public.begin_tcgcsv_archive_run(
  uuid, uuid, date, timestamptz, timestamptz, text, bigint, bigint, text, text,
  text, bigint, text, text, text, text, text, text, text,
  integer, integer, bigint, bigint, integer, jsonb
) from public, anon, authenticated;
revoke execute on function public.finalize_tcgcsv_archive_run(uuid)
  from public, anon, authenticated;
revoke execute on function public.begin_tcgcsv_catalog_run(
  uuid, uuid, timestamptz, text, text, text, integer, integer, bigint, jsonb
) from public, anon, authenticated;
revoke execute on function public.finalize_tcgcsv_catalog_run(uuid, boolean)
  from public, anon, authenticated;

grant execute on function public.tcgcsv_archive_run_is_open(uuid),
  public.tcgcsv_catalog_run_is_open(uuid),
  public.begin_tcgcsv_archive_run(
    uuid, uuid, date, timestamptz, timestamptz, text, bigint, bigint, text, text,
    text, bigint, text, text, text, text, text, text, text,
    integer, integer, bigint, bigint, integer, jsonb
  ),
  public.finalize_tcgcsv_archive_run(uuid),
  public.begin_tcgcsv_catalog_run(
    uuid, uuid, timestamptz, text, text, text, integer, integer, bigint, jsonb
  ),
  public.finalize_tcgcsv_catalog_run(uuid, boolean)
to collectfolio_tcgcsv_ingest, service_role;

-- The role is NOLOGIN by design.  Deployment creates a separate secret-bearing
-- login and grants only collectfolio_tcgcsv_ingest to it.  The application and
-- browser roles never inherit this capability.

commit;
