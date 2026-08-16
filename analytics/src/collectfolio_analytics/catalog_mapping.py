"""Deterministic canonical identity and conservative source mapping."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from hashlib import sha256
import json
import re
from typing import Iterable, Mapping, Sequence
import unicodedata
from uuid import NAMESPACE_URL, UUID, uuid5

from .observations import normalize_market_identity

CATALOG_NAMESPACE = uuid5(NAMESPACE_URL, "https://collectfolio.app/catalog/v1")
CONDITION_CLASSES = {"raw", "graded", "sealed", "other"}


def _required(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value.strip()


def _uuid(value: str, name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"{name} must be a UUID") from exc


def normalize_identity(value: str) -> str:
    """Normalize comparison text without guessing aliases or variants."""

    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    return re.sub(r"[^\w]+", "-", normalized, flags=re.UNICODE).strip("-")


def normalize_card_number(value: str) -> str:
    """Preserve meaningful leading zeroes and separators in collector numbers."""

    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    return re.sub(r"\s+", "", normalized)


def _digest(value: Mapping[str, object]) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class CanonicalSet:
    id: str
    canonical_key: str
    game: str
    language: str
    set_code: str
    name: str
    series: str = ""
    release_date: date | None = None

    @classmethod
    def build(
        cls,
        *,
        game: str,
        language: str,
        set_code: str,
        name: str,
        series: str = "",
        release_date: date | None = None,
    ) -> "CanonicalSet":
        game_key = normalize_identity(_required(game, "game"))
        language_key = normalize_identity(_required(language, "language"))
        code_key = normalize_identity(_required(set_code, "set_code"))
        canonical_key = f"set|{game_key}|{language_key}|{code_key}"
        return cls(
            id=str(uuid5(CATALOG_NAMESPACE, canonical_key)),
            canonical_key=canonical_key,
            game=game_key,
            language=language_key,
            set_code=code_key,
            name=_required(name, "name"),
            series=str(series or "").strip(),
            release_date=release_date,
        )

    def database_row(self) -> dict[str, object]:
        return {
            "id": self.id,
            "canonical_key": self.canonical_key,
            "game": self.game,
            "name": self.name,
            "series": self.series or None,
            "language": self.language,
            "release_date": self.release_date.isoformat() if self.release_date else None,
        }


@dataclass(frozen=True, slots=True)
class CanonicalCard:
    id: str
    canonical_key: str
    set: CanonicalSet
    name: str
    number: str
    rarity: str = ""
    artist: str = ""

    @classmethod
    def build(
        cls,
        canonical_set: CanonicalSet,
        *,
        name: str,
        number: str,
        rarity: str = "",
        artist: str = "",
    ) -> "CanonicalCard":
        if not isinstance(canonical_set, CanonicalSet):
            raise ValueError("canonical_set must be a CanonicalSet")
        name_value = _required(name, "name")
        number_value = _required(number, "number")
        canonical_key = (
            f"card|{canonical_set.canonical_key}|"
            f"{normalize_card_number(number_value)}|{normalize_identity(name_value)}"
        )
        return cls(
            id=str(uuid5(CATALOG_NAMESPACE, canonical_key)),
            canonical_key=canonical_key,
            set=canonical_set,
            name=name_value,
            number=number_value,
            rarity=str(rarity or "").strip(),
            artist=str(artist or "").strip(),
        )

    def database_row(self) -> dict[str, object]:
        return {
            "id": self.id,
            "set_id": self.set.id,
            "canonical_key": self.canonical_key,
            "name": self.name,
            "number": self.number,
            "rarity": self.rarity or None,
            "artist": self.artist or None,
            "release_date": self.set.release_date.isoformat() if self.set.release_date else None,
        }


@dataclass(frozen=True, slots=True)
class CanonicalVariant:
    id: str
    canonical_key: str
    card: CanonicalCard
    language: str
    edition: str
    finish: str
    variant_name: str
    condition_class: str

    @classmethod
    def build(
        cls,
        card: CanonicalCard,
        *,
        language: str | None = None,
        edition: str = "standard",
        finish: str,
        variant_name: str = "",
        condition_class: str = "raw",
    ) -> "CanonicalVariant":
        if not isinstance(card, CanonicalCard):
            raise ValueError("card must be a CanonicalCard")
        language_key = normalize_identity(language or card.set.language)
        edition_key = normalize_identity(_required(edition, "edition"))
        finish_key = normalize_identity(_required(finish, "finish"))
        variant_key = normalize_identity(variant_name)
        condition_key = normalize_identity(_required(condition_class, "condition_class"))
        if condition_key not in CONDITION_CLASSES:
            raise ValueError(f"condition_class must be one of {sorted(CONDITION_CLASSES)}")
        canonical_key = (
            f"variant|{card.canonical_key}|{language_key}|{edition_key}|"
            f"{finish_key}|{variant_key}|{condition_key}"
        )
        return cls(
            id=str(uuid5(CATALOG_NAMESPACE, canonical_key)),
            canonical_key=canonical_key,
            card=card,
            language=language_key,
            edition=edition_key,
            finish=finish_key,
            variant_name=variant_key,
            condition_class=condition_key,
        )

    def database_row(self) -> dict[str, object]:
        return {
            "id": self.id,
            "card_id": self.card.id,
            "canonical_key": self.canonical_key,
            "language": self.language,
            "edition": self.edition,
            "finish": self.finish,
            "variant_name": self.variant_name,
            "raw_condition_class": self.condition_class,
        }


def validate_catalog(variants: Iterable[CanonicalVariant]) -> tuple[CanonicalVariant, ...]:
    values = tuple(variants)
    if any(not isinstance(value, CanonicalVariant) for value in values):
        raise ValueError("catalog must contain CanonicalVariant values")
    if len({value.id for value in values}) != len(values):
        raise ValueError("canonical variant IDs must be unique")
    if len({value.canonical_key for value in values}) != len(values):
        raise ValueError("canonical variant keys must be unique")
    return values


@dataclass(frozen=True, slots=True)
class ExternalProduct:
    source_id: str
    external_product_id: str
    external_variant_key: str
    game: str
    language: str
    canonical_set_key: str
    name: str
    number: str
    edition: str
    finish: str
    variant_name: str = ""
    condition_class: str = "raw"
    market_condition: str = "unspecified"

    def __post_init__(self) -> None:
        object.__setattr__(self, "source_id", _uuid(self.source_id, "source_id"))
        object.__setattr__(self, "external_product_id", _required(self.external_product_id, "external_product_id"))
        object.__setattr__(self, "external_variant_key", str(self.external_variant_key or "").strip())
        object.__setattr__(self, "game", normalize_identity(self.game))
        object.__setattr__(self, "language", normalize_identity(self.language))
        object.__setattr__(self, "canonical_set_key", str(self.canonical_set_key or "").strip())
        object.__setattr__(self, "name", str(self.name or "").strip())
        object.__setattr__(self, "number", str(self.number or "").strip())
        object.__setattr__(self, "edition", normalize_identity(self.edition))
        object.__setattr__(self, "finish", normalize_identity(self.finish))
        object.__setattr__(self, "variant_name", normalize_identity(self.variant_name))
        condition = normalize_identity(self.condition_class)
        object.__setattr__(self, "condition_class", condition)
        market_condition = normalize_market_identity(self.market_condition)
        object.__setattr__(self, "market_condition", market_condition)

    @property
    def external_key(self) -> tuple[str, str, str]:
        return self.source_id, self.external_product_id, self.external_variant_key

    @property
    def signature(self) -> tuple[str, ...]:
        return (
            self.game, self.language, self.canonical_set_key,
            normalize_identity(self.name), normalize_card_number(self.number),
            self.edition, self.finish, self.variant_name, self.condition_class,
            self.market_condition,
        )


@dataclass(frozen=True, slots=True)
class ApprovedMapping:
    source_id: str
    external_product_id: str
    external_variant_key: str
    variant_id: str
    mapping_version: str
    language: str = "en"
    finish: str = "unspecified"
    condition_class: str = "raw"
    market_condition: str = "unspecified"

    def __post_init__(self) -> None:
        object.__setattr__(self, "source_id", _uuid(self.source_id, "source_id"))
        object.__setattr__(self, "external_product_id", _required(self.external_product_id, "external_product_id"))
        object.__setattr__(self, "external_variant_key", str(self.external_variant_key or "").strip())
        object.__setattr__(self, "variant_id", _uuid(self.variant_id, "variant_id"))
        object.__setattr__(self, "mapping_version", _required(self.mapping_version, "mapping_version"))
        object.__setattr__(self, "language", normalize_market_identity(_required(self.language, "language")))
        object.__setattr__(self, "finish", normalize_market_identity(_required(self.finish, "finish")))
        condition_class = normalize_market_identity(_required(self.condition_class, "condition_class"))
        if condition_class not in CONDITION_CLASSES:
            raise ValueError(f"condition_class must be one of {sorted(CONDITION_CLASSES)}")
        object.__setattr__(self, "condition_class", condition_class)
        object.__setattr__(
            self,
            "market_condition",
            normalize_market_identity(_required(self.market_condition, "market_condition")),
        )

    @property
    def external_key(self) -> tuple[str, str, str]:
        return self.source_id, self.external_product_id, self.external_variant_key


@dataclass(frozen=True, slots=True)
class MappingCandidate:
    product: ExternalProduct
    proposed_variant_id: str | None
    candidate_rank: int
    confidence: float
    method: str
    mapping_version: str
    disposition: str
    reason_codes: tuple[str, ...]
    evidence: Mapping[str, object]
    candidate_hash: str

    def database_row(self, ingestion_run_id: str, terms_review_id: str) -> dict[str, object]:
        return {
            "ingestion_run_id": _uuid(ingestion_run_id, "ingestion_run_id"),
            "source_id": self.product.source_id,
            "terms_review_id": _uuid(terms_review_id, "terms_review_id"),
            "external_product_id": self.product.external_product_id,
            "external_variant_key": self.product.external_variant_key,
            "proposed_variant_id": self.proposed_variant_id,
            "candidate_rank": self.candidate_rank,
            "mapping_confidence": self.confidence,
            "mapping_method": self.method,
            "mapping_version": self.mapping_version,
            "disposition": self.disposition,
            "reason_codes": list(self.reason_codes),
            "evidence": dict(self.evidence),
            "candidate_hash": self.candidate_hash,
        }


@dataclass(frozen=True, slots=True)
class MappingBatch:
    candidates: tuple[MappingCandidate, ...]
    product_count: int
    duplicate_product_count: int

    @property
    def disposition_counts(self) -> dict[str, int]:
        return {
            disposition: sum(candidate.disposition == disposition for candidate in self.candidates)
            for disposition in ("exact", "review", "quarantined", "unmapped")
        }


@dataclass(frozen=True, slots=True)
class CatalogIngestionPacket:
    catalog_sets: tuple[Mapping[str, object], ...]
    catalog_cards: tuple[Mapping[str, object], ...]
    catalog_variants: tuple[Mapping[str, object], ...]
    mapping_candidates: tuple[Mapping[str, object], ...]
    dataset_hash: str
    records_quarantined: int


def _candidate(
    product: ExternalProduct,
    variant: CanonicalVariant | None,
    *,
    rank: int,
    confidence: float,
    method: str,
    mapping_version: str,
    disposition: str,
    reasons: Sequence[str],
    evidence: Mapping[str, object],
) -> MappingCandidate:
    proposed_variant_id = variant.id if variant else None
    hash_input = {
        "sourceId": product.source_id,
        "externalProductId": product.external_product_id,
        "externalVariantKey": product.external_variant_key,
        "signature": product.signature,
        "proposedVariantId": proposed_variant_id,
        "rank": rank,
        "confidence": confidence,
        "method": method,
        "mappingVersion": mapping_version,
        "disposition": disposition,
        "reasons": list(reasons),
        "evidence": dict(evidence),
    }
    return MappingCandidate(
        product=product,
        proposed_variant_id=proposed_variant_id,
        candidate_rank=rank,
        confidence=confidence,
        method=method,
        mapping_version=mapping_version,
        disposition=disposition,
        reason_codes=tuple(reasons),
        evidence=dict(evidence),
        candidate_hash=_digest(hash_input),
    )


def _variant_evidence(product: ExternalProduct, variant: CanonicalVariant) -> dict[str, object]:
    return {
        "setMatch": product.canonical_set_key == variant.card.set.canonical_key,
        "numberMatch": normalize_card_number(product.number) == normalize_card_number(variant.card.number),
        "nameMatch": normalize_identity(product.name) == normalize_identity(variant.card.name),
        "languageMatch": product.language == variant.language,
        "editionMatch": product.edition == variant.edition,
        "finishMatch": product.finish == variant.finish,
        "variantNameMatch": product.variant_name == variant.variant_name,
        "conditionClassMatch": product.condition_class == variant.condition_class,
        "marketCondition": product.market_condition,
        "canonicalKey": variant.canonical_key,
    }


def map_external_product(
    product: ExternalProduct,
    catalog: Iterable[CanonicalVariant],
    *,
    approved_mappings: Iterable[ApprovedMapping] = (),
    mapping_version: str,
) -> tuple[MappingCandidate, ...]:
    """Generate conservative candidates; this function never approves a new map."""

    if not isinstance(product, ExternalProduct):
        raise ValueError("product must be an ExternalProduct")
    version = _required(mapping_version, "mapping_version")
    variants = validate_catalog(catalog)
    approved = {mapping.external_key: mapping for mapping in approved_mappings}
    existing = approved.get(product.external_key)
    if existing:
        target = next((variant for variant in variants if variant.id == existing.variant_id), None)
        if target is None:
            return (_candidate(
                product, None, rank=1, confidence=0, method="approved_external_id",
                mapping_version=version, disposition="quarantined",
                reasons=("approved_mapping_target_missing",), evidence={},
            ),)
        return (_candidate(
            product, target, rank=1, confidence=1, method="approved_external_id",
            mapping_version=existing.mapping_version, disposition="exact",
            reasons=("approved_external_mapping",), evidence=_variant_evidence(product, target),
        ),)

    missing = [
        name for name, value in (
            ("game", product.game), ("language", product.language),
            ("set", product.canonical_set_key), ("name", product.name),
            ("number", product.number), ("edition", product.edition),
            ("finish", product.finish), ("condition", product.condition_class),
            ("market_condition", product.market_condition),
        ) if not value
    ]
    if missing:
        return (_candidate(
            product, None, rank=1, confidence=0, method="required_identity_missing",
            mapping_version=version, disposition="unmapped",
            reasons=tuple(f"missing_{name}" for name in missing), evidence={"missing": missing},
        ),)

    base = [
        variant for variant in variants
        if variant.card.set.game == product.game
        and variant.language == product.language
        and variant.card.set.canonical_key == product.canonical_set_key
        and normalize_card_number(variant.card.number) == normalize_card_number(product.number)
    ]
    if not base:
        return (_candidate(
            product, None, rank=1, confidence=0, method="exact_set_number",
            mapping_version=version, disposition="unmapped",
            reasons=("no_exact_set_number_match",), evidence={},
        ),)

    same_name = [
        variant for variant in base
        if normalize_identity(variant.card.name) == normalize_identity(product.name)
    ]
    if not same_name:
        return tuple(
            _candidate(
                product, variant, rank=index, confidence=0.50, method="set_number_name_mismatch",
                mapping_version=version, disposition="quarantined",
                reasons=("name_mismatch", "manual_review_required"),
                evidence=_variant_evidence(product, variant),
            )
            for index, variant in enumerate(base, 1)
        )

    exact = [
        variant for variant in same_name
        if product.edition == variant.edition
        and product.finish == variant.finish
        and product.variant_name == variant.variant_name
        and product.condition_class == variant.condition_class
    ]
    if len(exact) == 1:
        target = exact[0]
        return (_candidate(
            product, target, rank=1, confidence=0.99, method="exact_variant_identity",
            mapping_version=version, disposition="exact",
            reasons=("initial_mapping_review_required",), evidence=_variant_evidence(product, target),
        ),)
    if len(exact) > 1:
        return tuple(
            _candidate(
                product, variant, rank=index, confidence=0.80, method="duplicate_canonical_identity",
                mapping_version=version, disposition="quarantined",
                reasons=("ambiguous_exact_catalog_variant",), evidence=_variant_evidence(product, variant),
            )
            for index, variant in enumerate(exact, 1)
        )

    same_finish = [variant for variant in same_name if product.finish == variant.finish]
    review_pool = same_finish or same_name
    confidence = 0.90 if same_finish else 0.80
    disposition = "review" if len(review_pool) == 1 and same_finish else "quarantined"
    reasons = (
        ("edition_or_variant_marker_mismatch", "manual_review_required")
        if same_finish else ("finish_mismatch", "manual_review_required")
    )
    return tuple(
        _candidate(
            product, variant, rank=index, confidence=confidence,
            method="partial_exact_identity", mapping_version=version,
            disposition=disposition, reasons=reasons,
            evidence=_variant_evidence(product, variant),
        )
        for index, variant in enumerate(review_pool, 1)
    )


def build_mapping_batch(
    products: Iterable[ExternalProduct],
    catalog: Iterable[CanonicalVariant],
    *,
    approved_mappings: Iterable[ApprovedMapping] = (),
    mapping_version: str,
) -> MappingBatch:
    values = tuple(products)
    if any(not isinstance(value, ExternalProduct) for value in values):
        raise ValueError("products must contain ExternalProduct values")
    variants = validate_catalog(catalog)
    approved = tuple(approved_mappings)
    groups: dict[tuple[str, str, str], list[ExternalProduct]] = {}
    for product in values:
        groups.setdefault(product.external_key, []).append(product)

    candidates: list[MappingCandidate] = []
    duplicate_count = 0
    for group in groups.values():
        signatures = {product.signature for product in group}
        if len(group) > 1:
            duplicate_count += len(group) - 1
        if len(signatures) > 1:
            for product in group:
                candidates.append(_candidate(
                    product, None, rank=1, confidence=0,
                    method="conflicting_external_identity", mapping_version=mapping_version,
                    disposition="quarantined",
                    reasons=("duplicate_external_identity_conflict",),
                    evidence={"conflictingRecordCount": len(group)},
                ))
            continue
        candidates.extend(map_external_product(
            group[0], variants,
            approved_mappings=approved,
            mapping_version=mapping_version,
        ))
    return MappingBatch(tuple(candidates), len(values), duplicate_count)


def build_catalog_ingestion_packet(
    catalog: Iterable[CanonicalVariant],
    products: Iterable[ExternalProduct],
    *,
    ingestion_run_id: str,
    terms_review_id: str,
    approved_mappings: Iterable[ApprovedMapping] = (),
    mapping_version: str,
) -> CatalogIngestionPacket:
    """Build deterministic service-role rows without performing a database write."""

    variants = validate_catalog(catalog)
    product_values = tuple(products)
    source_ids = {product.source_id for product in product_values}
    if len(source_ids) > 1:
        raise ValueError("one ingestion packet cannot mix source IDs")
    run_id = _uuid(ingestion_run_id, "ingestion_run_id")
    review_id = _uuid(terms_review_id, "terms_review_id")
    batch = build_mapping_batch(
        product_values,
        variants,
        approved_mappings=approved_mappings,
        mapping_version=mapping_version,
    )
    sets = {
        variant.card.set.id: variant.card.set.database_row()
        for variant in variants
    }
    cards = {
        variant.card.id: variant.card.database_row()
        for variant in variants
    }
    set_rows = tuple(sorted(sets.values(), key=lambda row: str(row["canonical_key"])))
    card_rows = tuple(sorted(cards.values(), key=lambda row: str(row["canonical_key"])))
    variant_rows = tuple(sorted(
        (variant.database_row() for variant in variants),
        key=lambda row: str(row["canonical_key"]),
    ))
    candidate_rows = tuple(sorted(
        (candidate.database_row(run_id, review_id) for candidate in batch.candidates),
        key=lambda row: (str(row["external_product_id"]), int(row["candidate_rank"]), str(row["candidate_hash"])),
    ))
    hash_input = {
        "sets": set_rows,
        "cards": card_rows,
        "variants": variant_rows,
        "candidateHashes": [row["candidate_hash"] for row in candidate_rows],
        "mappingVersion": mapping_version,
    }
    return CatalogIngestionPacket(
        catalog_sets=set_rows,
        catalog_cards=card_rows,
        catalog_variants=variant_rows,
        mapping_candidates=candidate_rows,
        dataset_hash=_digest(hash_input),
        records_quarantined=sum(
            candidate.disposition in {"quarantined", "unmapped"}
            for candidate in batch.candidates
        ),
    )
