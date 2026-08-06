-- CollectFolio Price Intelligence foundation
-- Adds governed source/catalog identity, exact-variant watchlists, and a narrow
-- publication boundary. It intentionally does not add or publish forecasts.

begin;

-- Source policy is versioned. A mutable boolean on an observation is not a
-- sufficient record of the terms under which it was ingested or published.
create table public.data_sources (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  name text not null,
  source_type text not null,
  terms_url text,
  active boolean not null default false,
  current_terms_review_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.source_terms_reviews (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_version text not null,
  terms_url text not null,
  decision text not null check (decision in ('pending','research_only','approved','rejected','expired')),
  commercial_use_allowed boolean not null default false,
  catalog_metadata_allowed boolean not null default false,
  image_display_allowed boolean not null default false,
  public_raw_display_allowed boolean not null default false,
  public_derived_display_allowed boolean not null default false,
  attribution_required boolean not null default false,
  attribution_text text,
  reviewed_at timestamptz not null default now(),
  expires_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  review_notes text,
  document_hash text not null,
  created_at timestamptz not null default now(),
  unique (source_id, terms_version),
  unique (id, source_id),
  check (expires_at is null or expires_at > reviewed_at)
);

alter table public.data_sources
  add constraint data_sources_current_terms_review_fk
  foreign key (current_terms_review_id, id)
  references public.source_terms_reviews(id, source_id)
  on delete restrict;

create table public.source_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running'
    check (status in ('running','succeeded','partial','failed','cancelled')),
  records_read bigint not null default 0 check (records_read >= 0),
  records_written bigint not null default 0 check (records_written >= 0),
  records_quarantined bigint not null default 0 check (records_quarantined >= 0),
  raw_payload_hash text,
  parser_version text not null,
  code_commit text not null,
  error_summary text,
  metadata jsonb not null default '{}'::jsonb,
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict,
  check (completed_at is null or completed_at >= started_at)
);

-- Canonical identity is private operational data in this migration. The PWA
-- receives only an approved publication payload, never raw source metadata.
create table public.catalog_sets (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  game text not null default 'pokemon',
  name text not null,
  series text,
  language text not null default 'en',
  release_date date,
  printed_total integer check (printed_total is null or printed_total >= 0),
  total integer check (total is null or total >= 0),
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.catalog_cards (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.catalog_sets(id) on delete restrict,
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
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (set_id, number, name)
);

create table public.catalog_variants (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.catalog_cards(id) on delete restrict,
  canonical_key text not null unique,
  language text not null default 'en',
  edition text not null default 'standard',
  finish text not null default 'unspecified',
  variant_name text not null default '',
  raw_condition_class text not null default 'raw'
    check (raw_condition_class in ('raw','graded','sealed','other')),
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (card_id, language, edition, finish, variant_name, raw_condition_class)
);

create table public.external_card_mappings (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id) on delete restrict,
  external_product_id text not null,
  external_variant_key text not null default '',
  variant_id uuid not null references public.catalog_variants(id) on delete restrict,
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

-- Existing holdings keep their JSON snapshot and app UUID. These nullable
-- columns provide a non-destructive bridge as mappings are approved.
alter table public.holdings
  add column catalog_variant_id uuid references public.catalog_variants(id) on delete set null,
  add column catalog_key text;

create index holdings_catalog_variant_idx
  on public.holdings (user_id, catalog_variant_id)
  where catalog_variant_id is not null;

-- V1 presents one default watchlist, while the schema leaves room for named
-- lists. Composite foreign keys prevent a row from claiming a different owner
-- than its parent watchlist.
create table public.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Watchlist' check (char_length(name) between 1 and 80),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create unique index watchlists_one_default_per_user_idx
  on public.watchlists (user_id) where is_default;

create table public.watchlist_items (
  watchlist_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  watch_key text not null check (char_length(watch_key) between 8 and 700),
  catalog_variant_id uuid references public.catalog_variants(id) on delete set null,
  catalog_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(catalog_snapshot) = 'object' and octet_length(catalog_snapshot::text) <= 32768),
  target_price numeric(14,4) check (target_price is null or target_price >= 0),
  alert_percent_change numeric(8,4) check (alert_percent_change is null or alert_percent_change >= 0),
  alert_trend_change boolean not null default false,
  alert_range_change boolean not null default false,
  alert_forecast_change boolean not null default false,
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (watchlist_id, watch_key),
  foreign key (watchlist_id, user_id)
    references public.watchlists(id, user_id) on delete cascade
);

create index watchlist_items_user_updated_idx
  on public.watchlist_items (user_id, updated_at desc);
create index watchlist_items_variant_idx
  on public.watchlist_items (catalog_variant_id)
  where catalog_variant_id is not null;

create table public.watchlist_deletions (
  watchlist_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  watch_key text not null check (char_length(watch_key) between 8 and 700),
  deleted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (watchlist_id, watch_key),
  foreign key (watchlist_id, user_id)
    references public.watchlists(id, user_id) on delete cascade
);

-- This is the only anonymous price-intelligence surface. Publishers write an
-- atomic, rights-reviewed payload; research/source tables remain ungranted.
create table public.card_intelligence_publications (
  catalog_variant_id uuid primary key references public.catalog_variants(id) on delete restrict,
  support_tier smallint not null default 0 check (support_tier between 0 and 5),
  publication_status text not null default 'unsupported'
    check (publication_status in ('published','unsupported','restricted','quarantined')),
  reason_codes text[] not null default '{}',
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  source_attributions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_attributions) = 'array' and octet_length(source_attributions::text) <= 32768),
  source_policy_hash text not null,
  payload_hash text not null,
  public_display_allowed boolean not null default false,
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at > published_at),
  check (public_display_allowed = false or publication_status = 'published')
);

create table public.intelligence_publication_sources (
  catalog_variant_id uuid not null references public.card_intelligence_publications(catalog_variant_id) on delete cascade,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  terms_review_id uuid not null references public.source_terms_reviews(id) on delete restrict,
  usage_kind text not null check (usage_kind in ('catalog','raw_price','derived_feature','image')),
  created_at timestamptz not null default now(),
  primary key (catalog_variant_id, source_id, terms_review_id, usage_kind),
  foreign key (terms_review_id, source_id)
    references public.source_terms_reviews(id, source_id) on delete restrict
);

create table public.product_feature_flags (
  key text primary key check (key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  enabled boolean not null default false,
  public_read boolean not null default false,
  description text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.product_feature_flags (key, enabled, public_read, description)
values
  ('watchlists', true, true, 'Local and authenticated watchlist experience'),
  ('public_price_intelligence', false, true, 'Rights-approved public trends and model outputs')
on conflict (key) do nothing;

-- Keep the RLS predicate small while evaluating current source status and the
-- exact versioned terms review for every source in a publication's lineage.
create or replace function public.intelligence_publication_is_permitted(requested_variant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.card_intelligence_publications publication
    where publication.catalog_variant_id = requested_variant_id
      and publication.public_display_allowed
      and publication.publication_status = 'published'
      and publication.published_at <= now()
      and (publication.expires_at is null or publication.expires_at > now())
      and exists (
        select 1
        from public.intelligence_publication_sources lineage
        where lineage.catalog_variant_id = publication.catalog_variant_id
      )
      and not exists (
        select 1
        from public.intelligence_publication_sources lineage
        join public.data_sources source on source.id = lineage.source_id
        join public.source_terms_reviews review on review.id = lineage.terms_review_id
        where lineage.catalog_variant_id = publication.catalog_variant_id
          and (
            not source.active
            or source.current_terms_review_id is distinct from review.id
            or review.source_id <> source.id
            or review.decision <> 'approved'
            or not review.commercial_use_allowed
            or (review.expires_at is not null and review.expires_at <= now())
            or (lineage.usage_kind = 'catalog' and not review.catalog_metadata_allowed)
            or (lineage.usage_kind = 'raw_price' and not review.public_raw_display_allowed)
            or (lineage.usage_kind = 'derived_feature' and not review.public_derived_display_allowed)
            or (lineage.usage_kind = 'image' and not review.image_display_allowed)
          )
      )
  );
$$;

revoke all on function public.intelligence_publication_is_permitted(uuid) from public;
grant execute on function public.intelligence_publication_is_permitted(uuid) to anon, authenticated;

-- The function is invoker-secured, so normal RLS and grants still apply.
create or replace function public.get_or_create_default_watchlist()
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  result_id uuid;
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  select id into result_id
  from public.watchlists
  where user_id = current_user_id and is_default
  limit 1;

  if result_id is null then
    insert into public.watchlists (user_id, name, is_default)
    values (current_user_id, 'Watchlist', true)
    on conflict do nothing
    returning id into result_id;
  end if;

  if result_id is null then
    select id into result_id
    from public.watchlists
    where user_id = current_user_id and is_default
    limit 1;
  end if;

  return result_id;
end;
$$;

-- updated_at is convenience state, not model provenance. Immutable analytics
-- ledgers will be introduced in a later migration with append-only guards.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'data_sources','catalog_sets','catalog_cards','catalog_variants',
    'external_card_mappings','watchlists','watchlist_items',
    'watchlist_deletions','card_intelligence_publications','product_feature_flags'
  ]
  loop
    execute format(
      'create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      table_name, table_name
    );
  end loop;
end;
$$;

alter table public.data_sources enable row level security;
alter table public.source_terms_reviews enable row level security;
alter table public.source_ingestion_runs enable row level security;
alter table public.catalog_sets enable row level security;
alter table public.catalog_cards enable row level security;
alter table public.catalog_variants enable row level security;
alter table public.external_card_mappings enable row level security;
alter table public.watchlists enable row level security;
alter table public.watchlist_items enable row level security;
alter table public.watchlist_deletions enable row level security;
alter table public.card_intelligence_publications enable row level security;
alter table public.intelligence_publication_sources enable row level security;
alter table public.product_feature_flags enable row level security;

create policy watchlists_select_own on public.watchlists
  for select using (user_id = auth.uid());
create policy watchlists_insert_own on public.watchlists
  for insert with check (user_id = auth.uid());
create policy watchlists_update_own on public.watchlists
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy watchlists_delete_own on public.watchlists
  for delete using (user_id = auth.uid());

create policy watchlist_items_select_own on public.watchlist_items
  for select using (user_id = auth.uid());
create policy watchlist_items_insert_own on public.watchlist_items
  for insert with check (user_id = auth.uid());
create policy watchlist_items_update_own on public.watchlist_items
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy watchlist_items_delete_own on public.watchlist_items
  for delete using (user_id = auth.uid());

create policy watchlist_deletions_select_own on public.watchlist_deletions
  for select using (user_id = auth.uid());
create policy watchlist_deletions_insert_own on public.watchlist_deletions
  for insert with check (user_id = auth.uid());
create policy watchlist_deletions_update_own on public.watchlist_deletions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy watchlist_deletions_delete_own on public.watchlist_deletions
  for delete using (user_id = auth.uid());

create policy intelligence_publications_public_read
  on public.card_intelligence_publications
  for select using (public.intelligence_publication_is_permitted(catalog_variant_id));

create policy product_feature_flags_public_read
  on public.product_feature_flags
  for select using (public_read);

grant select, insert, update, delete
  on public.watchlists, public.watchlist_items, public.watchlist_deletions
  to authenticated;
revoke all on function public.get_or_create_default_watchlist() from public;
grant execute on function public.get_or_create_default_watchlist() to authenticated;
grant select on public.card_intelligence_publications, public.product_feature_flags
  to anon, authenticated;
grant usage on schema public to anon, authenticated;

-- Explicitly preserve the restricted boundary if default grants change later.
revoke all on public.data_sources, public.source_terms_reviews,
  public.source_ingestion_runs, public.catalog_sets, public.catalog_cards,
  public.catalog_variants, public.external_card_mappings,
  public.intelligence_publication_sources
  from anon, authenticated;

commit;
