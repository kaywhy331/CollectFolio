-- Bind client-generated synchronization identifiers to their owning account.
--
-- Holdings and scan sessions originally used globally unique client UUIDs as
-- their primary keys even though every RLS policy was account-scoped. A UUID
-- collision across two collectors therefore failed at the global constraint
-- before RLS/account semantics could be represented by the key. Composite
-- ownership keys allow the same client identifier in separate accounts while
-- retaining every existing row and policy.

begin;

lock table public.holdings, public.scan_sessions in access exclusive mode;

alter table public.holdings
  drop constraint holdings_pkey,
  add constraint holdings_pkey primary key (user_id, id);

alter table public.scan_sessions
  drop constraint scan_sessions_pkey,
  add constraint scan_sessions_pkey primary key (user_id, id);

-- Keep direct identifier diagnostics efficient without restoring global
-- uniqueness. Normal collector access uses the account-leading primary keys.
create index holdings_id_idx on public.holdings (id);
create index scan_sessions_id_idx on public.scan_sessions (id);

commit;
