-- CollectFolio centralized historical-price imports.
--
-- Seals operator-owned, multi-series backfills against the existing exact
-- market-series and append-only observation ledgers.  This migration creates
-- no browser read path, forecast publisher, source approval, or feature-flag
-- mutation.  Availability provenance affects evaluation eligibility only; it
-- never blocks storage or a user's private estimate.

begin;

-- Preserve a provider/archive availability claim separately while keeping the
-- legacy available_at column safe for every existing feature/evaluation path.
-- Centralized imports rewrite available_at to no earlier than the database-
-- authored first-seen instant; legacy rows retain their established contract.
alter table public.price_observations disable trigger price_observations_append_only;
alter table public.price_observations
  add column source_available_at timestamptz,
  add column collectfolio_first_seen_at timestamptz;
alter table public.price_observations enable trigger price_observations_append_only;

create unique index source_ingestion_runs_central_history_import_idx
  on public.source_ingestion_runs ((metadata->>'historyImportId'))
  where metadata->>'contractVersion' = 'centralized-history-import-v1';

create table public.centralized_historical_price_imports (
  id uuid primary key,
  contract_version text not null
    check (contract_version = 'centralized-history-import-v1'),
  ingestion_run_id uuid not null unique,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  dataset_sha256 text not null check (dataset_sha256 ~ '^[0-9a-f]{64}$'),
  series_set_sha256 text not null check (series_set_sha256 ~ '^[0-9a-f]{64}$'),
  observation_set_sha256 text not null
    check (observation_set_sha256 ~ '^[0-9a-f]{64}$'),
  stored_rows_sha256 text not null check (stored_rows_sha256 ~ '^[0-9a-f]{64}$'),
  quality_policy_hash text not null check (quality_policy_hash ~ '^[0-9a-f]{64}$'),
  expected_series_count integer not null check (expected_series_count between 1 and 2000),
  expected_observation_count integer not null
    check (expected_observation_count between 1 and 100000),
  expected_accepted_count integer not null
    check (expected_accepted_count between 0 and expected_observation_count),
  observed_from timestamptz not null,
  observed_through timestamptz not null,
  available_from timestamptz not null,
  available_through timestamptz not null,
  first_seen_from timestamptz not null,
  first_seen_through timestamptz not null,
  ingested_at timestamptz not null,
  availability_semantics text not null check (availability_semantics in (
    'source_supplied', 'archive_release', 'operator_first_seen', 'observed_at_proxy'
  )),
  point_in_time_eligible boolean not null,
  mapping_version text not null check (char_length(mapping_version) between 1 and 160),
  parser_version text not null check (char_length(parser_version) between 1 and 160),
  code_version text not null check (char_length(code_version) between 1 and 200),
  operator_label text not null check (char_length(operator_label) between 1 and 160),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (ingestion_run_id, source_id, terms_review_id)
    references public.source_ingestion_runs(id, source_id, terms_review_id)
    on delete restrict,
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  unique (
    source_id, terms_review_id, dataset_sha256, mapping_version,
    quality_policy_hash, availability_semantics
  ),
  check (observed_from <= observed_through),
  check (available_from <= available_through),
  check (available_through <= ingested_at),
  check (first_seen_from <= first_seen_through),
  check (point_in_time_eligible = (availability_semantics <> 'observed_at_proxy'))
);

create index centralized_history_source_time_idx
  on public.centralized_historical_price_imports
  (source_id, observed_through desc, created_at desc);

-- Import membership is separate from physical row ownership so overlapping
-- rolling archives can reuse an exact immutable observation without moving it
-- away from the run that first stored it.  The deferred parent FK allows one
-- transaction to insert membership, validate it while sealing the manifest,
-- and create the parent manifest last.
create table public.centralized_historical_price_import_observations (
  import_id uuid not null,
  observation_id uuid not null references public.price_observations(id) on delete restrict,
  market_series_id uuid not null references public.market_series(id) on delete restrict,
  source_record_hash text not null check (source_record_hash ~ '^[0-9a-f]{64}$'),
  observation_status text not null
    check (observation_status in ('accepted','outlier','quarantined')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (import_id, observation_id),
  foreign key (import_id)
    references public.centralized_historical_price_imports(id) on delete restrict
    deferrable initially deferred
);

create index centralized_history_observation_membership_idx
  on public.centralized_historical_price_import_observations (observation_id, import_id);

-- Publication compilers must consume this database-owned join rather than a
-- pre-insert packet. One eligible sealed import is selected per immutable row,
-- so observed_at_proxy-only evidence never enters the export and overlapping
-- import membership does not duplicate observations.
create view public.centralized_history_publication_evidence
with (security_invoker = true)
as
select
  observation.id,
  observation.observation_status,
  observation.observed_at,
  observation.available_at,
  observation.source_available_at,
  observation.collectfolio_first_seen_at,
  observation.market_price,
  observation.quality_score,
  observation.external_record_id,
  observation.reason_codes,
  observation.market_series_id,
  series.catalog_variant_id as variant_id,
  series.source_id,
  series.identity_hash as market_series_identity_hash,
  series.mapping_version,
  series.currency,
  series.language,
  series.finish,
  series.condition_class,
  series.market_condition,
  series.price_semantics,
  sealed.centralized_import_id,
  sealed.centralized_import_point_in_time_eligible,
  sealed.centralized_import_created_at
from public.price_observations observation
join public.market_series series on series.id = observation.market_series_id
join lateral (
  select
    history_import.id as centralized_import_id,
    history_import.point_in_time_eligible
      as centralized_import_point_in_time_eligible,
    history_import.created_at as centralized_import_created_at
  from public.centralized_historical_price_import_observations membership
  join public.centralized_historical_price_imports history_import
    on history_import.id = membership.import_id
  where membership.observation_id = observation.id
    and history_import.point_in_time_eligible
  -- First eligibility is immutable: a later overlapping archive must not make
  -- this row disappear from an earlier retrospective cutoff.
  order by history_import.created_at asc, history_import.id
  limit 1
) sealed on true;

create or replace function public.validate_centralized_history_observation_membership()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  ingestion public.source_ingestion_runs%rowtype;
  observation public.price_observations%rowtype;
begin
  if exists (
    select 1 from public.centralized_historical_price_imports where id = new.import_id
  ) then
    raise exception 'A sealed centralized-history import cannot gain observations';
  end if;
  select * into ingestion
  from public.source_ingestion_runs
  where metadata->>'historyImportId' = new.import_id::text
  for share;
  if ingestion.id is null
     or ingestion.metadata->>'contractVersion' <> 'centralized-history-import-v1'
     or ingestion.status <> 'running'
     or ingestion.completed_at is not null then
    raise exception 'History membership requires its open centralized ingestion run';
  end if;
  select * into observation
  from public.price_observations where id = new.observation_id;
  if observation.id is null
     or observation.source_id <> ingestion.source_id
     or observation.terms_review_id <> ingestion.terms_review_id
     or observation.market_series_id is distinct from new.market_series_id
     or observation.source_record_hash <> new.source_record_hash
     or observation.observation_status <> new.observation_status
     or observation.source_available_at is null
     or observation.collectfolio_first_seen_at is null then
    raise exception 'History membership must reference exact centralized observation content';
  end if;
  new.created_at := clock_timestamp();
  return new;
end;
$$;

create trigger centralized_history_observation_membership_validate
  before insert on public.centralized_historical_price_import_observations
  for each row execute function public.validate_centralized_history_observation_membership();
create trigger centralized_history_observation_membership_append_only
  before update or delete on public.centralized_historical_price_import_observations
  for each row execute function public.reject_append_only_mutation();

create or replace function public.validate_centralized_historical_price_import()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  ingestion public.source_ingestion_runs%rowtype;
  current_review_id uuid;
  source_active boolean;
  review_decision text;
  review_reviewed_at timestamptz;
  review_expires_at timestamptz;
  actual_observation_count bigint;
  actual_accepted_count bigint;
  actual_series_count bigint;
  actual_observed_from timestamptz;
  actual_observed_through timestamptz;
  actual_available_from timestamptz;
  actual_available_through timestamptz;
  actual_first_seen_from timestamptz;
  actual_first_seen_through timestamptz;
  actual_dataset_sha256 text;
  actual_series_set_sha256 text;
  actual_observation_set_sha256 text;
  actual_stored_rows_sha256 text;
begin
  select * into ingestion
  from public.source_ingestion_runs
  where id = new.ingestion_run_id
    and source_id = new.source_id
    and terms_review_id = new.terms_review_id
  for update;
  if ingestion.id is null
     or ingestion.status not in ('succeeded', 'partial')
     or ingestion.completed_at is null
     or ingestion.records_read <> new.expected_observation_count
     or ingestion.records_written <> new.expected_observation_count
     or ingestion.records_quarantined < 0
     or ingestion.raw_payload_hash is distinct from new.dataset_sha256
     or ingestion.parser_version <> new.parser_version
     or ingestion.code_commit <> new.code_version
     or ingestion.metadata->>'contractVersion' <> new.contract_version
     or ingestion.metadata->>'historyImportId' <> new.id::text
     or ingestion.metadata->>'availabilitySemantics' <> new.availability_semantics
     or (ingestion.metadata->>'pointInTimeEligible')::boolean
          is distinct from new.point_in_time_eligible
     or ingestion.metadata->>'qualityPolicyHash' <> new.quality_policy_hash then
    raise exception 'Historical import requires its exact completed ingestion run';
  end if;

  select source.active, source.current_terms_review_id, review.decision,
         review.reviewed_at, review.expires_at
    into source_active, current_review_id, review_decision,
         review_reviewed_at, review_expires_at
  from public.data_sources source
  join public.source_terms_reviews review
    on review.id = new.terms_review_id and review.source_id = source.id
  where source.id = new.source_id
  for share of source, review;
  if not coalesce(source_active, false)
     or current_review_id is distinct from new.terms_review_id
     or review_decision not in ('research_only', 'approved')
     or review_reviewed_at > new.ingested_at
     or (review_expires_at is not null and review_expires_at <= new.ingested_at) then
    raise exception 'Historical import source terms are inactive, stale, or unusable';
  end if;

  -- A rolling archive may consist entirely of observations and series inserted
  -- by an earlier import, so their INSERT triggers will not run again. Recheck
  -- current mapping approval while sealing this new import instead of allowing
  -- exact physical overlap to bless lineage that has since been superseded.
  -- Hold every current mapping row through transaction commit so a concurrent
  -- supersession cannot make the just-sealed manifest stale after this check.
  perform mapping.id
  from public.centralized_historical_price_import_observations membership
  join public.price_observations observation
    on observation.id = membership.observation_id
  join public.market_series series
    on series.id = observation.market_series_id
  join public.external_card_mappings mapping
    on mapping.id = series.mapping_id
   and mapping.source_id = series.source_id
   and mapping.variant_id = series.catalog_variant_id
  where membership.import_id = new.id
  for share of mapping;

  if exists (
    select 1
    from public.centralized_historical_price_import_observations membership
    join public.price_observations observation
      on observation.id = membership.observation_id
    join public.market_series series
      on series.id = observation.market_series_id
    left join public.external_card_mappings mapping
      on mapping.id = series.mapping_id
     and mapping.source_id = series.source_id
     and mapping.variant_id = series.catalog_variant_id
    where membership.import_id = new.id
      and (
        mapping.id is null
        or mapping.review_status <> 'approved'
        or mapping.mapping_confidence < 0.98
        or mapping.superseded_at is not null
        or mapping.external_product_id <> series.provider_product_id
        or mapping.external_variant_key <> series.provider_variant_key
        or mapping.mapping_version <> series.mapping_version
      )
  ) then
    raise exception 'Historical import requires current exact approved mappings';
  end if;

  select
    count(*),
    count(*) filter (where observation.observation_status = 'accepted'),
    count(distinct observation.market_series_id),
    min(observation.observed_at), max(observation.observed_at),
    min(observation.source_available_at), max(observation.source_available_at),
    min(observation.collectfolio_first_seen_at),
    max(observation.collectfolio_first_seen_at),
    encode(digest(
      string_agg(
        series.identity_hash || '|' || observation.source_record_hash,
        E'\n' order by series.identity_hash, observation.source_record_hash
      ), 'sha256'
    ), 'hex'),
    encode(digest(
      string_agg(distinct series.identity_hash, E'\n' order by series.identity_hash),
      'sha256'
    ), 'hex'),
    encode(digest(
      string_agg(
        series.identity_hash || '|' || observation.source_record_hash || '|'
          || observation.observation_status,
        E'\n' order by series.identity_hash, observation.source_record_hash,
          observation.observation_status
      ), 'sha256'
    ), 'hex'),
    encode(digest(
      string_agg(concat_ws('|',
        observation.id::text, series.identity_hash,
        observation.external_record_id, observation.currency,
        observation.price_semantics, trim_scale(observation.market_price)::text,
        to_char(observation.observed_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        to_char(observation.source_available_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        to_char(observation.available_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        to_char(observation.collectfolio_first_seen_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        trim_scale(observation.quality_score)::text,
        observation.observation_status, observation.mapping_id::text,
        observation.variant_id::text
      ), E'\n' order by series.identity_hash, observation.source_record_hash,
        observation.observation_status), 'sha256'
    ), 'hex')
    into actual_observation_count, actual_accepted_count, actual_series_count,
         actual_observed_from, actual_observed_through,
         actual_available_from, actual_available_through,
         actual_first_seen_from, actual_first_seen_through,
         actual_dataset_sha256, actual_series_set_sha256,
         actual_observation_set_sha256, actual_stored_rows_sha256
  from public.centralized_historical_price_import_observations membership
  join public.price_observations observation
    on observation.id = membership.observation_id
  join public.market_series series on series.id = observation.market_series_id
  where membership.import_id = new.id
    and membership.market_series_id = observation.market_series_id
    and membership.source_record_hash = observation.source_record_hash
    and membership.observation_status = observation.observation_status
    and observation.source_id = new.source_id
    and observation.terms_review_id = new.terms_review_id
    and series.mapping_version = new.mapping_version;

  if actual_observation_count <> new.expected_observation_count
     or actual_accepted_count <> new.expected_accepted_count
     or actual_series_count <> new.expected_series_count
     or actual_observed_from is distinct from new.observed_from
     or actual_observed_through is distinct from new.observed_through
     or actual_available_from is distinct from new.available_from
     or actual_available_through is distinct from new.available_through
     or actual_dataset_sha256 is distinct from new.dataset_sha256
     or actual_series_set_sha256 is distinct from new.series_set_sha256
     or actual_observation_set_sha256 is distinct from new.observation_set_sha256 then
    raise exception 'Historical import counts, bounds, or sealed hashes do not match stored rows';
  end if;
  new.stored_rows_sha256 := actual_stored_rows_sha256;
  new.first_seen_from := actual_first_seen_from;
  new.first_seen_through := actual_first_seen_through;
  if ingestion.records_quarantined
       <> new.expected_observation_count - new.expected_accepted_count
     or ingestion.status is distinct from (case
       when new.expected_accepted_count = new.expected_observation_count
       then 'succeeded' else 'partial' end) then
    raise exception 'Historical import quality counts do not match its ingestion run';
  end if;
  if new.availability_semantics = 'operator_first_seen' and exists (
    select 1
    from public.centralized_historical_price_import_observations membership
    join public.price_observations observation
      on observation.id = membership.observation_id
    where membership.import_id = new.id
      and observation.source_available_at is distinct from new.ingested_at
  ) then
    raise exception 'operator_first_seen history must use the ingestion instant as availability';
  end if;
  if new.availability_semantics = 'observed_at_proxy' and exists (
    select 1
    from public.centralized_historical_price_import_observations membership
    join public.price_observations observation
      on observation.id = membership.observation_id
    where membership.import_id = new.id
      and observation.source_available_at is distinct from observation.observed_at
  ) then
    raise exception 'observed_at_proxy history must label its availability proxy explicitly';
  end if;

  -- The database authors the seal time. Caller-authored event time remains in
  -- the ingestion run and observation rows where it belongs.
  new.created_at := clock_timestamp();
  return new;
end;
$$;

create or replace function public.guard_centralized_history_observation_insert()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  ingestion public.source_ingestion_runs%rowtype;
  database_first_seen timestamptz := clock_timestamp();
  source_is_active boolean;
  source_current_review uuid;
  review_decision text;
  review_expires_at timestamptz;
begin
  select * into ingestion
  from public.source_ingestion_runs
  where id = new.ingestion_run_id
  for share;
  if ingestion.metadata->>'contractVersion' is distinct from
       'centralized-history-import-v1' then
    return new;
  end if;
  if ingestion.status <> 'running'
     or ingestion.completed_at is not null
     or exists (
       select 1 from public.centralized_historical_price_imports
       where ingestion_run_id = new.ingestion_run_id
     ) then
    raise exception 'Centralized-history observations require an open unsealed ingestion run';
  end if;
  select source.active, source.current_terms_review_id, review.decision,
         review.expires_at
    into source_is_active, source_current_review, review_decision,
         review_expires_at
  from public.data_sources source
  join public.source_terms_reviews review
    on review.id = new.terms_review_id and review.source_id = source.id
  where source.id = new.source_id;
  if not coalesce(source_is_active, false)
     or source_current_review is distinct from new.terms_review_id
     or review_decision not in ('research_only', 'approved')
     or (review_expires_at is not null and review_expires_at <= database_first_seen) then
    raise exception 'Centralized-history source rights are not current at first sight';
  end if;
  new.source_available_at := new.available_at;
  new.collectfolio_first_seen_at := database_first_seen;
  new.available_at := greatest(new.available_at, database_first_seen);
  return new;
end;
$$;

create trigger price_observations_000_guard_centralized_history
  before insert on public.price_observations
  for each row execute function public.guard_centralized_history_observation_insert();

create trigger centralized_historical_price_imports_validate
  before insert on public.centralized_historical_price_imports
  for each row execute function public.validate_centralized_historical_price_import();
create trigger centralized_historical_price_imports_append_only
  before update or delete on public.centralized_historical_price_imports
  for each row execute function public.reject_append_only_mutation();

create or replace function public.protect_sealed_history_ingestion_run()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if exists (
    select 1 from public.centralized_historical_price_imports
    where ingestion_run_id = old.id
  ) then
    raise exception 'A sealed centralized-history ingestion run is immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger source_ingestion_runs_protect_sealed_history
  before update or delete on public.source_ingestion_runs
  for each row execute function public.protect_sealed_history_ingestion_run();

alter table public.centralized_historical_price_imports enable row level security;
alter table public.centralized_historical_price_import_observations enable row level security;
revoke all on public.centralized_historical_price_imports
  from public, anon, authenticated, service_role;
revoke all on public.centralized_historical_price_import_observations
  from public, anon, authenticated, service_role;
revoke all on public.centralized_history_publication_evidence
  from public, anon, authenticated, service_role;
grant select, insert on public.centralized_historical_price_imports to service_role;
grant select, insert on public.centralized_historical_price_import_observations
  to service_role;
grant select on public.centralized_history_publication_evidence to service_role;
revoke execute on function public.validate_centralized_historical_price_import()
  from public, anon, authenticated, service_role;
revoke execute on function public.protect_sealed_history_ingestion_run()
  from public, anon, authenticated, service_role;
revoke execute on function public.guard_centralized_history_observation_insert()
  from public, anon, authenticated, service_role;
revoke execute on function public.validate_centralized_history_observation_membership()
  from public, anon, authenticated, service_role;

-- Historical storage is independent of forecast publication.  Keep the
-- current public boundary unchanged and install no forecast publication RPC.
do $$
begin
  if to_regprocedure('public.publish_forecast_intelligence(uuid)') is not null then
    raise exception 'Centralized history migration must not install a forecast publisher';
  end if;
end;
$$;

commit;
