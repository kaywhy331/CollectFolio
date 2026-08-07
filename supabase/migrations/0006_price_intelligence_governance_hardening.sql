-- CollectFolio price-intelligence governance hardening
--
-- Closes the server-side rollback, immutable source-review, mapping-correction,
-- unscorable-evaluation, scorecard-membership, and promotion-integrity gaps.

begin;

-- The public feature flag is a database-enforced kill switch, not merely UI
-- state. Existing source-rights, expiry, and lineage checks remain mandatory.
create or replace function public.intelligence_publication_is_permitted(requested_variant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.card_intelligence_publications publication
    where publication.catalog_variant_id = requested_variant_id
      and exists (
        select 1
        from public.product_feature_flags flag
        where flag.key = 'public_price_intelligence'
          and flag.enabled
      )
      and publication.public_display_allowed
      and publication.publication_status = 'published'
      and publication.published_at <= now()
      and (publication.expires_at is null or publication.expires_at > now())
      and exists (
        select 1
        from public.intelligence_publication_sources lineage
        where lineage.catalog_variant_id = publication.catalog_variant_id
      )
      and not exists (
        select 1
        from public.intelligence_publication_sources lineage
        join public.data_sources source on source.id = lineage.source_id
        join public.source_terms_reviews review on review.id = lineage.terms_review_id
        where lineage.catalog_variant_id = publication.catalog_variant_id
          and (
            not source.active
            or source.current_terms_review_id is distinct from review.id
            or review.source_id <> source.id
            or review.decision <> 'approved'
            or not review.commercial_use_allowed
            or (review.expires_at is not null and review.expires_at <= now())
            or (lineage.usage_kind = 'catalog' and not review.catalog_metadata_allowed)
            or (lineage.usage_kind = 'raw_price' and not review.public_raw_display_allowed)
            or (lineage.usage_kind = 'derived_feature' and not review.public_derived_display_allowed)
            or (lineage.usage_kind = 'image' and not review.image_display_allowed)
          )
      )
      and not exists (
        select 1
        from public.intelligence_publication_sources lineage
        join public.source_terms_reviews review on review.id = lineage.terms_review_id
        where lineage.catalog_variant_id = publication.catalog_variant_id
          and review.attribution_required
          and not exists (
            select 1
            from jsonb_array_elements(publication.source_attributions) attribution
            where attribution->>'sourceId' = lineage.source_id::text
              and btrim(coalesce(attribution->>'attribution', ''))
                = btrim(coalesce(review.attribution_text, ''))
          )
      )
  );
$$;

revoke execute on function public.intelligence_publication_is_permitted(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.intelligence_publication_is_permitted(uuid)
  to anon, authenticated, service_role;

-- A terms review is evidence. Changes require a new review row and moving the
-- source's current review pointer; old rows cannot be rewritten in place.
alter table public.source_terms_reviews
  add constraint source_terms_reviews_document_hash_check
    check (document_hash ~ '^[0-9a-f]{64}$') not valid,
  add constraint source_terms_reviews_attribution_check
    check (not attribution_required or nullif(btrim(attribution_text), '') is not null) not valid,
  add constraint source_terms_reviews_public_rights_check
    check (
      decision = 'approved'
      or not (
        commercial_use_allowed or catalog_metadata_allowed or image_display_allowed
        or public_raw_display_allowed or public_derived_display_allowed
      )
    ) not valid;

alter table public.source_terms_reviews
  validate constraint source_terms_reviews_document_hash_check;
alter table public.source_terms_reviews
  validate constraint source_terms_reviews_attribution_check;
alter table public.source_terms_reviews
  validate constraint source_terms_reviews_public_rights_check;

create trigger source_terms_reviews_append_only
  before update or delete on public.source_terms_reviews
  for each row execute function public.reject_append_only_mutation();

revoke update, delete on public.source_terms_reviews from service_role;
grant select, insert on public.source_terms_reviews to service_role;

-- Mapping corrections create a replacement version and preserve the old row
-- referenced by historical observations.
alter table public.external_card_mappings
  add column supersedes_mapping_id uuid references public.external_card_mappings(id) on delete restrict,
  add column superseded_at timestamptz,
  add column correction_actor text,
  add column correction_reason text;

alter table public.external_card_mappings
  add constraint external_card_mappings_correction_evidence_check check (
    supersedes_mapping_id is null
    or (
      nullif(btrim(correction_actor), '') is not null
      and nullif(btrim(correction_reason), '') is not null
    )
  ),
  add constraint external_card_mappings_supersession_time_check check (
    superseded_at is null or superseded_at >= created_at
  );

do $$
declare
  old_constraints text[];
begin
  select array_agg(constraint_row.conname order by constraint_row.conname)
  into old_constraints
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.external_card_mappings'::regclass
    and constraint_row.contype = 'u'
    and (
      select array_agg(attribute.attname::text order by key_column.ordinality)
      from unnest(constraint_row.conkey) with ordinality
        as key_column(attnum, ordinality)
      join pg_attribute attribute
        on attribute.attrelid = constraint_row.conrelid
       and attribute.attnum = key_column.attnum
    ) = array['source_id','external_product_id','external_variant_key'];
  if cardinality(old_constraints) is distinct from 1 then
    raise exception 'Expected exactly one external-card mapping identity constraint, found %',
      coalesce(cardinality(old_constraints), 0);
  end if;
  execute format(
    'alter table public.external_card_mappings drop constraint %I', old_constraints[1]
  );
end;
$$;

create unique index external_card_mappings_current_external_key
  on public.external_card_mappings (source_id, external_product_id, external_variant_key)
  where superseded_at is null;

create unique index external_card_mappings_single_successor
  on public.external_card_mappings (supersedes_mapping_id)
  where supersedes_mapping_id is not null;

create or replace function public.validate_external_mapping_supersession()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  previous public.external_card_mappings%rowtype;
begin
  if new.supersedes_mapping_id is null then
    if new.superseded_at is not null
       or new.correction_actor is not null
       or new.correction_reason is not null then
      raise exception 'Initial mapping cannot claim supersession metadata';
    end if;
    return new;
  end if;

  select * into previous
  from public.external_card_mappings
  where id = new.supersedes_mapping_id;

  if previous.id is null
     or previous.superseded_at is null
     or new.superseded_at is not null
     or previous.source_id <> new.source_id
     or previous.external_product_id <> new.external_product_id
     or previous.external_variant_key <> new.external_variant_key
     or previous.mapping_version = new.mapping_version
     or new.created_at < previous.superseded_at then
    raise exception 'Replacement mapping does not form a valid active supersession';
  end if;
  return new;
end;
$$;

create trigger external_card_mappings_validate_supersession
  before insert on public.external_card_mappings
  for each row execute function public.validate_external_mapping_supersession();

create or replace function public.protect_external_mapping_identity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.source_id is distinct from old.source_id
     or new.external_product_id is distinct from old.external_product_id
     or new.external_variant_key is distinct from old.external_variant_key
     or new.variant_id is distinct from old.variant_id
     or new.mapping_version is distinct from old.mapping_version
     or new.supersedes_mapping_id is distinct from old.supersedes_mapping_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Mapping identity is immutable; create a superseding mapping version';
  end if;
  return new;
end;
$$;

create trigger external_card_mappings_protect_identity
  before update on public.external_card_mappings
  for each row execute function public.protect_external_mapping_identity();

create or replace function public.supersede_external_card_mapping(
  requested_mapping_id uuid,
  replacement_variant_id uuid,
  replacement_mapping_confidence numeric,
  replacement_mapping_method text,
  replacement_mapping_version text,
  reviewer_label text,
  correction_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  previous public.external_card_mappings%rowtype;
  replacement_id uuid := gen_random_uuid();
  actor_label text := nullif(btrim(reviewer_label), '');
  reason_text text := nullif(btrim(correction_reason), '');
begin
  if actor_label is null or reason_text is null then
    raise exception 'Mapping correction requires reviewer label and reason';
  end if;
  if replacement_mapping_confidence is null
     or replacement_mapping_confidence < 0
     or replacement_mapping_confidence > 1 then
    raise exception 'Mapping confidence must be between zero and one';
  end if;
  if nullif(btrim(replacement_mapping_method), '') is null
     or nullif(btrim(replacement_mapping_version), '') is null then
    raise exception 'Replacement mapping method and version are required';
  end if;

  select * into previous
  from public.external_card_mappings
  where id = requested_mapping_id
  for update;
  if previous.id is null then
    raise exception 'Mapping not found';
  end if;
  if previous.superseded_at is not null then
    raise exception 'Mapping has already been superseded';
  end if;

  update public.external_card_mappings
  set superseded_at = clock_timestamp(),
      review_status = 'rejected',
      reviewed_by = auth.uid(),
      reviewed_at = clock_timestamp(),
      notes = concat_ws(E'\n', nullif(notes, ''), 'Superseded: ' || reason_text)
  where id = previous.id;

  insert into public.external_card_mappings (
    id, source_id, external_product_id, external_variant_key, variant_id,
    mapping_confidence, mapping_method, mapping_version, review_status,
    reviewed_by, reviewed_at, notes, supersedes_mapping_id,
    correction_actor, correction_reason, created_at, updated_at
  ) values (
    replacement_id, previous.source_id, previous.external_product_id,
    previous.external_variant_key, replacement_variant_id,
    replacement_mapping_confidence, replacement_mapping_method,
    replacement_mapping_version, 'approved', auth.uid(), clock_timestamp(),
    reason_text, previous.id, actor_label, reason_text,
    clock_timestamp(), clock_timestamp()
  );

  insert into public.catalog_mapping_review_events (
    mapping_id, decision, resolved_variant_id, reviewer_user_id,
    reviewer_label, notes, mapping_version
  ) values (
    replacement_id, 'corrected', replacement_variant_id, auth.uid(),
    actor_label, reason_text, replacement_mapping_version
  );

  return replacement_id;
end;
$$;

revoke update, delete on public.external_card_mappings from service_role;
grant select, insert on public.external_card_mappings to service_role;
revoke execute on function public.protect_external_mapping_identity()
  from public, anon, authenticated, service_role;
revoke execute on function public.validate_external_mapping_supersession()
  from public, anon, authenticated, service_role;
revoke execute on function public.supersede_external_card_mapping(uuid,uuid,numeric,text,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.supersede_external_card_mapping(uuid,uuid,numeric,text,text,text,text)
  to service_role;

-- Separate model-definition lineage from a real training dataset. Existing
-- rows retain their legacy digest while new static baselines store NULL for a
-- training dataset and an explicit model-definition hash.
alter table public.model_versions disable trigger model_versions_append_only;
alter table public.model_versions
  add column training_mode text not null default 'trained',
  add column model_definition_hash text;
alter table public.model_versions
  alter column training_dataset_hash drop not null;
update public.model_versions
set training_mode = coalesce(nullif(config->>'trainingMode', ''), 'trained'),
    model_definition_hash = training_dataset_hash,
    training_dataset_hash = case
      when config->>'trainingMode' = 'none_static_baseline' then null
      else training_dataset_hash
    end;
alter table public.model_versions
  alter column model_definition_hash set not null,
  add constraint model_versions_training_mode_check
    check (training_mode in ('trained','none_static_baseline')),
  add constraint model_versions_training_lineage_check check (
    (training_mode = 'trained' and training_dataset_hash is not null)
    or (training_mode = 'none_static_baseline' and training_dataset_hash is null)
  ),
  add constraint model_versions_model_definition_hash_check
    check (model_definition_hash ~ '^[0-9a-f]{64}$');
alter table public.model_versions enable trigger model_versions_append_only;

-- Matured targets always receive an immutable outcome, including an explicit
-- Unscorable row when the declared target window has no accepted observation.
alter table public.forecast_evaluations disable trigger forecast_evaluations_append_only;
alter table public.forecast_evaluations
  add column evaluation_status text not null default 'scored',
  add column unscorable_reason text,
  add column target_window_start timestamptz,
  add column target_window_end timestamptz;
update public.forecast_evaluations
set target_window_start = maturity - interval '6 days',
    target_window_end = maturity;
alter table public.forecast_evaluations
  alter column target_window_start set not null,
  alter column target_window_end set not null,
  alter column realized_price drop not null,
  alter column observation_count drop not null,
  alter column absolute_log_error drop not null,
  alter column absolute_percentage_error drop not null,
  alter column direction_correct drop not null,
  drop constraint if exists forecast_evaluations_realized_price_check,
  drop constraint if exists forecast_evaluations_observation_count_check,
  drop constraint if exists forecast_evaluations_absolute_log_error_check,
  drop constraint if exists forecast_evaluations_absolute_percentage_error_check,
  add constraint forecast_evaluations_status_check
    check (evaluation_status in ('scored','unscorable')),
  add constraint forecast_evaluations_target_window_check check (
    target_window_end = maturity
    and target_window_start = maturity - interval '6 days'
  ),
  add constraint forecast_evaluations_outcome_check check (
    (
      evaluation_status = 'scored'
      and realized_price is not null and realized_price > 0
      and observation_count is not null and observation_count > 0
      and absolute_log_error is not null and absolute_log_error >= 0
      and absolute_percentage_error is not null and absolute_percentage_error >= 0
      and direction_correct is not null
      and unscorable_reason is null
    )
    or (
      evaluation_status = 'unscorable'
      and nullif(btrim(unscorable_reason), '') is not null
      and realized_price is null
      and exact_date_price is null
      and observation_count = 0
      and absolute_log_error is null
      and absolute_percentage_error is null
      and direction_correct is null
      and brier_component is null
      and pinball_losses = '{}'::jsonb
    )
  );
alter table public.forecast_evaluations enable trigger forecast_evaluations_append_only;

-- Scorecards persist the policy that judged them, the complete matured-case
-- partition, and a digest of exact evaluation membership.
alter table public.model_scorecards disable trigger model_scorecards_append_only;
alter table public.model_scorecards
  add column matured_count integer,
  add column unscorable_count integer not null default 0,
  add column excluded_count integer not null default 0,
  -- jsonb_build_object instead of a quoted JSON literal: the Supabase CLI
  -- statement splitter desyncs on double quotes inside single-quoted
  -- strings and truncates a later statement mid-push. Same value exactly.
  add column promotion_policy jsonb not null default jsonb_build_object('version', 'legacy-unversioned'),
  add column promotion_policy_hash text not null default repeat('0', 64),
  add column evaluation_membership_hash text not null default repeat('0', 64);
update public.model_scorecards
set matured_count = evaluation_count;
alter table public.model_scorecards
  alter column matured_count set not null,
  alter column matured_count set default 0,
  drop constraint if exists model_scorecards_evaluation_count_check,
  add constraint model_scorecards_evaluation_count_check check (evaluation_count >= 0),
  add constraint model_scorecards_case_partition_check check (
    matured_count >= 0 and unscorable_count >= 0 and excluded_count >= 0
    and matured_count = evaluation_count + unscorable_count + excluded_count
  ),
  add constraint model_scorecards_promotion_policy_check check (
    jsonb_typeof(promotion_policy) = 'object'
    and octet_length(promotion_policy::text) <= 32768
  ),
  add constraint model_scorecards_promotion_policy_hash_check
    check (promotion_policy_hash ~ '^[0-9a-f]{64}$'),
  add constraint model_scorecards_membership_hash_check
    check (evaluation_membership_hash ~ '^[0-9a-f]{64}$'),
  add constraint model_scorecards_evidence_contract_check check (
    (
      promotion_policy_hash = repeat('0', 64)
      and evaluation_membership_hash = repeat('0', 64)
      and promotion_policy->>'version' is not distinct from 'legacy-unversioned'
    )
    or (
      promotion_policy_hash <> repeat('0', 64)
      and evaluation_membership_hash <> repeat('0', 64)
      and nullif(btrim(promotion_policy->>'version'), '') is not null
      and promotion_policy->>'version' <> 'legacy-unversioned'
      and metrics->'maturedCount' is not distinct from to_jsonb(matured_count)
      and metrics->'unscorableCount' is not distinct from to_jsonb(unscorable_count)
      and metrics->'excludedCount' is not distinct from to_jsonb(excluded_count)
      and metrics->'promotionPolicy' is not distinct from promotion_policy
      and metrics->>'promotionPolicyHash' is not distinct from promotion_policy_hash
      and metrics->>'evaluationMembershipHash' is not distinct from evaluation_membership_hash
    )
  );
alter table public.model_scorecards enable trigger model_scorecards_append_only;

create table public.model_scorecard_evaluations (
  scorecard_id uuid not null references public.model_scorecards(id) on delete restrict,
  evaluation_id uuid not null references public.forecast_evaluations(id) on delete restrict,
  evaluation_status text not null check (evaluation_status in ('scored','unscorable')),
  included_in_metrics boolean not null,
  reason_codes text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (scorecard_id, evaluation_id)
);

create or replace function public.validate_scorecard_evaluation_membership()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  stored_status text;
  prediction_horizon integer;
  prediction_model uuid;
  prediction_status text;
  prediction_origin timestamptz;
  evaluation_run uuid;
  scorecard_horizon integer;
  scorecard_model uuid;
  scorecard_run uuid;
  scorecard_origin_start timestamptz;
  scorecard_origin_end timestamptz;
begin
  if exists (
    select 1 from public.model_promotion_reviews
    where scorecard_id = new.scorecard_id
  ) then
    raise exception 'Scorecard membership is frozen after its first review';
  end if;

  select evaluation.evaluation_status, evaluation.analytics_run_id,
         prediction.horizon_days, prediction.model_version_id,
         prediction.prediction_status, prediction.origin
  into stored_status, evaluation_run, prediction_horizon, prediction_model,
       prediction_status, prediction_origin
  from public.forecast_evaluations evaluation
  join public.card_forecast_predictions prediction on prediction.id = evaluation.prediction_id
  where evaluation.id = new.evaluation_id;

  select horizon_days, model_version_id, analytics_run_id, origin_start, origin_end
  into scorecard_horizon, scorecard_model, scorecard_run,
       scorecard_origin_start, scorecard_origin_end
  from public.model_scorecards
  where id = new.scorecard_id;

  if stored_status is null or scorecard_horizon is null
     or stored_status <> new.evaluation_status
     or prediction_horizon <> scorecard_horizon
     or prediction_model <> scorecard_model
     or evaluation_run <> scorecard_run
     or prediction_origin not between scorecard_origin_start and scorecard_origin_end then
    raise exception 'Scorecard evaluation membership lineage is inconsistent';
  end if;
  if new.included_in_metrics
     and (stored_status <> 'scored' or prediction_status <> 'research_only') then
    raise exception 'Only scored, eligible research predictions enter scorecard metrics';
  end if;
  if new.included_in_metrics and cardinality(new.reason_codes) <> 0 then
    raise exception 'Included scorecard membership cannot carry exclusion reasons';
  end if;
  if not new.included_in_metrics
     and prediction_status = 'research_only'
     and stored_status = 'scored' then
    raise exception 'Eligible scored evaluation must enter scorecard metrics';
  end if;
  if not new.included_in_metrics and new.reason_codes <> case
    when prediction_status = 'quarantined'
      then array['quarantined_prediction_excluded']
    when stored_status = 'unscorable'
      then array['unscorable_target_excluded']
    else array[]::text[]
  end then
    raise exception 'Excluded scorecard membership reason is inconsistent';
  end if;
  return new;
end;
$$;

create trigger model_scorecard_evaluations_validate
  before insert on public.model_scorecard_evaluations
  for each row execute function public.validate_scorecard_evaluation_membership();
create trigger model_scorecard_evaluations_append_only
  before update or delete on public.model_scorecard_evaluations
  for each row execute function public.reject_append_only_mutation();

alter table public.model_scorecard_evaluations enable row level security;
revoke all on public.model_scorecard_evaluations
  from public, anon, authenticated, service_role;
grant select, insert on public.model_scorecard_evaluations to service_role;
revoke execute on function public.validate_scorecard_evaluation_membership()
  from public, anon, authenticated, service_role;

-- A model review must match its scorecard's model. Approval additionally
-- requires an eligible, policy-versioned scorecard and an authenticated human.
create or replace function public.validate_model_promotion_review_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  scorecard_model uuid;
  recommendation text;
  policy_hash text;
  membership_hash text;
  policy jsonb;
  scorecard_metrics jsonb;
  scorecard_created_at timestamptz;
  scorecard_evaluation_count integer;
  scorecard_matured_count integer;
  scorecard_unscorable_count integer;
  scorecard_excluded_count integer;
  scorecard_run uuid;
  scorecard_horizon integer;
  scorecard_origin_start timestamptz;
  scorecard_origin_end timestamptz;
  membership_count bigint;
  expected_membership_count bigint;
  included_count bigint;
  unscorable_count bigint;
  excluded_count bigint;
  invalid_membership boolean;
begin
  select scorecard.model_version_id, scorecard.promotion_recommendation,
         scorecard.promotion_policy_hash, scorecard.evaluation_membership_hash,
         scorecard.promotion_policy, scorecard.metrics, scorecard.created_at,
         scorecard.evaluation_count, scorecard.matured_count,
         scorecard.unscorable_count, scorecard.excluded_count,
         scorecard.analytics_run_id, scorecard.horizon_days,
         scorecard.origin_start, scorecard.origin_end
  into scorecard_model, recommendation, policy_hash, membership_hash, policy,
       scorecard_metrics, scorecard_created_at, scorecard_evaluation_count,
       scorecard_matured_count, scorecard_unscorable_count,
       scorecard_excluded_count, scorecard_run, scorecard_horizon,
       scorecard_origin_start, scorecard_origin_end
  from public.model_scorecards scorecard
  where scorecard.id = new.scorecard_id;

  if scorecard_model is null or scorecard_model <> new.model_version_id then
    raise exception 'Promotion review model does not match its scorecard';
  end if;
  if new.created_at < scorecard_created_at then
    raise exception 'Promotion review cannot predate its scorecard';
  end if;
  if new.decision = 'approved' then
    if auth.uid() is null
       or new.reviewer_user_id is distinct from auth.uid()
       or coalesce(auth.jwt()->'app_metadata'->>'price_intelligence_operator', 'false') <> 'true' then
      raise exception 'Approved promotion requires the authenticated price-intelligence operator';
    end if;

    select count(*),
           count(*) filter (where membership.included_in_metrics),
           count(*) filter (
             where prediction.prediction_status = 'research_only'
               and evaluation.evaluation_status = 'unscorable'
           ),
           count(*) filter (where prediction.prediction_status = 'quarantined'),
           coalesce(bool_or(
             membership.included_in_metrics is distinct from (
               prediction.prediction_status = 'research_only'
               and evaluation.evaluation_status = 'scored'
             )
           ), false)
    into membership_count, included_count, unscorable_count, excluded_count,
         invalid_membership
    from public.model_scorecard_evaluations membership
    join public.forecast_evaluations evaluation
      on evaluation.id = membership.evaluation_id
    join public.card_forecast_predictions prediction
      on prediction.id = evaluation.prediction_id
    where membership.scorecard_id = new.scorecard_id;

    select count(*) into expected_membership_count
    from public.forecast_evaluations evaluation
    join public.card_forecast_predictions prediction
      on prediction.id = evaluation.prediction_id
    where evaluation.analytics_run_id = scorecard_run
      and prediction.model_version_id = scorecard_model
      and prediction.horizon_days = scorecard_horizon
      and prediction.origin between scorecard_origin_start and scorecard_origin_end;

    if recommendation <> 'eligible_for_operator_review'
       or policy_hash = repeat('0', 64)
       or membership_hash = repeat('0', 64)
       or policy->>'version' = 'legacy-unversioned'
       or membership_count <> scorecard_matured_count
       or membership_count <> expected_membership_count
       or included_count <> scorecard_evaluation_count
       or unscorable_count <> scorecard_unscorable_count
       or excluded_count <> scorecard_excluded_count
       or invalid_membership then
      raise exception 'Approved promotion requires complete versioned scorecard membership';
    end if;

    if coalesce(jsonb_array_length(policy->'requiredBaselines'), 0) <> 5
       -- jsonb_build_object/array instead of a quoted JSON literal: keeps
       -- the Supabase CLI statement splitter away from double quotes inside
       -- single-quoted strings. Same containment check exactly.
       or not policy @> jsonb_build_object(
         'requiredBaselines',
         jsonb_build_array('no_change', 'damped_momentum', 'market_index', 'lifecycle_cohort', 'structural_convergence')
       )
       or scorecard_metrics->'missingRequiredBaselines' is distinct from '[]'::jsonb
       or jsonb_typeof(policy->'minimumCases') is distinct from 'number'
       or jsonb_typeof(policy->'minimumBaselineLift') is distinct from 'number'
       or jsonb_typeof(policy->'interval80CoverageMin') is distinct from 'number'
       or jsonb_typeof(policy->'interval80CoverageMax') is distinct from 'number'
       or jsonb_typeof(policy->'maximumBrierScore') is distinct from 'number'
       or jsonb_typeof(scorecard_metrics->'count') is distinct from 'number'
       or jsonb_typeof(scorecard_metrics->'interval80Coverage') is distinct from 'number'
       or jsonb_typeof(scorecard_metrics->'brierScore') is distinct from 'number'
       or coalesce((scorecard_metrics->>'count')::integer, -1) <> scorecard_evaluation_count
       or coalesce((policy->>'minimumCases')::integer, 2147483647) > scorecard_evaluation_count
       or coalesce((scorecard_metrics->>'interval80Coverage')::numeric, -1)
            not between (policy->>'interval80CoverageMin')::numeric
                and (policy->>'interval80CoverageMax')::numeric
       or coalesce((scorecard_metrics->>'brierScore')::numeric, 2)
            > (policy->>'maximumBrierScore')::numeric
       or exists (
         select 1
         from jsonb_array_elements_text(policy->'requiredBaselines') baseline(name)
         where jsonb_typeof(scorecard_metrics->'baselineResults'->baseline.name)
                 is distinct from 'number'
            or (scorecard_metrics->'baselineResults'->>baseline.name)::numeric
                 < (policy->>'minimumBaselineLift')::numeric
       ) then
      raise exception 'Approved promotion does not satisfy the declared five-baseline policy';
    end if;
  end if;
  return new;
end;
$$;

create trigger model_promotion_reviews_validate_integrity
  before insert on public.model_promotion_reviews
  for each row execute function public.validate_model_promotion_review_integrity();
revoke execute on function public.validate_model_promotion_review_integrity()
  from public, anon, authenticated, service_role;

create or replace function public.review_model_promotion(
  requested_model_version_id uuid,
  requested_scorecard_id uuid,
  requested_decision text,
  requested_leakage_tests_attested boolean,
  requested_source_rights_attested boolean,
  requested_baseline_lift_attested boolean,
  requested_interval_calibration_attested boolean,
  requested_cohort_regression_attested boolean,
  requested_model_card_hash text,
  requested_reviewer_label text,
  requested_notes text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  review_id uuid := gen_random_uuid();
  actor_user_id uuid := auth.uid();
begin
  if actor_user_id is null
     or coalesce(auth.jwt()->'app_metadata'->>'price_intelligence_operator', 'false') <> 'true' then
    raise exception 'Model review requires an authenticated price-intelligence operator';
  end if;
  if requested_decision not in ('approved','rejected','deferred') then
    raise exception 'Model review decision is invalid';
  end if;
  if nullif(btrim(requested_reviewer_label), '') is null then
    raise exception 'Model review requires a reviewer label';
  end if;

  insert into public.model_promotion_reviews (
    id, model_version_id, scorecard_id, decision, leakage_tests_attested,
    source_rights_attested, baseline_lift_attested,
    interval_calibration_attested, cohort_regression_attested,
    model_card_hash, reviewer_user_id, reviewer_label, notes
  ) values (
    review_id, requested_model_version_id, requested_scorecard_id,
    requested_decision, requested_leakage_tests_attested,
    requested_source_rights_attested, requested_baseline_lift_attested,
    requested_interval_calibration_attested,
    requested_cohort_regression_attested, requested_model_card_hash,
    actor_user_id, btrim(requested_reviewer_label), coalesce(requested_notes, '')
  );
  return review_id;
end;
$$;

revoke insert on public.model_promotion_reviews from service_role;
grant select on public.model_promotion_reviews to service_role;
revoke execute on function public.review_model_promotion(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_model_promotion(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,text,text,text)
  to authenticated;

-- Make the reviewed descriptive RPC the exclusive service-role publication
-- writer. A deferred feature flag still keeps staged rows browser-invisible.
alter function public.publish_descriptive_intelligence(uuid) security definer;
revoke insert, update, delete on public.card_intelligence_publications
  from service_role;
revoke insert, update, delete on public.intelligence_publication_sources
  from service_role;
revoke insert, update, delete on public.intelligence_publication_promotions
  from service_role;
grant select on public.card_intelligence_publications,
  public.intelligence_publication_sources,
  public.intelligence_publication_promotions to service_role;
revoke execute on function public.publish_descriptive_intelligence(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_descriptive_intelligence(uuid)
  to service_role;

create table public.intelligence_publication_control_events (
  id uuid primary key default gen_random_uuid(),
  catalog_variant_id uuid not null references public.catalog_variants(id) on delete restrict,
  action text not null check (action in ('disabled','global_kill_switch_tested')),
  reason_code text not null check (char_length(reason_code) between 1 and 120),
  actor_label text not null check (char_length(actor_label) between 1 and 160),
  prior_payload_hash text check (prior_payload_hash is null or prior_payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create trigger intelligence_publication_control_events_append_only
  before update or delete on public.intelligence_publication_control_events
  for each row execute function public.reject_append_only_mutation();
alter table public.intelligence_publication_control_events enable row level security;
revoke all on public.intelligence_publication_control_events
  from public, anon, authenticated, service_role;
grant select, insert on public.intelligence_publication_control_events to service_role;

create or replace function public.disable_public_intelligence(
  requested_variant_id uuid,
  reason_code text,
  actor_label text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  disabled boolean;
  previous_payload_hash text;
  normalized_reason text := nullif(btrim(reason_code), '');
  normalized_actor text := nullif(btrim(actor_label), '');
begin
  if normalized_reason is null or normalized_actor is null then
    raise exception 'Publication disable requires a reason and actor label';
  end if;
  select payload_hash into previous_payload_hash
  from public.card_intelligence_publications
  where catalog_variant_id = requested_variant_id
  for update;
  update public.card_intelligence_publications
  set public_display_allowed = false,
      publication_status = 'quarantined',
      reason_codes = case
        when reason_codes @> array[normalized_reason] then reason_codes
        else array_append(reason_codes, normalized_reason)
      end,
      updated_at = clock_timestamp()
  where catalog_variant_id = requested_variant_id
  returning true into disabled;
  if coalesce(disabled, false) then
    insert into public.intelligence_publication_control_events (
      catalog_variant_id, action, reason_code, actor_label, prior_payload_hash
    ) values (
      requested_variant_id, 'disabled', normalized_reason,
      normalized_actor, previous_payload_hash
    );
  end if;
  return coalesce(disabled, false);
end;
$$;

revoke execute on function public.disable_public_intelligence(uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.disable_public_intelligence(uuid,text,text)
  to service_role;

create or replace function public.validate_required_publication_attribution()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.intelligence_publication_sources lineage
    join public.source_terms_reviews review on review.id = lineage.terms_review_id
    join public.card_intelligence_publications publication
      on publication.catalog_variant_id = lineage.catalog_variant_id
    where lineage.catalog_variant_id = new.catalog_variant_id
      and review.attribution_required
      and not exists (
        select 1
        from jsonb_array_elements(publication.source_attributions) attribution
        where attribution->>'sourceId' = lineage.source_id::text
          and btrim(coalesce(attribution->>'attribution', ''))
            = btrim(coalesce(review.attribution_text, ''))
      )
  ) then
    raise exception 'Publication is missing required source attribution';
  end if;
  return new;
end;
$$;

create trigger intelligence_promotions_validate_attribution
  before insert on public.intelligence_publication_promotions
  for each row execute function public.validate_required_publication_attribution();
revoke execute on function public.validate_required_publication_attribution()
  from public, anon, authenticated, service_role;

-- Migration assertions fail closed if any browser or service-role boundary was
-- weakened while applying the hardening.
do $$
begin
  if has_table_privilege('anon', 'public.model_scorecard_evaluations', 'SELECT')
     or has_table_privilege('authenticated', 'public.model_scorecard_evaluations', 'SELECT') then
    raise exception 'Scorecard membership must not be browser-readable';
  end if;
  if not has_table_privilege('service_role', 'public.model_scorecard_evaluations', 'SELECT')
     or not has_table_privilege('service_role', 'public.model_scorecard_evaluations', 'INSERT')
     or has_table_privilege('service_role', 'public.model_scorecard_evaluations', 'UPDATE')
     or has_table_privilege('service_role', 'public.model_scorecard_evaluations', 'DELETE') then
    raise exception 'Scorecard membership must be service append-only';
  end if;
  if has_table_privilege('service_role', 'public.source_terms_reviews', 'UPDATE')
     or has_table_privilege('service_role', 'public.source_terms_reviews', 'DELETE') then
    raise exception 'Source terms reviews must be immutable';
  end if;
  if has_table_privilege('service_role', 'public.external_card_mappings', 'UPDATE')
     or has_table_privilege('service_role', 'public.external_card_mappings', 'DELETE') then
    raise exception 'Mapping versions must be corrected through the guarded RPC';
  end if;
  if has_table_privilege('service_role', 'public.card_intelligence_publications', 'INSERT')
     or has_table_privilege('service_role', 'public.card_intelligence_publications', 'UPDATE')
     or has_table_privilege('service_role', 'public.card_intelligence_publications', 'DELETE') then
    raise exception 'Service role must publish only through the guarded RPC';
  end if;
  if has_table_privilege('service_role', 'public.model_promotion_reviews', 'INSERT') then
    raise exception 'Model reviews must be submitted by an authenticated operator RPC';
  end if;
  if has_function_privilege('anon', 'public.publish_descriptive_intelligence(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.publish_descriptive_intelligence(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.publish_descriptive_intelligence(uuid)', 'EXECUTE') then
    raise exception 'Descriptive publication RPC ACL is incorrect';
  end if;
  if has_function_privilege('anon', 'public.review_model_promotion(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,text,text,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.review_model_promotion(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,text,text,text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.review_model_promotion(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,text,text,text)', 'EXECUTE') then
    raise exception 'Model-review RPC ACL is incorrect';
  end if;
  if has_function_privilege('anon', 'public.supersede_external_card_mapping(uuid,uuid,numeric,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.supersede_external_card_mapping(uuid,uuid,numeric,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.supersede_external_card_mapping(uuid,uuid,numeric,text,text,text,text)', 'EXECUTE') then
    raise exception 'Mapping-supersession RPC ACL is incorrect';
  end if;
  if has_function_privilege('anon', 'public.disable_public_intelligence(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.disable_public_intelligence(uuid,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.disable_public_intelligence(uuid,text,text)', 'EXECUTE') then
    raise exception 'Publication-disable RPC ACL is incorrect';
  end if;
end;
$$;

commit;
