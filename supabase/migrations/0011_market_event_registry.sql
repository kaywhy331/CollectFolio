-- CollectFolio market-event registry (PRD Sec 15.7, 23.6, 31)
--
-- Reprints, restocks, anniversaries, media releases, tournament relevance,
-- and rotation changes are curated facts that become chart event badges and
-- lifecycle features (reprint_event_age, restock_event_age). Restricted
-- research data; rows are versioned and append-only like the pull-rate
-- registry.

begin;

create table public.card_market_events (
  id uuid primary key,
  scope text not null check (scope in ('set', 'variant')),
  set_id uuid references public.catalog_sets(id) on delete restrict,
  variant_id uuid references public.catalog_variants(id) on delete restrict,
  event_type text not null check (event_type in (
    'reprint', 'restock', 'anniversary', 'media_release', 'tournament',
    'rotation', 'other'
  )),
  occurred_on date not null,
  announced_on date check (announced_on is null or announced_on <= occurred_on),
  title text not null check (char_length(title) between 1 and 300),
  source_url text not null check (source_url like 'https://%'),
  notes text not null default '',
  version integer not null check (version >= 1),
  created_at timestamptz not null default now(),
  check (
    (scope = 'set' and set_id is not null and variant_id is null)
    or (scope = 'variant' and variant_id is not null and set_id is null)
  )
);

create unique index card_market_events_identity_idx
  on public.card_market_events (coalesce(set_id, variant_id), event_type, occurred_on, version);
create index card_market_events_lookup_idx
  on public.card_market_events (event_type, occurred_on desc);

create trigger card_market_events_append_only
  before update or delete on public.card_market_events
  for each row execute function public.reject_append_only_mutation();

alter table public.card_market_events enable row level security;

revoke all on public.card_market_events from anon, authenticated;
grant select, insert on public.card_market_events to service_role;
revoke update, delete on public.card_market_events from service_role;

do $$
begin
  if has_table_privilege('anon', 'public.card_market_events', 'SELECT')
     or has_table_privilege('authenticated', 'public.card_market_events', 'SELECT') then
    raise exception 'Market-event research table must not be browser-readable';
  end if;
  if has_table_privilege('service_role', 'public.card_market_events', 'UPDATE')
     or has_table_privilege('service_role', 'public.card_market_events', 'DELETE') then
    raise exception 'Market events must be append-only for the service role';
  end if;
end;
$$;

commit;
