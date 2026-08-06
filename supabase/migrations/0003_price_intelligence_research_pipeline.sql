-- CollectFolio private price-intelligence research pipeline
-- Adds append-oriented mapping, observation, trend, and publication-review
-- ledgers. No browser role can read these tables, no source is approved here,
-- and the public feature flag remains unchanged.

begin;

alter table public.source_ingestion_runs
  add constraint source_ingestion_runs_lineage_unique
  unique (id, source_id, terms_review_id);

alter table public.external_card_mappings
  add constraint external_card_mappings_lineage_unique
  unique (id, source_id, variant_id);

create table public.catalog_mapping_candidates (
  id uuid primary key default gen_random_uuid(),
  ingestion_run_id uuid not null,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  external_product_id text not null check (char_length(external_product_id) between 1 and 500),
  external_variant_key text not null default '' check (char_length(external_variant_key) <= 500),
  proposed_variant_id uuid references public.catalog_variants(id) on delete restrict,
  candidate_rank integer not null default 1 check (candidate_rank > 0),
  mapping_confidence numeric(5,4) not null check (mapping_confidence between 0 and 1),
  mapping_method text not null,
  mapping_version text not null,
  disposition text not null check (disposition in ('exact','review','quarantined','unmapped')),
  reason_codes text[] not null default '{}',
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 65536),
  candidate_hash text not null check (candidate_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (ingestion_run_id, source_id, terms_review_id)
    references public.source_ingestion_runs(id, source_id, terms_review_id) on delete restrict,
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  unique (source_id, candidate_hash)
);

create index catalog_mapping_candidates_review_idx
  on public.catalog_mapping_candidates (disposition, created_at desc);
create index catalog_mapping_candidates_external_idx
  on public.catalog_mapping_candidates (source_id, external_product_id, external_variant_key);

create table public.catalog_mapping_review_events (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.catalog_mapping_candidates(id) on delete restrict,
  mapping_id uuid references public.external_card_mappings(id) on delete restrict,
  decision text not null check (decision in ('approved','rejected','quarantined','corrected')),
  resolved_variant_id uuid references public.catalog_variants(id) on delete restrict,
  reviewer_user_id uuid references auth.users(id) on delete set null,
  reviewer_label text not null check (char_length(reviewer_label) between 1 and 160),
  notes text not null default '' check (char_length(notes) <= 4000),
  mapping_version text not null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(candidate_id, mapping_id) = 1),
  check (decision not in ('approved','corrected') or resolved_variant_id is not null)
);

create index catalog_mapping_reviews_candidate_idx
  on public.catalog_mapping_review_events (candidate_id, created_at desc)
  where candidate_id is not null;
create index catalog_mapping_reviews_mapping_idx
  on public.catalog_mapping_review_events (mapping_id, created_at desc)
  where mapping_id is not null;

create table public.price_observations (
  id uuid primary key default gen_random_uuid(),
  ingestion_run_id uuid not null,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  mapping_id uuid not null,
  variant_id uuid not null references public.catalog_variants(id) on delete restrict,
  external_record_id text not null check (char_length(external_record_id) between 1 and 700),
  price_semantics text not null check (char_length(price_semantics) between 1 and 120),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  market_price numeric(16,4),
  observed_at timestamptz not null,
  available_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  quality_score numeric(5,4) not null default 0 check (quality_score between 0 and 1),
  observation_status text not null
    check (observation_status in ('accepted','missing','outlier','quarantined')),
  reason_codes text[] not null default '{}',
  source_record_hash text not null check (source_record_hash ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 65536),
  created_at timestamptz not null default now(),
  foreign key (ingestion_run_id, source_id, terms_review_id)
    references public.source_ingestion_runs(id, source_id, terms_review_id) on delete restrict,
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  foreign key (mapping_id, source_id, variant_id)
    references public.external_card_mappings(id, source_id, variant_id) on delete restrict,
  check (observed_at <= available_at),
  check (
    (observation_status = 'missing' and market_price is null)
    or (observation_status <> 'missing' and market_price > 0)
  ),
  unique (source_id, external_record_id, price_semantics, observed_at, source_record_hash)
);

create index price_observations_variant_time_idx
  on public.price_observations (variant_id, source_id, price_semantics, observed_at desc);
create index price_observations_accepted_time_idx
  on public.price_observations (variant_id, observed_at desc)
  where observation_status = 'accepted';
create index price_observations_quarantine_idx
  on public.price_observations (observation_status, created_at desc)
  where observation_status <> 'accepted';

create or replace function public.validate_price_observation_lineage()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  mapping_status text;
  mapping_confidence numeric;
  source_active boolean;
  source_current_review uuid;
  terms_decision text;
  terms_expiry timestamptz;
begin
  select review_status, external_card_mappings.mapping_confidence
    into mapping_status, mapping_confidence
  from public.external_card_mappings
  where id = new.mapping_id
    and source_id = new.source_id
    and variant_id = new.variant_id;

  if mapping_status is null then
    raise exception 'Exact source-to-variant mapping does not exist';
  end if;

  if new.observation_status <> 'quarantined'
     and (mapping_status <> 'approved' or mapping_confidence < 0.98) then
    raise exception 'Accepted observations require an approved mapping with confidence >= 0.98';
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

  return new;
end;
$$;

create trigger price_observations_validate_lineage
  before insert on public.price_observations
  for each row execute function public.validate_price_observation_lineage();

create table public.data_quality_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('source','ingestion_run','mapping','observation','variant','analytics_run','publication_candidate')),
  entity_id text not null check (char_length(entity_id) between 1 and 700),
  event_kind text not null check (event_kind in ('opened','quarantined','accepted','resolved','suppressed')),
  flag_code text not null check (flag_code ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  severity text not null check (severity in ('info','warning','error','critical')),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 65536),
  actor_label text not null check (char_length(actor_label) between 1 and 160),
  event_hash text not null unique check (event_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create index data_quality_events_entity_idx
  on public.data_quality_events (entity_type, entity_id, created_at desc);

create table public.analytics_runs (
  id uuid primary key default gen_random_uuid(),
  run_kind text not null check (run_kind in ('catalog_sync','mapping_build','trend_build','walk_forward','publication_build')),
  status text not null default 'running'
    check (status in ('running','succeeded','partial','failed','cancelled')),
  feature_cutoff timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  dataset_hash text check (dataset_hash is null or dataset_hash ~ '^[0-9a-f]{64}$'),
  source_policy_hash text not null check (source_policy_hash ~ '^[0-9a-f]{64}$'),
  mapping_version text not null,
  feature_version text not null,
  code_version text not null,
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 131072),
  records_read bigint not null default 0 check (records_read >= 0),
  records_written bigint not null default 0 check (records_written >= 0),
  records_quarantined bigint not null default 0 check (records_quarantined >= 0),
  error_summary text,
  created_at timestamptz not null default now(),
  check (completed_at is null or completed_at >= started_at),
  check (status = 'running' or completed_at is not null),
  check (status not in ('succeeded','partial') or dataset_hash is not null)
);

create index analytics_runs_kind_cutoff_idx
  on public.analytics_runs (run_kind, feature_cutoff desc, created_at desc);

create table public.analytics_run_sources (
  analytics_run_id uuid not null references public.analytics_runs(id) on delete restrict,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  usage_kind text not null check (usage_kind in ('catalog','raw_price','derived_feature')),
  created_at timestamptz not null default now(),
  primary key (analytics_run_id, source_id, terms_review_id, usage_kind),
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict
);

create table public.trend_feature_snapshots (
  id uuid primary key default gen_random_uuid(),
  analytics_run_id uuid not null references public.analytics_runs(id) on delete restrict,
  variant_id uuid not null references public.catalog_variants(id) on delete restrict,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  feature_cutoff timestamptz not null,
  price_current numeric(16,4) not null check (price_current > 0),
  return_7d numeric,
  return_30d numeric,
  return_90d numeric,
  return_180d numeric,
  return_365d numeric,
  robust_slope_30d numeric,
  robust_slope_90d numeric,
  momentum_acceleration numeric,
  volatility_30d numeric check (volatility_30d is null or volatility_30d >= 0),
  volatility_90d numeric check (volatility_90d is null or volatility_90d >= 0),
  max_drawdown_180d numeric check (max_drawdown_180d is null or max_drawdown_180d between 0 and 1),
  history_density_90d numeric(7,6) not null check (history_density_90d between 0 and 1),
  staleness_hours numeric not null check (staleness_hours >= 0),
  source_quality_90d numeric(7,6) not null check (source_quality_90d between 0 and 1),
  evidence_quality numeric(7,6) not null check (evidence_quality between 0 and 1),
  slope_z_90d numeric,
  trend_state text not null
    check (trend_state in ('strong_rise','rise','stable','fall','strong_fall','insufficient')),
  observation_count_90d integer not null check (observation_count_90d >= 0),
  reason_codes text[] not null default '{}',
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  unique (analytics_run_id, variant_id, source_id),
  unique (id, analytics_run_id, variant_id),
  unique (source_id, snapshot_hash)
);

create index trend_feature_snapshots_variant_cutoff_idx
  on public.trend_feature_snapshots (variant_id, feature_cutoff desc);

create table public.intelligence_publication_candidates (
  id uuid primary key default gen_random_uuid(),
  analytics_run_id uuid not null references public.analytics_runs(id) on delete restrict,
  trend_snapshot_id uuid not null references public.trend_feature_snapshots(id) on delete restrict,
  catalog_variant_id uuid not null references public.catalog_variants(id) on delete restrict,
  support_tier smallint not null check (support_tier between 0 and 2),
  publication_status text not null check (publication_status in ('published','unsupported','restricted','quarantined')),
  reason_codes text[] not null default '{}',
  payload jsonb not null
    check (
      jsonb_typeof(payload) = 'object'
      and octet_length(payload::text) <= 262144
      and not (payload ? 'fairValue')
      and not (payload ? 'forecasts')
    ),
  source_attributions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_attributions) = 'array' and octet_length(source_attributions::text) <= 32768),
  source_policy_hash text not null check (source_policy_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  proposed_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (trend_snapshot_id, analytics_run_id, catalog_variant_id)
    references public.trend_feature_snapshots(id, analytics_run_id, variant_id) on delete restrict,
  check (proposed_expires_at > created_at),
  unique (catalog_variant_id, payload_hash)
);

create table public.intelligence_candidate_sources (
  candidate_id uuid not null references public.intelligence_publication_candidates(id) on delete restrict,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  usage_kind text not null check (usage_kind in ('catalog','raw_price','derived_feature')),
  created_at timestamptz not null default now(),
  primary key (candidate_id, source_id, terms_review_id, usage_kind),
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict
);

create table public.intelligence_candidate_reviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.intelligence_publication_candidates(id) on delete restrict,
  decision text not null check (decision in ('approved','rejected')),
  source_rights_attested boolean not null default false,
  mapping_attested boolean not null default false,
  reviewer_user_id uuid references auth.users(id) on delete set null,
  reviewer_label text not null check (char_length(reviewer_label) between 1 and 160),
  notes text not null default '' check (char_length(notes) <= 4000),
  created_at timestamptz not null default now()
);

create index intelligence_candidate_reviews_latest_idx
  on public.intelligence_candidate_reviews (candidate_id, created_at desc);

create table public.intelligence_publication_promotions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.intelligence_publication_candidates(id) on delete restrict,
  catalog_variant_id uuid not null references public.catalog_variants(id) on delete restrict,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  reviewer_label text not null,
  promoted_at timestamptz not null default now()
);

create or replace function public.publish_descriptive_intelligence(requested_candidate_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  candidate public.intelligence_publication_candidates%rowtype;
  review public.intelligence_candidate_reviews%rowtype;
begin
  select * into candidate
  from public.intelligence_publication_candidates
  where id = requested_candidate_id;

  if candidate.id is null then
    raise exception 'Publication candidate not found';
  end if;

  select * into review
  from public.intelligence_candidate_reviews
  where candidate_id = requested_candidate_id
  order by created_at desc, id desc
  limit 1;

  if review.id is null
     or review.decision <> 'approved'
     or not review.source_rights_attested
     or not review.mapping_attested
     or review.created_at < candidate.created_at then
    raise exception 'Candidate lacks an approved mapping and source-rights review';
  end if;

  if candidate.support_tier > 2
     or candidate.publication_status <> 'published'
     or candidate.payload ? 'fairValue'
     or candidate.payload ? 'forecasts' then
    raise exception 'Only descriptive Tier 0-2 payloads can use this function';
  end if;

  if candidate.proposed_expires_at <= now() then
    raise exception 'Publication candidate has expired';
  end if;

  if not exists (
    select 1
    from public.analytics_runs run
    where run.id = candidate.analytics_run_id
      and run.status = 'succeeded'
      and run.source_policy_hash = candidate.source_policy_hash
  ) then
    raise exception 'Candidate analytics run is not successful or has different source policy';
  end if;

  if not exists (
    select 1 from public.intelligence_candidate_sources
    where candidate_id = requested_candidate_id
  ) then
    raise exception 'Candidate has no source lineage';
  end if;

  if exists (
    select 1
    from public.intelligence_candidate_sources lineage
    join public.data_sources source on source.id = lineage.source_id
    join public.source_terms_reviews terms on terms.id = lineage.terms_review_id
    where lineage.candidate_id = requested_candidate_id
      and (
        not source.active
        or source.current_terms_review_id is distinct from terms.id
        or terms.source_id <> source.id
        or terms.decision <> 'approved'
        or not terms.commercial_use_allowed
        or (terms.expires_at is not null and terms.expires_at <= now())
        or (lineage.usage_kind = 'catalog' and not terms.catalog_metadata_allowed)
        or (lineage.usage_kind = 'raw_price' and not terms.public_raw_display_allowed)
        or (lineage.usage_kind = 'derived_feature' and not terms.public_derived_display_allowed)
      )
  ) then
    raise exception 'Current source terms do not permit this publication';
  end if;

  if exists (
    select 1
    from public.intelligence_candidate_sources lineage
    where lineage.candidate_id = requested_candidate_id
      and not exists (
        select 1
        from public.analytics_run_sources run_source
        where run_source.analytics_run_id = candidate.analytics_run_id
          and run_source.source_id = lineage.source_id
          and run_source.terms_review_id = lineage.terms_review_id
          and run_source.usage_kind = lineage.usage_kind
      )
  ) then
    raise exception 'Candidate source lineage differs from its analytics run';
  end if;

  insert into public.card_intelligence_publications (
    catalog_variant_id, support_tier, publication_status, reason_codes, payload,
    source_attributions, source_policy_hash, payload_hash,
    public_display_allowed, published_at, expires_at
  ) values (
    candidate.catalog_variant_id, candidate.support_tier, candidate.publication_status,
    candidate.reason_codes, candidate.payload, candidate.source_attributions,
    candidate.source_policy_hash, candidate.payload_hash,
    true, now(), candidate.proposed_expires_at
  )
  on conflict (catalog_variant_id) do update set
    support_tier = excluded.support_tier,
    publication_status = excluded.publication_status,
    reason_codes = excluded.reason_codes,
    payload = excluded.payload,
    source_attributions = excluded.source_attributions,
    source_policy_hash = excluded.source_policy_hash,
    payload_hash = excluded.payload_hash,
    public_display_allowed = excluded.public_display_allowed,
    published_at = excluded.published_at,
    expires_at = excluded.expires_at;

  delete from public.intelligence_publication_sources
  where catalog_variant_id = candidate.catalog_variant_id;

  insert into public.intelligence_publication_sources (
    catalog_variant_id, source_id, terms_review_id, usage_kind
  )
  select candidate.catalog_variant_id, source_id, terms_review_id, usage_kind
  from public.intelligence_candidate_sources
  where candidate_id = requested_candidate_id;

  insert into public.intelligence_publication_promotions (
    candidate_id, catalog_variant_id, payload_hash, reviewer_label
  ) values (
    requested_candidate_id, candidate.catalog_variant_id,
    candidate.payload_hash, review.reviewer_label
  );

  return candidate.catalog_variant_id;
end;
$$;

create or replace function public.reject_append_only_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

create or replace function public.protect_terminal_analytics_run()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'analytics_runs is append-preserving';
  end if;
  if old.status <> 'running' then
    raise exception 'Terminal analytics runs are immutable';
  end if;
  if new.id <> old.id
     or new.run_kind <> old.run_kind
     or new.feature_cutoff is distinct from old.feature_cutoff
     or new.started_at <> old.started_at
     or new.created_at <> old.created_at
     or new.source_policy_hash <> old.source_policy_hash
     or new.mapping_version <> old.mapping_version
     or new.feature_version <> old.feature_version
     or new.code_version <> old.code_version
     or new.config_hash <> old.config_hash
     or new.config <> old.config then
    raise exception 'Analytics run provenance cannot change';
  end if;
  return new;
end;
$$;

create trigger analytics_runs_protect_terminal
  before update or delete on public.analytics_runs
  for each row execute function public.protect_terminal_analytics_run();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'catalog_mapping_candidates','catalog_mapping_review_events',
    'price_observations','data_quality_events','analytics_run_sources',
    'trend_feature_snapshots','intelligence_publication_candidates',
    'intelligence_candidate_sources','intelligence_candidate_reviews',
    'intelligence_publication_promotions'
  ]
  loop
    execute format(
      'create trigger %I_append_only before update or delete on public.%I for each row execute function public.reject_append_only_mutation()',
      table_name, table_name
    );
  end loop;
end;
$$;

alter table public.catalog_mapping_candidates enable row level security;
alter table public.catalog_mapping_review_events enable row level security;
alter table public.price_observations enable row level security;
alter table public.data_quality_events enable row level security;
alter table public.analytics_runs enable row level security;
alter table public.analytics_run_sources enable row level security;
alter table public.trend_feature_snapshots enable row level security;
alter table public.intelligence_publication_candidates enable row level security;
alter table public.intelligence_candidate_sources enable row level security;
alter table public.intelligence_candidate_reviews enable row level security;
alter table public.intelligence_publication_promotions enable row level security;

revoke all on public.catalog_mapping_candidates,
  public.catalog_mapping_review_events, public.price_observations,
  public.data_quality_events, public.analytics_runs, public.analytics_run_sources,
  public.trend_feature_snapshots, public.intelligence_publication_candidates,
  public.intelligence_candidate_sources, public.intelligence_candidate_reviews,
  public.intelligence_publication_promotions
  from anon, authenticated;

grant select, insert, update, delete on public.catalog_mapping_candidates,
  public.catalog_mapping_review_events, public.price_observations,
  public.data_quality_events, public.analytics_runs, public.analytics_run_sources,
  public.trend_feature_snapshots, public.intelligence_publication_candidates,
  public.intelligence_candidate_sources, public.intelligence_candidate_reviews,
  public.intelligence_publication_promotions
  to service_role;

revoke all on function public.validate_price_observation_lineage() from public;
revoke all on function public.publish_descriptive_intelligence(uuid) from public;
revoke all on function public.reject_append_only_mutation() from public;
revoke all on function public.protect_terminal_analytics_run() from public;
grant execute on function public.publish_descriptive_intelligence(uuid) to service_role;

commit;
