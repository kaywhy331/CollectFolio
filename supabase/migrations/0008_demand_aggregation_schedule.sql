-- CollectFolio demand aggregation scheduling and raw-event retention
--
-- Migration 0007 created the demand ledger, the privacy-gated aggregate, and
-- the service-role-only rebuild function, but nothing invoked them. Per PRD
-- Sec 28 ("Supabase Cron handles short SQL maintenance/evaluation tasks
-- only"), the weekly aggregation and the raw-ledger retention sweep run as
-- pg_cron jobs rather than a GitHub Action holding a service-role secret.
--
-- pg_cron jobs execute as the scheduling role (postgres), which owns these
-- functions, so the deliberately narrow service_role-only EXECUTE grants
-- below are unaffected by scheduling.

begin;

create extension if not exists pg_cron;

-- Raw demand events are a private, limited-retention stream (PRD Sec 19.6).
-- Aggregation is weekly and retention is 90 days, so every event is covered
-- by roughly twelve aggregation passes before it ages out; the compact
-- aggregate rows persist indefinitely.
create or replace function public.prune_demand_events(retention_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer := 0;
begin
  -- Retention must never undercut the aggregation window: pruning events
  -- newer than the last completed weekly period would silently deflate a
  -- later rebuild of that period.
  if retention_days is null or retention_days < 30 then
    raise exception 'retention_days must be at least 30';
  end if;

  delete from public.demand_events
  where occurred_at < now() - make_interval(days => retention_days);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke execute on function public.prune_demand_events(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prune_demand_events(integer)
  to service_role;

-- Idempotent scheduling: replace any prior jobs with the same names so the
-- migration can be re-run against a rehearsal database.
do $$
declare
  job record;
begin
  for job in
    select jobid from cron.job
    where jobname in ('collectfolio-demand-aggregate-weekly', 'collectfolio-demand-prune-daily')
  loop
    perform cron.unschedule(job.jobid);
  end loop;
end;
$$;

-- Mondays 02:23 UTC: aggregate the previous full Monday-Sunday week. The
-- window is derived from date_trunc('week', ...) at execution time so every
-- run addresses one exact, non-overlapping calendar week; re-runs of the
-- same week upsert deterministically (rebuild is an ON CONFLICT DO UPDATE).
select cron.schedule(
  'collectfolio-demand-aggregate-weekly',
  '23 2 * * 1',
  $$
    select public.rebuild_aggregate_demand_snapshots(
      (date_trunc('week', now()) - interval '7 days')::date,
      (date_trunc('week', now()) - interval '1 day')::date
    );
  $$
);

-- Daily 03:41 UTC: retention sweep at the default 90 days.
select cron.schedule(
  'collectfolio-demand-prune-daily',
  '41 3 * * *',
  $$ select public.prune_demand_events(90); $$
);

do $$
begin
  if has_function_privilege('anon', 'public.prune_demand_events(integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.prune_demand_events(integer)', 'EXECUTE') then
    raise exception 'Browser roles must not execute the demand retention sweep';
  end if;
  if not has_function_privilege('service_role', 'public.prune_demand_events(integer)', 'EXECUTE') then
    raise exception 'Service role must execute the demand retention sweep';
  end if;
  if (select count(*) from cron.job
      where jobname in ('collectfolio-demand-aggregate-weekly', 'collectfolio-demand-prune-daily')) <> 2 then
    raise exception 'Both demand cron jobs must be scheduled exactly once';
  end if;
end;
$$;

commit;
