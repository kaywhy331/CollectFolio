-- CollectFolio pull-rate registry (PRD Sec 15.5, 19.4)
--
-- Pull-rate data is curated, not scraped blindly: every probability row
-- cites a reviewed publication with its sample size and methodology, keeps
-- confidence-interval bounds, and records whether equal distribution within
-- a rarity slot was assumed. Rows are versioned and append-only — a
-- corrected estimate supersedes by version rather than rewriting history,
-- matching the external-mapping correction model from migration 0006.
--
-- This is restricted research data: no anon/authenticated grants at all.
-- The browser never reads pull rates directly; they reach users only as
-- recorded driver contributions inside a rights-approved publication.

begin;

create table public.pull_rate_sources (
  id uuid primary key default gen_random_uuid(),
  publisher text not null check (char_length(publisher) between 1 and 200),
  title text not null check (char_length(title) between 1 and 400),
  url text not null check (url like 'https://%'),
  published_at date,
  retrieved_at timestamptz not null,
  sample_size integer not null check (sample_size > 0),
  methodology text not null default '',
  region text not null default 'us',
  language text not null default 'en',
  confidence_grade text not null
    check (confidence_grade in ('high', 'medium', 'low')),
  created_at timestamptz not null default now(),
  unique (url, retrieved_at)
);

create table public.set_pull_rates (
  id uuid primary key,
  set_id uuid not null references public.catalog_sets(id) on delete restrict,
  source_id uuid not null references public.pull_rate_sources(id) on delete restrict,
  rarity_slot text not null check (char_length(rarity_slot) between 1 and 120),
  probability numeric(12,10) not null check (probability > 0 and probability <= 1),
  ci_lower numeric(12,10) check (ci_lower is null or (ci_lower > 0 and ci_lower <= probability)),
  ci_upper numeric(12,10) check (ci_upper is null or (ci_upper >= probability and ci_upper <= 1)),
  one_in_packs numeric(12,2) not null check (one_in_packs >= 1),
  eligible_count integer check (eligible_count is null or eligible_count > 0),
  specific_probability numeric(14,12)
    check (specific_probability is null or (specific_probability > 0 and specific_probability <= probability)),
  specific_one_in_packs numeric(14,2)
    check (specific_one_in_packs is null or specific_one_in_packs >= 1),
  equal_distribution_assumed boolean not null,
  collation_notes text not null default '',
  effective_from date not null,
  effective_to date check (effective_to is null or effective_to > effective_from),
  version integer not null check (version >= 1),
  created_at timestamptz not null default now(),
  unique (set_id, rarity_slot, source_id, version),
  -- Specific-card fields travel together with the eligible count and the
  -- explicit equal-distribution acknowledgment they were derived under.
  check (
    (eligible_count is null and specific_probability is null and specific_one_in_packs is null)
    or (eligible_count is not null and specific_probability is not null
        and specific_one_in_packs is not null and equal_distribution_assumed)
  )
);

create index set_pull_rates_set_slot_idx
  on public.set_pull_rates (set_id, rarity_slot, version desc);

-- Append-only: corrections supersede by version. Reuse the shared guard
-- from migration 0005/0006.
create trigger pull_rate_sources_append_only
  before update or delete on public.pull_rate_sources
  for each row execute function public.reject_append_only_mutation();
create trigger set_pull_rates_append_only
  before update or delete on public.set_pull_rates
  for each row execute function public.reject_append_only_mutation();

alter table public.pull_rate_sources enable row level security;
alter table public.set_pull_rates enable row level security;

revoke all on public.pull_rate_sources, public.set_pull_rates
  from anon, authenticated;
grant select, insert on public.pull_rate_sources, public.set_pull_rates
  to service_role;
revoke update, delete on public.pull_rate_sources, public.set_pull_rates
  from service_role;

do $$
begin
  if has_table_privilege('anon', 'public.pull_rate_sources', 'SELECT')
     or has_table_privilege('authenticated', 'public.pull_rate_sources', 'SELECT')
     or has_table_privilege('anon', 'public.set_pull_rates', 'SELECT')
     or has_table_privilege('authenticated', 'public.set_pull_rates', 'SELECT') then
    raise exception 'Pull-rate research tables must not be browser-readable';
  end if;
  if has_table_privilege('service_role', 'public.set_pull_rates', 'UPDATE')
     or has_table_privilege('service_role', 'public.set_pull_rates', 'DELETE') then
    raise exception 'Pull-rate rows must be append-only for the service role';
  end if;
  if not has_table_privilege('service_role', 'public.set_pull_rates', 'INSERT') then
    raise exception 'Service role must be able to insert pull-rate rows';
  end if;
end;
$$;

commit;
