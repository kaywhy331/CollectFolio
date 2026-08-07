-- CollectFolio sealed-product registry (PRD Sec 15.6, 19.4)
--
-- Sealed prices exist so pull-probability and pack-cost features stay
-- separate variables (reducing reverse causality in scarcity features).
-- Restricted research data: no anon/authenticated access; snapshots are
-- append-only observations with both observed_at and available_at so the
-- point-in-time contract holds.

begin;

create table public.sealed_products (
  id uuid primary key,
  set_id uuid not null references public.catalog_sets(id) on delete restrict,
  product_type text not null check (product_type in (
    'loose_pack', 'booster_box', 'booster_bundle', 'elite_trainer_box',
    'collection_box', 'tin', 'other'
  )),
  name text not null check (char_length(name) between 1 and 200),
  packs_per_product integer not null check (packs_per_product >= 1),
  created_at timestamptz not null default now(),
  unique (set_id, product_type, name)
);

create table public.sealed_price_snapshots (
  id uuid primary key,
  product_id uuid not null references public.sealed_products(id) on delete restrict,
  source_id uuid not null references public.data_sources(id) on delete restrict,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  msrp numeric(12,2) check (msrp is null or msrp >= 0),
  market_price numeric(12,2) not null check (market_price > 0),
  -- packs_per_product lives on the parent, so full consistency is enforced
  -- by the analytics packet builder; the database still rejects the
  -- impossible case of a pack costing more than its whole product.
  unit_pack_price numeric(12,4) not null
    check (unit_pack_price > 0 and unit_pack_price <= market_price),
  observed_at timestamptz not null,
  available_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (product_id, source_id, observed_at),
  check (available_at >= observed_at)
);

create index sealed_price_snapshots_product_observed_idx
  on public.sealed_price_snapshots (product_id, observed_at desc);

create trigger sealed_price_snapshots_append_only
  before update or delete on public.sealed_price_snapshots
  for each row execute function public.reject_append_only_mutation();

alter table public.sealed_products enable row level security;
alter table public.sealed_price_snapshots enable row level security;

revoke all on public.sealed_products, public.sealed_price_snapshots
  from anon, authenticated;
grant select, insert on public.sealed_products, public.sealed_price_snapshots
  to service_role;
revoke update, delete on public.sealed_products, public.sealed_price_snapshots
  from service_role;

do $$
begin
  if has_table_privilege('anon', 'public.sealed_price_snapshots', 'SELECT')
     or has_table_privilege('authenticated', 'public.sealed_price_snapshots', 'SELECT')
     or has_table_privilege('anon', 'public.sealed_products', 'SELECT')
     or has_table_privilege('authenticated', 'public.sealed_products', 'SELECT') then
    raise exception 'Sealed-product research tables must not be browser-readable';
  end if;
  if has_table_privilege('service_role', 'public.sealed_price_snapshots', 'UPDATE')
     or has_table_privilege('service_role', 'public.sealed_price_snapshots', 'DELETE') then
    raise exception 'Sealed price snapshots must be append-only for the service role';
  end if;
end;
$$;

commit;
