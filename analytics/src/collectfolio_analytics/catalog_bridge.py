"""catalog-v2 B2: deterministic provider -> TCGCSV enrichment bridge.

TCGCSV is the canonical catalog spine (see docs/CATALOG_TCGCSV_PRIMARY_PRD.md).
This module builds the offline association tables that let the app join
secondary-provider display data (better images, card text) onto a TCGCSV
group/product for the three flagship categories -- Pokemon (3), Magic (1),
Yu-Gi-Oh! (2) -- without ever making TCGCSV depend on those providers for
product identity.

Two independent matching passes, both fail-closed (an ambiguous pair is
"unmatched", never a guess):

1. Set-level: a TCGCSV group (``tcgcsv_universe.normalize_group`` shape) is
   matched against a provider's set list by, in priority order:
     a. exact normalized-name equality
     b. exact normalized abbreviation/set-code equality
     c. normalized-name similarity (``difflib.SequenceMatcher``) at or
        above ``NAME_SIMILARITY_THRESHOLD``, constrained to release dates
        within ``DATE_TOLERANCE_DAYS`` of each other when both are known
   At each priority level, more than one candidate clearing the bar (or,
   for similarity, two candidates within ``AMBIGUITY_EPSILON`` of the best
   score) means the group is left unmatched rather than guessed.

2. Product-level: within an already-matched set, a TCGCSV product is
   matched against that provider set's cards by collector number
   (normalized -- leading zeros and whitespace stripped) first, falling
   back to exact normalized name. Same ambiguity-rejection rule.

This module is pure matching + serialization logic; it does not perform
any network I/O itself. ``catalog_bridge_fetch`` (a separate module) owns
the resumable, politely-paced provider HTTP fetch, mirroring
``hedonic_features.load_or_fetch_products_metadata``'s pattern -- kept
separate so the matcher stays trivially unit-testable against plain data.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from difflib import SequenceMatcher
from hashlib import sha256
import json
import re
import unicodedata
from typing import Mapping, Sequence

#: Flagship TCGCSV categoryId -> the single secondary provider B2 bridges
#: it against. Kept as the module's one source of truth for "which
#: category maps to which provider" so the CLI and tests share it.
FLAGSHIP_PROVIDERS: dict[int, str] = {3: "pokemon", 1: "scryfall", 2: "ygoprodeck"}

NAME_SIMILARITY_THRESHOLD = 0.88
DATE_TOLERANCE_DAYS = 45
AMBIGUITY_EPSILON = 0.02

BRIDGE_CONTRACT_VERSION = "catalog-bridge-v1"


def normalize_name(value: str | None) -> str:
    """Casefold + collapse whitespace/punctuation for name comparisons."""

    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    normalized = re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE)
    return re.sub(r"\s+", " ", normalized).strip()


#: Region infixes real-world provider collector numbers insert between a set
#: code and the numeric part (``"PSV-EN088"``, ``"2017-EN001"``) that TCGCSV's
#: own ``card_number`` field never carries (``"PSV-088"``, ``"2017-001"``).
#: Matched generically as 1-3 uppercase letters directly between a hyphen and
#: a digit, not an enumerated list, since new region codes appear over time.
_REGION_INFIX_RE = re.compile(r"-([A-Z]{1,3})(\d)")

#: A trailing ``"/<total-count-in-set>"`` TCGCSV appends to some card numbers
#: (``"001/102"``) that provider APIs never include (``"1"``) -- it encodes
#: set size, not card identity, so it is dropped entirely rather than merely
#: zero-stripped.
_SET_TOTAL_SUFFIX_RE = re.compile(r"/\d+$")

#: A leading zero run within any digit group, e.g. the ``"00"`` in ``"001"``
#: or ``"0088"`` -- collapsed everywhere (bare numbers and the numeric tail
#: of code-number forms alike) since TCGCSV and providers disagree on
#: zero-padding width, not on the underlying number.
_LEADING_ZEROS_RE = re.compile(r"(?<!\d)0+(\d)")


def normalize_collector_number(value: str | None) -> str:
    """Canonicalize a collector number so TCGCSV and provider forms compare
    equal, applied identically to BOTH sides of every product-level match.

    Pipeline (order matters -- each step's output feeds the next):
      1. NFKC-normalize, uppercase, strip surrounding whitespace.
      2. Drop a trailing ``"/<total>"`` set-size suffix entirely:
         ``"001/102"`` -> ``"001"``.
      3. Drop an alphabetic region infix between a set-code hyphen and the
         numeric part: ``"PSV-EN088"`` -> ``"PSV-088"``,
         ``"2017-EN001"`` -> ``"2017-001"``.
      4. Strip leading zeros from every digit run (bare numbers and the
         numeric tail of code-number forms alike): ``"001"`` -> ``"1"``,
         ``"PSV-088"`` -> ``"PSV-88"``.

    Alphabetic suffixes (``"12A"``) and set-code prefixes are preserved
    verbatim -- only padding/format disagreements are collapsed. Distinct
    numbers stay distinct after zero-stripping (``"10/102"`` -> ``"10"``,
    ``"100/102"`` -> ``"100"``): only *leading* zeros are ever stripped, so
    stripping never merges genuinely different card numbers.

    Real-world pairs this reconciles (from the flagship-category bridge
    coverage report): pokemon ``"001/102"`` <-> ``"1"``; yugioh
    ``"PSV-088"`` <-> ``"PSV-EN088"``; yugioh ``"2017-EN001"`` <-> ``"2017-001"``.
    """

    normalized = unicodedata.normalize("NFKC", str(value or "")).upper().strip()
    normalized = re.sub(r"\s+", "", normalized)
    normalized = _SET_TOTAL_SUFFIX_RE.sub("", normalized)
    normalized = _REGION_INFIX_RE.sub(r"-\2", normalized)
    return _LEADING_ZEROS_RE.sub(r"\1", normalized)


@dataclass(frozen=True, slots=True)
class SetMatch:
    category_id: int
    tcgcsv_group_id: int
    provider: str
    provider_set_id: str
    match_method: str  # "name-exact" | "abbreviation-exact" | "name-similarity"
    score: float


@dataclass(frozen=True, slots=True)
class SetUnmatched:
    category_id: int
    tcgcsv_group_id: int
    provider: str
    reason: str  # "no-candidate" | "ambiguous"


@dataclass(frozen=True, slots=True)
class ProductMatch:
    category_id: int
    tcgcsv_group_id: int
    tcgcsv_product_id: int
    provider: str
    provider_set_id: str
    provider_card_id: str
    match_method: str  # "collector-number" | "name-exact"


@dataclass(frozen=True, slots=True)
class ProductUnmatched:
    category_id: int
    tcgcsv_group_id: int
    tcgcsv_product_id: int
    provider: str
    reason: str  # "no-candidate" | "ambiguous"


def _within_date_tolerance(left: date | None, right: date | None) -> bool:
    if left is None or right is None:
        return True
    return abs((left - right).days) <= DATE_TOLERANCE_DAYS


def match_sets(
    category_id: int,
    provider: str,
    tcgcsv_groups: Sequence[Mapping[str, object]],
    provider_sets: Sequence[Mapping[str, object]],
) -> tuple[list[SetMatch], list[SetUnmatched]]:
    """Match TCGCSV groups (one category) against one provider's set list.

    ``tcgcsv_groups`` rows use ``tcgcsv_universe.normalize_group``'s shape
    (``group_id``, ``name``, ``abbreviation``, ``published_on``).
    ``provider_sets`` rows are the provider-agnostic shape
    ``{"id": str, "name": str, "code": str | None, "released_at": date | None}``.
    """

    matched: list[SetMatch] = []
    unmatched: list[SetUnmatched] = []

    for group in tcgcsv_groups:
        group_id = int(group["group_id"])
        group_name_norm = normalize_name(group.get("name"))
        group_abbr_norm = normalize_name(group.get("abbreviation"))
        published_on = group.get("published_on")

        exact = [pset for pset in provider_sets if normalize_name(pset.get("name")) == group_name_norm and group_name_norm]
        if len(exact) == 1:
            matched.append(SetMatch(category_id, group_id, provider, str(exact[0]["id"]), "name-exact", 1.0))
            continue
        if len(exact) > 1:
            unmatched.append(SetUnmatched(category_id, group_id, provider, "ambiguous"))
            continue

        abbr_candidates = [
            pset for pset in provider_sets
            if group_abbr_norm and normalize_name(pset.get("code")) == group_abbr_norm
        ]
        if len(abbr_candidates) == 1:
            matched.append(SetMatch(category_id, group_id, provider, str(abbr_candidates[0]["id"]), "abbreviation-exact", 1.0))
            continue
        if len(abbr_candidates) > 1:
            unmatched.append(SetUnmatched(category_id, group_id, provider, "ambiguous"))
            continue

        scored: list[tuple[Mapping[str, object], float]] = []
        for pset in provider_sets:
            if not _within_date_tolerance(published_on, pset.get("released_at")):
                continue
            ratio = SequenceMatcher(None, group_name_norm, normalize_name(pset.get("name"))).ratio()
            if ratio >= NAME_SIMILARITY_THRESHOLD:
                scored.append((pset, ratio))
        if not scored:
            unmatched.append(SetUnmatched(category_id, group_id, provider, "no-candidate"))
            continue
        scored.sort(key=lambda pair: -pair[1])
        best_pset, best_score = scored[0]
        contenders = [pair for pair in scored if best_score - pair[1] <= AMBIGUITY_EPSILON]
        if len(contenders) > 1:
            unmatched.append(SetUnmatched(category_id, group_id, provider, "ambiguous"))
            continue
        matched.append(SetMatch(category_id, group_id, provider, str(best_pset["id"]), "name-similarity", best_score))

    return matched, unmatched


def _provider_card_identity(card: Mapping[str, object]) -> str:
    """The underlying card identity behind a provider candidate row.

    Most providers' ``id`` is already the card identity verbatim (pokemon,
    scryfall -- this is a harmless no-op for them). ygoprodeck's ``id`` is
    ``"<cardId>:<setCode>"`` (one row per ``card_sets`` rarity-variant
    printing -- see ``catalog_bridge_fetch._normalize_ygo_cards``), so
    several rows can share one underlying card. Splitting off everything
    before the first ``":"`` recovers that shared identity for both.
    """

    return str(card.get("id", "")).split(":", 1)[0]


def _dedupe_provider_cards_by_identity(cards: Sequence[Mapping[str, object]]) -> list[Mapping[str, object]]:
    """Collapse rows that share an underlying card identity to one row.

    Several ygoprodeck rows can be the SAME card printed with different
    rarities in the same set (identical cardId+setId+number, one row per
    ``card_sets`` entry) -- those must count as exactly one match
    candidate, not N, or the ambiguity check below rejects a match that
    isn't actually ambiguous. Keeps the first row per identity
    (deterministic, input-order) so ``providerCardId`` in the bridge table
    is stable across rebuilds of the same cache.
    """

    seen: set[str] = set()
    deduped: list[Mapping[str, object]] = []
    for card in cards:
        identity = _provider_card_identity(card)
        if identity in seen:
            continue
        seen.add(identity)
        deduped.append(card)
    return deduped


def match_products(
    category_id: int,
    tcgcsv_group_id: int,
    provider: str,
    provider_set_id: str,
    tcgcsv_products: Sequence[Mapping[str, object]],
    provider_cards: Sequence[Mapping[str, object]],
) -> tuple[list[ProductMatch], list[ProductUnmatched]]:
    """Match TCGCSV products in one already set-matched group against a
    provider's card list for that set.

    ``tcgcsv_products`` rows use ``tcgcsv_universe.normalize_product``'s
    shape (``product_id``, ``card_number``, ``clean_name``/``name``).
    ``provider_cards`` rows are ``{"id": str, "number": str | None, "name": str}``,
    deduped by underlying card identity (``_provider_card_identity``)
    before matching -- several rows can be the SAME card (e.g. ygoprodeck's
    one-row-per-rarity-variant printings); only truly distinct card ids
    colliding on a canonical number are ambiguous.
    """

    matched: list[ProductMatch] = []
    unmatched: list[ProductUnmatched] = []
    provider_cards = _dedupe_provider_cards_by_identity(provider_cards)

    for product in tcgcsv_products:
        product_id = int(product["product_id"])
        number_norm = normalize_collector_number(product.get("card_number"))
        name_norm = normalize_name(product.get("clean_name") or product.get("name"))

        if number_norm:
            by_number = [card for card in provider_cards if normalize_collector_number(card.get("number")) == number_norm]
            if len(by_number) == 1:
                matched.append(ProductMatch(category_id, tcgcsv_group_id, product_id, provider, provider_set_id, str(by_number[0]["id"]), "collector-number"))
                continue
            if len(by_number) > 1:
                unmatched.append(ProductUnmatched(category_id, tcgcsv_group_id, product_id, provider, "ambiguous"))
                continue

        by_name = [card for card in provider_cards if name_norm and normalize_name(card.get("name")) == name_norm]
        if len(by_name) == 1:
            matched.append(ProductMatch(category_id, tcgcsv_group_id, product_id, provider, provider_set_id, str(by_name[0]["id"]), "name-exact"))
            continue
        if len(by_name) > 1:
            unmatched.append(ProductUnmatched(category_id, tcgcsv_group_id, product_id, provider, "ambiguous"))
            continue

        unmatched.append(ProductUnmatched(category_id, tcgcsv_group_id, product_id, provider, "no-candidate"))

    return matched, unmatched


@dataclass(frozen=True, slots=True)
class BridgeMatchRates:
    set_total: int
    set_matched: int
    set_by_method: dict[str, int]
    set_unmatched_by_reason: dict[str, int]
    product_total: int
    product_matched: int
    product_by_method: dict[str, int]
    product_unmatched_by_reason: dict[str, int]


def _tally(items: Sequence[object], attr: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        key = getattr(item, attr)
        counts[key] = counts.get(key, 0) + 1
    return counts


def summarize_match_rates(
    set_matched: Sequence[SetMatch],
    set_unmatched: Sequence[SetUnmatched],
    product_matched: Sequence[ProductMatch],
    product_unmatched: Sequence[ProductUnmatched],
) -> BridgeMatchRates:
    return BridgeMatchRates(
        set_total=len(set_matched) + len(set_unmatched),
        set_matched=len(set_matched),
        set_by_method=_tally(set_matched, "match_method"),
        set_unmatched_by_reason=_tally(set_unmatched, "reason"),
        product_total=len(product_matched) + len(product_unmatched),
        product_matched=len(product_matched),
        product_by_method=_tally(product_matched, "match_method"),
        product_unmatched_by_reason=_tally(product_unmatched, "reason"),
    )


def _content_hash(value: object) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(payload.encode("utf-8")).hexdigest()


def build_bridge_table(
    category_id: int,
    provider: str,
    as_of: str,
    set_matches: Sequence[SetMatch],
    product_matches: Sequence[ProductMatch],
) -> dict[str, object]:
    """Serialize matched pairs into the publishable per-category bridge
    payload the worker stores at ``bridge/<categoryId>.json.gz`` and the
    app fetches via ``GET /catalog/bridge/<categoryId>``.

    Only *matched* pairs are published -- unmatched products are simply
    absent, which is the app's fail-closed "render unenriched" case for
    free (no explicit exclusion bookkeeping needed, mirroring the
    trajectory-v1 forecast manifest's "absent == not eligible" contract).
    """

    payload = {
        "modelVersion": BRIDGE_CONTRACT_VERSION,
        "categoryId": int(category_id),
        "provider": provider,
        "asOf": as_of,
        "sets": [
            {"groupId": row.tcgcsv_group_id, "providerSetId": row.provider_set_id, "matchMethod": row.match_method}
            for row in sorted(set_matches, key=lambda row: row.tcgcsv_group_id)
        ],
        "products": [
            {
                "groupId": row.tcgcsv_group_id,
                "productId": row.tcgcsv_product_id,
                "providerSetId": row.provider_set_id,
                "providerCardId": row.provider_card_id,
                "matchMethod": row.match_method,
            }
            for row in sorted(product_matches, key=lambda row: (row.tcgcsv_group_id, row.tcgcsv_product_id))
        ],
    }
    payload["contentHash"] = _content_hash(payload)
    return payload
