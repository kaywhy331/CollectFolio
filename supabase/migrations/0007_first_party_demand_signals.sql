-- CollectFolio first-party demand signals (PRD Sec 15.7, 19.6, 23.7, 29.2)
-- Adds a private, append-only per-user demand-event ledger and a privacy-
-- gated aggregate surface. Raw events never become anon/authenticated
-- readable; the aggregate is readable only once a period/variant clears the
-- minimum distinct-user threshold, and only a service-role job may write it.

begin;

-- Operator/test accounts must never inflate demand counts, and no signed-in
-- user may grant themselves that exemption by editing their own profile row.
alter table public.profiles
  add column is_operator boolean not null default false,
  add column demand_analytics_opt_out boolean not null default false;

create or replace function public.prevent_operator_self_promotion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_operator is distinct from old.is_operator and auth.role() <> 'service_role' then
    raise exception 'is_operator can only be changed by a service-role operator action';
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_operator_self_promotion
  before update on public.profiles
  for each row execute function public.prevent_operator_self_promotion();

revoke execute on function public.prevent_operator_self_promotion() from public, anon, authenticated, service_role;

-- Raw ledger. event_key is a client-computed rate-limit/dedup bucket (an
-- hour-truncated timestamp string); the unique constraint is the actual
-- rate limit, enforced atomically by the database rather than trusted from
-- the client (Sec 29.2: "Rate-limit repeated events per user/device/card").
create table public.demand_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  catalog_variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  event_type text not null check (event_type in (
    'watch_add', 'watch_remove', 'search_view', 'card_view',
    'portfolio_add', 'scan_confirm', 'alert_create'
  )),
  event_key text not null check (char_length(event_key) between 1 and 64),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, catalog_variant_id, event_type, event_key)
);

create index demand_events_variant_type_occurred_idx
  on public.demand_events (catalog_variant_id, event_type, occurred_at);
create index demand_events_user_occurred_idx
  on public.demand_events (user_id, occurred_at desc);

-- Public-safe surface. Column set matches PRD Sec 19.6 exactly; scan_confirm
-- and alert_create stay in the raw ledger only. A row is anon/authenticated
-- readable only once privacy_threshold_met is true for its exact period.
create table public.aggregate_demand_snapshots (
  catalog_variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  watch_adds integer not null default 0 check (watch_adds >= 0),
  watch_removes integer not null default 0 check (watch_removes >= 0),
  searches integer not null default 0 check (searches >= 0),
  portfolio_adds integer not null default 0 check (portfolio_adds >= 0),
  views integer not null default 0 check (views >= 0),
  unique_users integer not null default 0 check (unique_users >= 0),
  privacy_threshold_met boolean not null default false,
  generated_at timestamptz not null default now(),
  primary key (catalog_variant_id, period_start, period_end),
  check (period_end >= period_start)
);

-- Recomputes one period from the raw ledger, excluding operator/test
-- accounts and users who opted out of demand analytics (Sec 29.2: opt-out
-- must hold server-side even against a buggy or hostile client, and it
-- retroactively removes the user's history from future aggregation runs),
-- and gates public readability on a minimum distinct-user count.
-- Restricted to service_role below; intended to run from a scheduled job,
-- never from the browser (Sec 21, Sec 29.2).
create or replace function public.rebuild_aggregate_demand_snapshots(
  target_period_start date,
  target_period_end date,
  privacy_threshold integer default 20
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  written integer := 0;
begin
  if target_period_start is null or target_period_end is null then
    raise exception 'target_period_start and target_period_end are required';
  end if;
  if target_period_start > target_period_end then
    raise exception 'target_period_start cannot be after target_period_end';
  end if;
  if privacy_threshold is null or privacy_threshold < 1 then
    raise exception 'privacy_threshold must be a positive integer';
  end if;

  with scoped_events as (
    select event.catalog_variant_id, event.user_id, event.event_type
    from public.demand_events event
    join public.profiles author on author.id = event.user_id
    where author.is_operator = false
      and author.demand_analytics_opt_out = false
      and event.occurred_at >= target_period_start::timestamptz
      and event.occurred_at < (target_period_end + 1)::timestamptz
  ),
  aggregated as (
    select
      catalog_variant_id,
      count(*) filter (where event_type = 'watch_add') as watch_adds,
      count(*) filter (where event_type = 'watch_remove') as watch_removes,
      count(*) filter (where event_type = 'search_view') as searches,
      count(*) filter (where event_type = 'portfolio_add') as portfolio_adds,
      count(*) filter (where event_type = 'card_view') as views,
      count(distinct user_id) as unique_users
    from scoped_events
    group by catalog_variant_id
  ),
  written_rows as (
    insert into public.aggregate_demand_snapshots (
      catalog_variant_id, period_start, period_end, watch_adds, watch_removes,
      searches, portfolio_adds, views, unique_users, privacy_threshold_met, generated_at
    )
    select
      catalog_variant_id, target_period_start, target_period_end,
      watch_adds, watch_removes, searches, portfolio_adds, views, unique_users,
      unique_users >= privacy_threshold, now()
    from aggregated
    on conflict (catalog_variant_id, period_start, period_end) do update set
      watch_adds = excluded.watch_adds,
      watch_removes = excluded.watch_removes,
      searches = excluded.searches,
      portfolio_adds = excluded.portfolio_adds,
      views = excluded.views,
      unique_users = excluded.unique_users,
      privacy_threshold_met = excluded.privacy_threshold_met,
      generated_at = excluded.generated_at
    returning 1
  )
  select count(*) into written from written_rows;

  return written;
end;
$$;

alter table public.demand_events enable row level security;
alter table public.aggregate_demand_snapshots enable row level security;

create policy demand_events_select_own on public.demand_events
  for select using (user_id = auth.uid());
create policy demand_events_insert_own on public.demand_events
  for insert with check (user_id = auth.uid());
-- No update/delete policy: the ledger is append-only. A user who wants out
-- sets profiles.demand_analytics_opt_out instead of rewriting history.

create policy aggregate_demand_snapshots_public_read on public.aggregate_demand_snapshots
  for select using (privacy_threshold_met);

grant select, insert on public.demand_events to authenticated;
grant select on public.aggregate_demand_snapshots to anon, authenticated;

revoke execute on function public.rebuild_aggregate_demand_snapshots(date, date, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.rebuild_aggregate_demand_snapshots(date, date, integer)
  to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.rebuild_aggregate_demand_snapshots(date,date,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rebuild_aggregate_demand_snapshots(date,date,integer)', 'EXECUTE') then
    raise exception 'Browser roles must not execute the demand-aggregation job';
  end if;
  if not has_function_privilege('service_role', 'public.rebuild_aggregate_demand_snapshots(date,date,integer)', 'EXECUTE') then
    raise exception 'Service role must execute the demand-aggregation job';
  end if;
  if has_function_privilege('anon', 'public.prevent_operator_self_promotion()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.prevent_operator_self_promotion()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.prevent_operator_self_promotion()', 'EXECUTE') then
    raise exception 'Trigger helpers must not be directly executable';
  end if;
end;
$$;

commit;
