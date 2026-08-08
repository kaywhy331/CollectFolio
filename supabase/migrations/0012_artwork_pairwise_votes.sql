-- CollectFolio blind pairwise artwork voting (PRD Sec 15.7, 19.6, 23.5, 29.2)
--
-- Artwork preference is measured through blind pairwise votes, never
-- inferred from price. Raw votes are private per-user rows; derived score
-- snapshots are service-role research output published to users only
-- through the rights-gated intelligence pipeline.

begin;

create table public.artwork_pairwise_votes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  variant_a_id uuid not null references public.catalog_variants(id) on delete cascade,
  variant_b_id uuid not null references public.catalog_variants(id) on delete cascade,
  winner_variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  presented_at timestamptz not null,
  vote_day date not null default current_date,
  created_at timestamptz not null default now(),
  -- Canonical pair ordering prevents mirrored duplicates, and one vote per
  -- user/pair/day is the abuse-resistance rate limit (Sec 29.2), enforced
  -- by the database rather than trusted from the client.
  check (variant_a_id < variant_b_id),
  check (winner_variant_id = variant_a_id or winner_variant_id = variant_b_id),
  unique (user_id, variant_a_id, variant_b_id, vote_day)
);

create index artwork_votes_pair_idx
  on public.artwork_pairwise_votes (variant_a_id, variant_b_id);

create table public.artwork_score_snapshots (
  variant_id uuid not null references public.catalog_variants(id) on delete cascade,
  model_version text not null check (char_length(model_version) between 1 and 120),
  score numeric(6,5) not null check (score >= 0 and score <= 1),
  lower_bound numeric(6,5) not null check (lower_bound >= 0 and lower_bound <= score),
  upper_bound numeric(6,5) not null check (upper_bound >= score and upper_bound <= 1),
  vote_count integer not null check (vote_count > 0),
  calculated_at timestamptz not null,
  primary key (variant_id, model_version, calculated_at)
);

create trigger artwork_pairwise_votes_append_only
  before update or delete on public.artwork_pairwise_votes
  for each row execute function public.reject_append_only_mutation();

alter table public.artwork_pairwise_votes enable row level security;
alter table public.artwork_score_snapshots enable row level security;

create policy artwork_votes_select_own on public.artwork_pairwise_votes
  for select using (user_id = auth.uid());
create policy artwork_votes_insert_own on public.artwork_pairwise_votes
  for insert with check (user_id = auth.uid());
-- No update/delete policies: the vote ledger is append-only.

-- Hosted Supabase default privileges grant browser roles access to every new
-- table; revoke first so the grants below are the complete surface.
revoke all on public.artwork_pairwise_votes from anon, authenticated;
grant select, insert on public.artwork_pairwise_votes to authenticated;
revoke all on public.artwork_score_snapshots from anon, authenticated;
grant select, insert on public.artwork_score_snapshots to service_role;
revoke update, delete on public.artwork_score_snapshots from service_role;

do $$
begin
  if has_table_privilege('anon', 'public.artwork_pairwise_votes', 'SELECT') then
    raise exception 'Anonymous role must not read artwork votes';
  end if;
  if has_table_privilege('authenticated', 'public.artwork_pairwise_votes', 'UPDATE')
     or has_table_privilege('authenticated', 'public.artwork_pairwise_votes', 'DELETE') then
    raise exception 'The artwork vote ledger must be append-only for signed-in users';
  end if;
  if has_table_privilege('anon', 'public.artwork_score_snapshots', 'SELECT')
     or has_table_privilege('authenticated', 'public.artwork_score_snapshots', 'SELECT') then
    raise exception 'Artwork score snapshots must not be browser-readable';
  end if;
  if has_table_privilege('service_role', 'public.artwork_score_snapshots', 'UPDATE')
     or has_table_privilege('service_role', 'public.artwork_score_snapshots', 'DELETE') then
    raise exception 'Artwork score snapshots must be append-only for the service role';
  end if;
end;
$$;

commit;
