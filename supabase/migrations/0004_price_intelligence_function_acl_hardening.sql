-- Supabase default privileges grant newly created functions explicitly to its
-- API roles. Revoke those grants per function; revoking PUBLIC alone is not
-- sufficient on a hosted project.

begin;

revoke execute on function public.get_or_create_default_watchlist()
  from public, anon;
grant execute on function public.get_or_create_default_watchlist()
  to authenticated, service_role;

revoke execute on function public.intelligence_publication_is_permitted(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.intelligence_publication_is_permitted(uuid)
  to anon, authenticated, service_role;

revoke execute on function public.publish_descriptive_intelligence(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_descriptive_intelligence(uuid)
  to service_role;

revoke execute on function public.validate_price_observation_lineage()
  from public, anon, authenticated, service_role;
revoke execute on function public.reject_append_only_mutation()
  from public, anon, authenticated, service_role;
revoke execute on function public.protect_terminal_analytics_run()
  from public, anon, authenticated, service_role;

do $$
begin
  if has_function_privilege('anon', 'public.get_or_create_default_watchlist()', 'EXECUTE') then
    raise exception 'Anonymous role must not execute the default-watchlist RPC';
  end if;
  if not has_function_privilege('authenticated', 'public.get_or_create_default_watchlist()', 'EXECUTE') then
    raise exception 'Authenticated role must execute the default-watchlist RPC';
  end if;
  if has_function_privilege('anon', 'public.publish_descriptive_intelligence(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.publish_descriptive_intelligence(uuid)', 'EXECUTE') then
    raise exception 'Browser roles must not execute descriptive publication';
  end if;
  if not has_function_privilege('service_role', 'public.publish_descriptive_intelligence(uuid)', 'EXECUTE') then
    raise exception 'Service role must execute descriptive publication';
  end if;
  if has_function_privilege('anon', 'public.validate_price_observation_lineage()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.validate_price_observation_lineage()', 'EXECUTE')
     or has_function_privilege('anon', 'public.reject_append_only_mutation()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.reject_append_only_mutation()', 'EXECUTE')
     or has_function_privilege('anon', 'public.protect_terminal_analytics_run()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.protect_terminal_analytics_run()', 'EXECUTE') then
    raise exception 'Trigger helpers must not be browser-executable';
  end if;
end;
$$;

commit;
