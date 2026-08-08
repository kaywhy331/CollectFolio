-- Explicit missing-data ledger for the migration-0009 pull-rate registry.
-- A missing primary study or a source-reported unknown rate is evidence, not
-- a zero and not permission to impute a neighboring set. These rows are
-- private, service-role-only, and append-only like the observations they
-- qualify. A later study appends rates; it never erases the historical check.

begin;

create table public.pull_rate_unavailability (
  id uuid primary key,
  set_id uuid not null references public.catalog_sets(id) on delete restrict,
  source_id uuid references public.pull_rate_sources(id) on delete restrict,
  scope text not null check (scope in ('set', 'rarity_slot')),
  rarity_slot text check (rarity_slot is null or char_length(rarity_slot) between 1 and 120),
  reason text not null check (char_length(reason) between 1 and 2000),
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (
    (scope = 'set' and rarity_slot is null)
    or (scope = 'rarity_slot' and rarity_slot is not null)
  )
);

create unique index pull_rate_unavailability_identity_idx
  on public.pull_rate_unavailability (
    set_id, scope, coalesce(rarity_slot, ''), checked_at
  );
create index pull_rate_unavailability_set_checked_idx
  on public.pull_rate_unavailability (set_id, checked_at desc);

create trigger pull_rate_unavailability_append_only
  before update or delete on public.pull_rate_unavailability
  for each row execute function public.reject_append_only_mutation();

alter table public.pull_rate_unavailability enable row level security;

revoke all on public.pull_rate_unavailability from anon, authenticated;
grant select, insert on public.pull_rate_unavailability to service_role;
revoke update, delete on public.pull_rate_unavailability from service_role;

do $$
begin
  if has_table_privilege('anon', 'public.pull_rate_unavailability', 'SELECT')
     or has_table_privilege('authenticated', 'public.pull_rate_unavailability', 'SELECT') then
    raise exception 'Pull-rate unavailability evidence must not be browser-readable';
  end if;
  if has_table_privilege('service_role', 'public.pull_rate_unavailability', 'UPDATE')
     or has_table_privilege('service_role', 'public.pull_rate_unavailability', 'DELETE') then
    raise exception 'Pull-rate unavailability evidence must be append-only';
  end if;
  if not has_table_privilege('service_role', 'public.pull_rate_unavailability', 'INSERT') then
    raise exception 'Service role must be able to append pull-rate unavailability evidence';
  end if;
end;
$$;

commit;
