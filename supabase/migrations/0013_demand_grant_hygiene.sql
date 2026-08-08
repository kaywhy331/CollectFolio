-- CollectFolio demand-table grant hygiene
--
-- Migration 0007 granted the demand ledger's intended privileges but did not
-- first revoke the hosted platform's default table grants, which give browser
-- roles broad privileges on every newly created table. Row security already
-- denied all actual access (anon has no policy on demand_events, and the
-- aggregate table has a select policy only), so this closes a
-- defense-in-depth gap rather than an active leak — but the 0002 standard is
-- that grants state the complete intended surface, and 0012's self-check
-- rightly refuses to trust RLS alone.

begin;

revoke all on public.demand_events from anon, authenticated;
grant select, insert on public.demand_events to authenticated;

revoke all on public.aggregate_demand_snapshots from anon, authenticated;
grant select on public.aggregate_demand_snapshots to anon, authenticated;

do $$
begin
  if has_table_privilege('anon', 'public.demand_events', 'SELECT')
     or has_table_privilege('anon', 'public.demand_events', 'INSERT') then
    raise exception 'Anonymous role must not touch the demand ledger';
  end if;
  if has_table_privilege('authenticated', 'public.demand_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.demand_events', 'DELETE') then
    raise exception 'The demand ledger must be append-only for signed-in users';
  end if;
  if not has_table_privilege('authenticated', 'public.demand_events', 'INSERT') then
    raise exception 'Signed-in users must be able to record demand events';
  end if;
  if has_table_privilege('anon', 'public.aggregate_demand_snapshots', 'INSERT')
     or has_table_privilege('authenticated', 'public.aggregate_demand_snapshots', 'INSERT')
     or has_table_privilege('authenticated', 'public.aggregate_demand_snapshots', 'UPDATE')
     or has_table_privilege('authenticated', 'public.aggregate_demand_snapshots', 'DELETE') then
    raise exception 'Browser roles must only ever read the demand aggregate';
  end if;
  if not has_table_privilege('anon', 'public.aggregate_demand_snapshots', 'SELECT') then
    raise exception 'The privacy-gated aggregate must remain publicly readable';
  end if;
end;
$$;

commit;
