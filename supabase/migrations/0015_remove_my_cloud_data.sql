-- CollectFolio collector-controlled cloud-data removal
--
-- Intentionally checked in but not applied by the Phase 5 client release.
-- One authenticated RPC removes only rows owned by auth.uid(), retains the
-- authentication account/profile, and commits or rolls back as one call.

begin;

-- The artwork vote ledger stays append-only for every direct client and
-- service-role path. Its trigger permits DELETE only while this migration's
-- security-definer erasure RPC is executing for the same authenticated owner.
-- The transaction-local marker alone is insufficient: the trigger also checks
-- that current_user is the owner of remove_my_cloud_data(), so a service role
-- cannot opt itself into this exception with SET LOCAL.
create or replace function public.reject_artwork_vote_mutation_unless_erasure()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  erasure_function_owner name;
begin
  select pg_get_userbyid(proowner)
  into erasure_function_owner
  from pg_proc
  where oid = to_regprocedure('public.remove_my_cloud_data()');

  if tg_op = 'DELETE'
     and current_user = erasure_function_owner
     and current_setting('collectfolio.cloud_erasure_user_id', true) = old.user_id::text then
    return old;
  end if;

  raise exception '% is append-only', tg_table_name;
end;
$$;

drop trigger if exists artwork_pairwise_votes_append_only on public.artwork_pairwise_votes;
create trigger artwork_pairwise_votes_append_only
  before update or delete on public.artwork_pairwise_votes
  for each row execute function public.reject_artwork_vote_mutation_unless_erasure();

create or replace function public.remove_my_cloud_data()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  removed_holdings integer := 0;
  removed_holding_deletions integer := 0;
  removed_snapshots integer := 0;
  removed_scans integer := 0;
  removed_watchlists integer := 0;
  removed_watchlist_items integer := 0;
  removed_watchlist_deletions integer := 0;
  removed_demand_events integer := 0;
  removed_artwork_votes integer := 0;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  delete from public.watchlist_items where user_id = current_user_id;
  get diagnostics removed_watchlist_items = row_count;
  delete from public.watchlist_deletions where user_id = current_user_id;
  get diagnostics removed_watchlist_deletions = row_count;
  delete from public.watchlists where user_id = current_user_id;
  get diagnostics removed_watchlists = row_count;

  delete from public.holding_deletions where user_id = current_user_id;
  get diagnostics removed_holding_deletions = row_count;
  delete from public.portfolio_snapshots where user_id = current_user_id;
  get diagnostics removed_snapshots = row_count;
  delete from public.scan_sessions where user_id = current_user_id;
  get diagnostics removed_scans = row_count;
  delete from public.holdings where user_id = current_user_id;
  get diagnostics removed_holdings = row_count;
  delete from public.demand_events where user_id = current_user_id;
  get diagnostics removed_demand_events = row_count;

  perform set_config('collectfolio.cloud_erasure_user_id', current_user_id::text, true);
  delete from public.artwork_pairwise_votes where user_id = current_user_id;
  get diagnostics removed_artwork_votes = row_count;
  perform set_config('collectfolio.cloud_erasure_user_id', '', true);

  -- Keep the account/profile so the collector can continue signing in, but
  -- default future private-market participation to off after erasure.
  update public.profiles
  set display_name = '', demand_analytics_opt_out = true
  where id = current_user_id;

  return jsonb_build_object(
    'holdings', removed_holdings,
    'holdingDeletions', removed_holding_deletions,
    'snapshots', removed_snapshots,
    'scans', removed_scans,
    'watchlists', removed_watchlists,
    'watchlistItems', removed_watchlist_items,
    'watchlistDeletions', removed_watchlist_deletions,
    'privateMarketEvents', removed_demand_events,
    'artworkVotes', removed_artwork_votes
  );
end;
$$;

revoke all on function public.remove_my_cloud_data() from public, anon, authenticated, service_role;
grant execute on function public.remove_my_cloud_data() to authenticated;
revoke all on function public.reject_artwork_vote_mutation_unless_erasure() from public, anon, authenticated, service_role;

do $$
begin
  if has_function_privilege('anon', 'public.remove_my_cloud_data()', 'EXECUTE') then
    raise exception 'Anonymous users must not remove cloud data';
  end if;
  if not has_function_privilege('authenticated', 'public.remove_my_cloud_data()', 'EXECUTE') then
    raise exception 'Signed-in collectors must be able to remove their own cloud data';
  end if;
end;
$$;

commit;
