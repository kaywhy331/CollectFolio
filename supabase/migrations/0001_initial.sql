begin;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.holdings (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  user_image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint holdings_user_image_size check (user_image is null or octet_length(user_image) <= 225280)
);

create table if not exists public.holding_deletions (
  user_id uuid not null references auth.users(id) on delete cascade,
  holding_id uuid not null,
  deleted_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, holding_id)
);

create table if not exists public.portfolio_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  snapshot_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.scan_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'review' check (status in ('review', 'complete')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists holdings_user_updated_idx on public.holdings (user_id, updated_at desc);
create index if not exists holdings_user_catalog_idx on public.holdings (user_id, ((data ->> 'catalogId')));
create index if not exists holding_deletions_user_deleted_idx on public.holding_deletions (user_id, deleted_at desc);
create index if not exists portfolio_snapshots_user_date_idx on public.portfolio_snapshots (user_id, snapshot_date desc);
create index if not exists scan_sessions_user_updated_idx on public.scan_sessions (user_id, updated_at desc);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists holdings_set_updated_at on public.holdings;
create trigger holdings_set_updated_at before update on public.holdings for each row execute function public.set_updated_at();
drop trigger if exists portfolio_snapshots_set_updated_at on public.portfolio_snapshots;
create trigger portfolio_snapshots_set_updated_at before update on public.portfolio_snapshots for each row execute function public.set_updated_at();
drop trigger if exists scan_sessions_set_updated_at on public.scan_sessions;
create trigger scan_sessions_set_updated_at before update on public.scan_sessions for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.holdings enable row level security;
alter table public.holding_deletions enable row level security;
alter table public.portfolio_snapshots enable row level security;
alter table public.scan_sessions enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select using (id = auth.uid());
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles for insert with check (id = auth.uid());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles for delete using (id = auth.uid());

drop policy if exists holdings_select_own on public.holdings;
create policy holdings_select_own on public.holdings for select using (user_id = auth.uid());
drop policy if exists holdings_insert_own on public.holdings;
create policy holdings_insert_own on public.holdings for insert with check (user_id = auth.uid());
drop policy if exists holdings_update_own on public.holdings;
create policy holdings_update_own on public.holdings for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists holdings_delete_own on public.holdings;
create policy holdings_delete_own on public.holdings for delete using (user_id = auth.uid());

drop policy if exists holding_deletions_select_own on public.holding_deletions;
create policy holding_deletions_select_own on public.holding_deletions for select using (user_id = auth.uid());
drop policy if exists holding_deletions_insert_own on public.holding_deletions;
create policy holding_deletions_insert_own on public.holding_deletions for insert with check (user_id = auth.uid());
drop policy if exists holding_deletions_update_own on public.holding_deletions;
create policy holding_deletions_update_own on public.holding_deletions for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists holding_deletions_delete_own on public.holding_deletions;
create policy holding_deletions_delete_own on public.holding_deletions for delete using (user_id = auth.uid());

drop policy if exists portfolio_snapshots_select_own on public.portfolio_snapshots;
create policy portfolio_snapshots_select_own on public.portfolio_snapshots for select using (user_id = auth.uid());
drop policy if exists portfolio_snapshots_insert_own on public.portfolio_snapshots;
create policy portfolio_snapshots_insert_own on public.portfolio_snapshots for insert with check (user_id = auth.uid());
drop policy if exists portfolio_snapshots_update_own on public.portfolio_snapshots;
create policy portfolio_snapshots_update_own on public.portfolio_snapshots for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists portfolio_snapshots_delete_own on public.portfolio_snapshots;
create policy portfolio_snapshots_delete_own on public.portfolio_snapshots for delete using (user_id = auth.uid());

drop policy if exists scan_sessions_select_own on public.scan_sessions;
create policy scan_sessions_select_own on public.scan_sessions for select using (user_id = auth.uid());
drop policy if exists scan_sessions_insert_own on public.scan_sessions;
create policy scan_sessions_insert_own on public.scan_sessions for insert with check (user_id = auth.uid());
drop policy if exists scan_sessions_update_own on public.scan_sessions;
create policy scan_sessions_update_own on public.scan_sessions for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists scan_sessions_delete_own on public.scan_sessions;
create policy scan_sessions_delete_own on public.scan_sessions for delete using (user_id = auth.uid());

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.holdings, public.holding_deletions, public.portfolio_snapshots, public.scan_sessions to authenticated;

commit;
