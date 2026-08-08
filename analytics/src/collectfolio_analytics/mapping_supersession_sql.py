"""Guarded rollback-first SQL for a reviewed mapping supersession.

The input manifest binds the exact old mapping, canonical replacement,
operator review, and hosted lineage counts. Generated SQL rechecks all of
those facts inside one transaction before it calls the service-role-only
``supersede_external_card_mapping`` RPC. The RPC preserves historical rows;
post-call guards prove their counts and variant IDs did not change.
"""

from __future__ import annotations

from hashlib import sha256
import json
import re
from typing import Mapping
from uuid import UUID

MANIFEST_MODE = "external_card_mapping_supersession"
SCHEMA_VERSION = 1
RIGHTS_FIELDS = (
    "commercial_use_allowed",
    "catalog_metadata_allowed",
    "image_display_allowed",
    "public_raw_display_allowed",
    "public_derived_display_allowed",
)
LINEAGE_FIELDS = (
    "price_observations",
    "trend_feature_snapshots",
    "card_forecast_predictions",
    "intelligence_publication_candidates",
    "card_intelligence_publications",
)


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _text(value: object, name: str, *, maximum: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty text")
    result = value.strip()
    if maximum is not None and len(result) > maximum:
        raise ValueError(f"{name} must be at most {maximum} characters")
    return result


def _uuid(value: object, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def _count(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def _sha256(value: object, name: str) -> str:
    digest = _text(value, name).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError(f"{name} must be a SHA-256 digest")
    return digest


def _literal(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def mapping_supersession_manifest_hash(manifest: Mapping[str, object]) -> str:
    """Hash the canonical manifest while excluding its self-hash field."""

    payload = dict(manifest)
    payload.pop("manifest_sha256", None)
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256(encoded).hexdigest()


def validate_mapping_supersession_manifest(
    manifest: Mapping[str, object],
) -> None:
    """Reject an incomplete, public-enabling, or tampered manifest."""

    if not isinstance(manifest, Mapping) or manifest.get("mode") != MANIFEST_MODE:
        raise ValueError(f"manifest must be a {MANIFEST_MODE} manifest")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"schema_version must be {SCHEMA_VERSION}")
    expected_hash = _sha256(manifest.get("manifest_sha256"), "manifest_sha256")
    if expected_hash != mapping_supersession_manifest_hash(manifest):
        raise ValueError("manifest_sha256 does not match the reviewed manifest")

    source = _mapping(manifest.get("source"), "source")
    _uuid(source.get("id"), "source.id")
    _uuid(source.get("terms_review_id"), "source.terms_review_id")
    _text(source.get("code"), "source.code")
    if source.get("active") is not True or source.get("decision") != "research_only":
        raise ValueError("source must remain active under a research_only review")
    if any(source.get(field) is not False for field in RIGHTS_FIELDS):
        raise ValueError("source public, commercial, catalog, and image rights must remain false")

    identity = _mapping(manifest.get("external_identity"), "external_identity")
    _text(identity.get("product_id"), "external_identity.product_id")
    _text(identity.get("variant_key"), "external_identity.variant_key")

    old = _mapping(manifest.get("old_mapping"), "old_mapping")
    old_id = _uuid(old.get("id"), "old_mapping.id")
    old_variant_id = _uuid(old.get("variant_id"), "old_mapping.variant_id")
    _text(old.get("mapping_method"), "old_mapping.mapping_method")
    old_version = _text(old.get("mapping_version"), "old_mapping.mapping_version")
    if old.get("review_status") != "approved" or float(old.get("mapping_confidence", -1)) != 1:
        raise ValueError("old_mapping must be the approved confidence-1 mapping")
    lineage = _mapping(old.get("expected_lineage"), "old_mapping.expected_lineage")
    for field in LINEAGE_FIELDS:
        _count(lineage.get(field), f"old_mapping.expected_lineage.{field}")
    if lineage.get("intelligence_publication_candidates") != 0:
        raise ValueError("mapping reconciliation requires zero public candidates")
    if lineage.get("card_intelligence_publications") != 0:
        raise ValueError("mapping reconciliation requires zero public publications")

    replacement = _mapping(manifest.get("replacement"), "replacement")
    replacement_id = _uuid(replacement.get("variant_id"), "replacement.variant_id")
    _uuid(replacement.get("card_id"), "replacement.card_id")
    _uuid(replacement.get("set_id"), "replacement.set_id")
    for field in (
        "canonical_variant_key",
        "canonical_card_key",
        "canonical_set_key",
        "finish",
        "condition_class",
        "mapping_method",
        "mapping_version",
    ):
        _text(replacement.get(field), f"replacement.{field}")
    if replacement_id == old_variant_id:
        raise ValueError("replacement.variant_id must differ from old_mapping.variant_id")
    if replacement.get("mapping_version") == old_version:
        raise ValueError("replacement.mapping_version must create a new version")
    if float(replacement.get("mapping_confidence", -1)) != 1:
        raise ValueError("replacement must be a manually reviewed confidence-1 mapping")

    review = _mapping(manifest.get("review"), "review")
    _text(review.get("document"), "review.document")
    _sha256(review.get("document_sha256"), "review.document_sha256")
    _text(review.get("reviewed_at"), "review.reviewed_at")
    _text(review.get("reviewer_label"), "review.reviewer_label", maximum=160)
    reason = _text(manifest.get("correction_reason"), "correction_reason")
    full_reason = (
        f"{reason} Review document: {review['document']}; "
        f"SHA-256: {review['document_sha256']}."
    )
    if len(full_reason) > 4000:
        raise ValueError("correction evidence exceeds the database notes limit")

    safety = _mapping(manifest.get("safety"), "safety")
    for field in (
        "preserve_historical_lineage",
        "require_public_price_intelligence_disabled",
        "require_no_public_candidates",
        "require_no_public_publications",
    ):
        if safety.get(field) is not True:
            raise ValueError(f"safety.{field} must be true")
    if old_id == replacement_id:
        raise ValueError("mapping and variant IDs must not collide")


def build_mapping_supersession_sql(
    manifest: Mapping[str, object],
    *,
    commit: bool = False,
) -> str:
    """Generate one guarded RPC transaction, defaulting to rollback."""

    validate_mapping_supersession_manifest(manifest)
    source = _mapping(manifest["source"], "source")
    identity = _mapping(manifest["external_identity"], "external_identity")
    old = _mapping(manifest["old_mapping"], "old_mapping")
    lineage = _mapping(old["expected_lineage"], "old_mapping.expected_lineage")
    replacement = _mapping(manifest["replacement"], "replacement")
    review = _mapping(manifest["review"], "review")
    reason = (
        f"{manifest['correction_reason']} Review document: {review['document']}; "
        f"SHA-256: {review['document_sha256']}."
    )
    manifest_hash = str(manifest["manifest_sha256"])

    pieces = [
        f"-- Generated from a reviewed mapping supersession manifest (hash {manifest_hash}).",
        "-- The old mapping and every historical lineage row remain immutable.",
        "begin;",
        "set local lock_timeout = '5s';\nset local statement_timeout = '30s';",
        f"""do $reconcile$
declare
  replacement_mapping_id uuid;
  old_observations_before bigint;
  old_snapshots_before bigint;
  old_predictions_before bigint;
  old_candidates_before bigint;
  old_publications_before bigint;
  new_observations_before bigint;
  new_snapshots_before bigint;
  new_predictions_before bigint;
  new_candidates_before bigint;
  new_publications_before bigint;
begin
  if not exists (
    select 1
    from public.data_sources source
    join public.source_terms_reviews review
      on review.id = source.current_terms_review_id
     and review.source_id = source.id
    where source.id = {_literal(source['id'])}::uuid
      and source.code = {_literal(source['code'])}
      and source.active
      and source.current_terms_review_id = {_literal(source['terms_review_id'])}::uuid
      and review.decision = 'research_only'
      and (review.expires_at is null or review.expires_at > now())
      and not review.commercial_use_allowed
      and not review.catalog_metadata_allowed
      and not review.image_display_allowed
      and not review.public_raw_display_allowed
      and not review.public_derived_display_allowed
  ) then
    raise exception 'TCGCSV source rights no longer match the reviewed research-only boundary';
  end if;

  if coalesce((
    select enabled from public.product_feature_flags
    where key = 'public_price_intelligence'
  ), true) then
    raise exception 'Public price intelligence must remain disabled during reconciliation';
  end if;

  if not exists (
    select 1
    from public.external_card_mappings mapping
    where mapping.id = {_literal(old['id'])}::uuid
      and mapping.source_id = {_literal(source['id'])}::uuid
      and mapping.external_product_id = {_literal(identity['product_id'])}
      and mapping.external_variant_key = {_literal(identity['variant_key'])}
      and mapping.variant_id = {_literal(old['variant_id'])}::uuid
      and mapping.mapping_confidence = {_literal(old['mapping_confidence'])}
      and mapping.mapping_method = {_literal(old['mapping_method'])}
      and mapping.mapping_version = {_literal(old['mapping_version'])}
      and mapping.review_status = 'approved'
      and mapping.supersedes_mapping_id is null
      and mapping.superseded_at is null
      and mapping.correction_actor is null
      and mapping.correction_reason is null
  ) then
    raise exception 'Old mapping no longer matches the reviewed v1 identity';
  end if;

  if (select count(*) from public.external_card_mappings mapping
      where mapping.source_id = {_literal(source['id'])}::uuid
        and mapping.external_product_id = {_literal(identity['product_id'])}
        and mapping.external_variant_key = {_literal(identity['variant_key'])}
        and mapping.superseded_at is null) <> 1
     or exists (
       select 1 from public.external_card_mappings successor
       where successor.supersedes_mapping_id = {_literal(old['id'])}::uuid
     ) then
    raise exception 'External identity is no longer a single unsuperseded v1 mapping';
  end if;

  if not exists (
    select 1
    from public.catalog_variants variant
    join public.catalog_cards card on card.id = variant.card_id
    join public.catalog_sets catalog_set on catalog_set.id = card.set_id
    where variant.id = {_literal(replacement['variant_id'])}::uuid
      and variant.canonical_key = {_literal(replacement['canonical_variant_key'])}
      and variant.finish = {_literal(replacement['finish'])}
      and variant.raw_condition_class = {_literal(replacement['condition_class'])}
      and variant.active
      and card.id = {_literal(replacement['card_id'])}::uuid
      and card.canonical_key = {_literal(replacement['canonical_card_key'])}
      and catalog_set.id = {_literal(replacement['set_id'])}::uuid
      and catalog_set.canonical_key = {_literal(replacement['canonical_set_key'])}
  ) then
    raise exception 'Replacement variant does not match the hosted canonical sv8 identity';
  end if;

  select count(*) into old_observations_before
  from public.price_observations
  where mapping_id = {_literal(old['id'])}::uuid;
  select count(*) into old_snapshots_before
  from public.trend_feature_snapshots
  where variant_id = {_literal(old['variant_id'])}::uuid;
  select count(*) into old_predictions_before
  from public.card_forecast_predictions
  where variant_id = {_literal(old['variant_id'])}::uuid;
  select count(*) into old_candidates_before
  from public.intelligence_publication_candidates
  where catalog_variant_id = {_literal(old['variant_id'])}::uuid;
  select count(*) into old_publications_before
  from public.card_intelligence_publications
  where catalog_variant_id = {_literal(old['variant_id'])}::uuid;

  if row(old_observations_before, old_snapshots_before, old_predictions_before,
         old_candidates_before, old_publications_before) is distinct from
     row({_literal(lineage['price_observations'])}::bigint,
         {_literal(lineage['trend_feature_snapshots'])}::bigint,
         {_literal(lineage['card_forecast_predictions'])}::bigint,
         {_literal(lineage['intelligence_publication_candidates'])}::bigint,
         {_literal(lineage['card_intelligence_publications'])}::bigint) then
    raise exception 'Historical v1 lineage counts changed after operator review';
  end if;

  select count(*) into new_observations_before
  from public.price_observations
  where variant_id = {_literal(replacement['variant_id'])}::uuid;
  select count(*) into new_snapshots_before
  from public.trend_feature_snapshots
  where variant_id = {_literal(replacement['variant_id'])}::uuid;
  select count(*) into new_predictions_before
  from public.card_forecast_predictions
  where variant_id = {_literal(replacement['variant_id'])}::uuid;
  select count(*) into new_candidates_before
  from public.intelligence_publication_candidates
  where catalog_variant_id = {_literal(replacement['variant_id'])}::uuid;
  select count(*) into new_publications_before
  from public.card_intelligence_publications
  where catalog_variant_id = {_literal(replacement['variant_id'])}::uuid;

  if old_candidates_before <> 0 or old_publications_before <> 0
     or new_candidates_before <> 0 or new_publications_before <> 0 then
    raise exception 'Reconciliation refuses any old or replacement public intelligence rows';
  end if;

  select public.supersede_external_card_mapping(
    {_literal(old['id'])}::uuid,
    {_literal(replacement['variant_id'])}::uuid,
    {_literal(replacement['mapping_confidence'])},
    {_literal(replacement['mapping_method'])},
    {_literal(replacement['mapping_version'])},
    {_literal(review['reviewer_label'])},
    {_literal(reason)}
  ) into replacement_mapping_id;

  if not exists (
    select 1
    from public.external_card_mappings mapping
    where mapping.id = {_literal(old['id'])}::uuid
      and mapping.review_status = 'rejected'
      and mapping.superseded_at is not null
      and position({_literal(reason)} in coalesce(mapping.notes, '')) > 0
  ) then
    raise exception 'RPC did not close the old mapping exactly as required';
  end if;

  if not exists (
    select 1
    from public.external_card_mappings mapping
    where mapping.id = replacement_mapping_id
      and mapping.source_id = {_literal(source['id'])}::uuid
      and mapping.external_product_id = {_literal(identity['product_id'])}
      and mapping.external_variant_key = {_literal(identity['variant_key'])}
      and mapping.variant_id = {_literal(replacement['variant_id'])}::uuid
      and mapping.mapping_confidence = {_literal(replacement['mapping_confidence'])}
      and mapping.mapping_method = {_literal(replacement['mapping_method'])}
      and mapping.mapping_version = {_literal(replacement['mapping_version'])}
      and mapping.review_status = 'approved'
      and mapping.supersedes_mapping_id = {_literal(old['id'])}::uuid
      and mapping.superseded_at is null
      and mapping.correction_actor = {_literal(review['reviewer_label'])}
      and mapping.correction_reason = {_literal(reason)}
      and mapping.notes = {_literal(reason)}
  ) then
    raise exception 'RPC successor does not match the reviewed v2 mapping';
  end if;

  if (select count(*)
      from public.catalog_mapping_review_events event
      where event.mapping_id = replacement_mapping_id
        and event.decision = 'corrected'
        and event.resolved_variant_id = {_literal(replacement['variant_id'])}::uuid
        and event.reviewer_label = {_literal(review['reviewer_label'])}
        and event.notes = {_literal(reason)}
        and event.mapping_version = {_literal(replacement['mapping_version'])}) <> 1 then
    raise exception 'RPC did not append exactly one reviewed correction event';
  end if;

  if (select count(*) from public.price_observations
      where mapping_id = {_literal(old['id'])}::uuid) <> old_observations_before
     or (select count(*) from public.trend_feature_snapshots
         where variant_id = {_literal(old['variant_id'])}::uuid) <> old_snapshots_before
     or (select count(*) from public.card_forecast_predictions
         where variant_id = {_literal(old['variant_id'])}::uuid) <> old_predictions_before
     or (select count(*) from public.intelligence_publication_candidates
         where catalog_variant_id = {_literal(old['variant_id'])}::uuid) <> old_candidates_before
     or (select count(*) from public.card_intelligence_publications
         where catalog_variant_id = {_literal(old['variant_id'])}::uuid) <> old_publications_before
     or (select count(*) from public.price_observations
         where variant_id = {_literal(replacement['variant_id'])}::uuid) <> new_observations_before
     or (select count(*) from public.trend_feature_snapshots
         where variant_id = {_literal(replacement['variant_id'])}::uuid) <> new_snapshots_before
     or (select count(*) from public.card_forecast_predictions
         where variant_id = {_literal(replacement['variant_id'])}::uuid) <> new_predictions_before
     or (select count(*) from public.intelligence_publication_candidates
         where catalog_variant_id = {_literal(replacement['variant_id'])}::uuid) <> new_candidates_before
     or (select count(*) from public.card_intelligence_publications
         where catalog_variant_id = {_literal(replacement['variant_id'])}::uuid) <> new_publications_before then
    raise exception 'Mapping RPC changed immutable historical or public lineage rows';
  end if;

  if exists (
    select 1 from public.price_observations
    where mapping_id = replacement_mapping_id
  ) then
    raise exception 'Successor mapping unexpectedly claimed historical observations';
  end if;
end;
$reconcile$;""",
        "commit;" if commit else "rollback; -- rehearsal by default; regenerate with commit for the real run",
        f"""select
  old_mapping.id as old_mapping_id,
  old_mapping.review_status as old_review_status,
  old_mapping.superseded_at,
  successor.id as successor_mapping_id,
  successor.variant_id as successor_variant_id,
  successor.mapping_version as successor_mapping_version,
  successor.review_status as successor_review_status,
  (select count(*) from public.price_observations observation
   where observation.mapping_id = old_mapping.id) as preserved_observations,
  (select count(*) from public.trend_feature_snapshots snapshot
   where snapshot.variant_id = old_mapping.variant_id) as preserved_trend_snapshots,
  (select count(*) from public.card_forecast_predictions prediction
   where prediction.variant_id = old_mapping.variant_id) as preserved_predictions,
  coalesce((select enabled from public.product_feature_flags
            where key = 'public_price_intelligence'), false)
    as public_price_intelligence_enabled
from public.external_card_mappings old_mapping
left join public.external_card_mappings successor
  on successor.supersedes_mapping_id = old_mapping.id
where old_mapping.id = {_literal(old['id'])}::uuid;""",
    ]
    return "\n\n".join(pieces) + "\n"
