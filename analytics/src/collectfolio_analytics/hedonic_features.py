"""Hedonic cold-start feature engineering (trajectory-v1 PRD §4/T3).

Two independent pieces:

1. Pure feature functions -- ``set_family()`` (a Python port of the app's
   ``SET_FAMILY_RULES``/``setFamily()`` in
   ``app/assets/js/services/catalog-browse.js``, NOT a reimport -- app code
   is not touched by this task) and ``product_kind()`` (the T3 brief's
   literal "a product with no card number/rarity is sealed" rule; the
   brief also references a ``catalogProductKind`` helper in the same JS
   file as the source of that rule, but no such function exists anywhere
   in the codebase -- searched exhaustively. This implements the rule text
   directly and the discrepancy is disclosed in the T3 report).

2. A minimal, resumable, ``community_free_access`` products-metadata
   fetcher for the ``tcgplayer/<categoryId>/<groupId>/products`` endpoint,
   mirroring ``lifecycle.py``'s T2 fetch pattern (bounded single request
   per call, injectable fetch seam for tests, atomic cache write) rather
   than reusing the private/research-only ``tcgcsv_universe_cli.py`` /
   ``tcgcsv.py::TCGCSVClient`` transport (see PRD §1's source-rights note:
   that transport enforces ``research_only`` terms; this feature is a
   public-facing forecast input and needs its own community-free-access
   fetch identity). Only ``tcgcsv_universe.normalize_product`` is reused,
   for pure parsing of the raw JSON payload -- not transport.

Because a products fetch is one request *per group* (roughly 1,800 groups
across the four trajectory-v1 categories, vs. 4 requests for groups
metadata), it will not reliably finish in a single bounded call within the
lane's ~10 minute unattended-run guidance. ``load_or_fetch_products_metadata``
is therefore explicitly resumable: each call fetches at most
``max_requests`` new (category, group) pairs, persists progress to the
cache file, and can simply be called again to continue. Callers that hit
the request budget before covering every requested group get
``truncated=True`` back and may fit the hedonic model on the features that
do not require this fetch (finish, release age, set family, kind,
group-level price statistics) per the brief's explicit graceful-degradation
clause -- rarity/number are optional enrichments, not a hard dependency.
"""

from __future__ import annotations

import gzip
import json
import re
import time
from dataclasses import dataclass
from datetime import date
from hashlib import sha256
from math import isnan, log
from pathlib import Path
from statistics import median
from typing import Callable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from .hedonic import FeatureRow, structural_scarcity_proxy
from .lifecycle import release_age_weeks
from .tcgcsv_universe import normalize_product
from .trajectory import _load_category_prices, last_known

DEFAULT_BASE_URL = "https://tcgcsv.com/"
DEFAULT_USER_AGENT = "CollectFolio/0.1 trajectory-v1 hedonic cold-start (community-free-access)"
PRODUCTS_CACHE_FILENAME = "products_metadata.json.gz"
MAX_PRODUCTS_JSON_BYTES = 8 * 1024 * 1024

#: Politeness delay between per-group product requests. Mirrors the
#: rate-limiting pattern used by tcgcsv_universe_cli.py's RequestBudget
#: (that module is not imported here -- it is private/research-only --
#: but its delay magnitude is a reasonable, already-battle-tested default).
REQUEST_DELAY_SECONDS = 0.12

#: Default per-call request budget. Roughly 1,800 groups exist across the
#: four trajectory-v1 categories; at ~0.2s/request (fetch + politeness
#: delay) 1,800 requests is ~6 minutes, comfortably inside the lane's ~10
#: minute unattended-run guidance, so the default covers a full pass in
#: one call while still being resumable if the source is slower than this
#: estimate on a given day.
DEFAULT_MAX_REQUESTS = 2_000


class HedonicFeatureError(RuntimeError):
    """Raised when products metadata cannot be fetched or parsed."""


# ---------------------------------------------------------------------------
# Set family (port of app/assets/js/services/catalog-browse.js SET_FAMILY_RULES)
# ---------------------------------------------------------------------------

#: (id, display name, pattern) -- verbatim regex bodies from
#: catalog-browse.js's SET_FAMILY_RULES, compiled case-insensitive here
#: since the JS patterns run against an already-lowercased haystack.
#:
#: Deviation from the JS original: TCGCSV group metadata (see
#: tcgcsv_universe.normalize_group) has no ``setType`` field -- only
#: ``name`` and ``metadata.isSupplemental`` -- so this matches against the
#: group name alone instead of ``f"{name} {setType}"``. Documented, minor,
#: intentional adaptation.
SET_FAMILY_RULES: tuple[tuple[str, str, "re.Pattern[str]"], ...] = (
    ("commander", "Commander", re.compile(r"\bcommander\b", re.IGNORECASE)),
    ("secret-lair", "Secret Lair", re.compile(r"secret lair", re.IGNORECASE)),
    ("universes-beyond", "Universes Beyond", re.compile(r"universes beyond", re.IGNORECASE)),
    ("jumpstart", "Jumpstart", re.compile(r"jumpstart", re.IGNORECASE)),
    (
        "masters-reprints",
        "Masters & reprints",
        re.compile(r"\bmasters\b|remastered|anthology|chronicles", re.IGNORECASE),
    ),
    (
        "preconstructed",
        "Preconstructed decks",
        re.compile(
            r"duel deck|starter|structure deck|theme deck|intro pack|event deck|"
            r"planeswalker deck|challenger deck|trainer kit|battle deck|league battle",
            re.IGNORECASE,
        ),
    ),
    (
        "promos",
        "Promos & prerelease",
        re.compile(r"\bpromos?\b|prerelease|black star|championship|judge", re.IGNORECASE),
    ),
    (
        "collections",
        "Collections & box sets",
        re.compile(r"collection|box set|premium|treasure chest|gift set|bundle", re.IGNORECASE),
    ),
)

#: Stable, finite vocabulary for the hedonic design matrix's set-family
#: one-hot block (order matches SET_FAMILY_RULES + the two fallback ids).
SET_FAMILY_IDS: tuple[str, ...] = tuple(rule_id for rule_id, _name, _pattern in SET_FAMILY_RULES) + (
    "other-supplemental",
    "main",
)


def set_family(group_name: str | None, is_supplemental: bool) -> str:
    """Port of catalog-browse.js's ``setFamily()``, id only."""

    haystack = group_name or ""
    for rule_id, _rule_name, pattern in SET_FAMILY_RULES:
        if pattern.search(haystack):
            return rule_id
    return "other-supplemental" if is_supplemental else "main"


def product_kind(card_number: str | None, rarity: str | None) -> str:
    """"a product with no card number/rarity is sealed" (T3 brief, literal rule).

    See module docstring: the brief's ``catalogProductKind`` reference does
    not exist in the codebase; this is the brief's own rule text, applied
    directly.
    """

    has_number = bool((card_number or "").strip())
    has_rarity = bool((rarity or "").strip())
    return "single" if (has_number or has_rarity) else "sealed"


#: "unknown" is used (not "sealed") when products metadata was never
#: fetched for a product at all -- see build_category_feature_rows -- so
#: the "sealed" bucket is never contaminated by mere metadata absence.
PRODUCT_KIND_IDS: tuple[str, ...] = ("single", "sealed", "unknown")


# ---------------------------------------------------------------------------
# Product format (FA-04): a productFormat categorical feature that splits
# the single "sealed" productKind dummy into its real sub-classes.
#
# The defect this fixes: one productKind=="sealed" dummy is asked to
# represent everything from a single loose pack to a full sealed case (a
# ~100x price spread), and the hedonic level anchor (groupLogPriceMedian)
# is a singles-dominated group median in every group that mixes singles and
# sealed product. Together those saturate the anchor clamp downward for
# premium sealed items (a case gets anchored near a pack's price level) and
# center attribute-reference ranges far below market. This feature gives
# the design matrix a real per-format dummy so the regression can learn a
# case is not a tin; groupSealedLogPriceMedian (below) gives it a sealed-
# only price level to anchor against instead of the singles-dominated one.
# ---------------------------------------------------------------------------

#: Stable, finite vocabulary for the hedonic design matrix's productFormat
#: one-hot block. "single" and "unknown" are not sealed sub-formats -- they
#: are the non-sealed/metadata-absent short-circuits product_format()
#: returns before ever consulting the keyword rules below.
PRODUCT_FORMAT_IDS: tuple[str, ...] = (
    "single", "case", "elite-trainer-box", "booster-box", "bundle-collection-box",
    "tin", "deck", "pack", "sealed-other", "unknown",
)

#: Keyword rules for classifying a SEALED product's name into a format
#: level, aligned with sealed.py's PRODUCT_TYPES taxonomy (loose_pack,
#: booster_box, booster_bundle, elite_trainer_box, collection_box, tin,
#: other) plus "case" and "deck", per the T4 brief. All patterns are
#: case-insensitive and use word boundaries so e.g. "packs" or "decks"
#: still match but "unpack" or "decked" do not.
#:
#: Priority order (checked top to bottom, first match wins), NOT a literal
#: longest-matched-substring comparison -- and that is a deliberate,
#: verified deviation from a naive reading of "longest-match-wins":
#: "case" is checked FIRST, unconditionally, ahead of every other rule.
#: The brief's own worked examples prove a literal longest-substring
#: algorithm cannot produce the required answer: in "Destined Rivals
#: Booster Box Case" the "booster box" match (11 characters) is textually
#: LONGER than the "case" match (4 characters), yet the required
#: classification is "case", not "booster-box". The only self-consistent
#: reading is a priority/tier order -- a "case" is a bulk unit of many
#: boxes/tins/etc. and is genuinely the "longest" (highest-price,
#: outermost) sealed container tier, so it outranks whatever smaller
#: container word also happens to appear in the same name. Verified
#: against both of the brief's live examples plus "Paldean Fates Tin
#: Case" -> "case", not "tin" (see ProductFormatTests).
_SEALED_FORMAT_RULES: tuple[tuple[str, "re.Pattern[str]"], ...] = (
    ("case", re.compile(r"\bcases?\b", re.IGNORECASE)),
    (
        "elite-trainer-box",
        re.compile(r"\belite\s+trainer\s+box(?:es)?\b|\betbs?\b", re.IGNORECASE),
    ),
    ("booster-box", re.compile(r"\bbooster\s+box(?:es)?\b", re.IGNORECASE)),
    (
        "bundle-collection-box",
        re.compile(
            r"\bbooster\s+bundle\b|\bbundle(?:s)?\b|\bcollection\s+box(?:es)?\b|"
            r"\bcollector'?s?\s+box(?:es)?\b|\bgift\s+(?:set|box)\b",
            re.IGNORECASE,
        ),
    ),
    ("tin", re.compile(r"\btins?\b", re.IGNORECASE)),
    (
        "deck",
        re.compile(
            r"\bdecks?\b|\bstarter\b|\bstructure\s+deck\b|\btheme\s+deck\b|"
            r"\bbattle\s+deck\b|\bchallenger\s+deck\b|\bpreconstructed\b",
            re.IGNORECASE,
        ),
    ),
    ("pack", re.compile(r"\bpacks?\b|\bbooster(?:s)?\b", re.IGNORECASE)),
)


def product_format(name: str | None, kind: str) -> str:
    """FA-04 productFormat classifier: sub-classify a "sealed" productKind.

    Deterministic and pure. ``kind`` (from ``product_kind()``/
    ``PRODUCT_KIND_IDS``) short-circuits the two non-sealed cases first:
    every single gets "single" regardless of name (subdividing singles by
    name is out of scope here), and "unknown" (metadata never fetched for
    this product at all) stays "unknown" rather than guessing from an
    absent name. Only ``kind == "sealed"`` consults ``_SEALED_FORMAT_RULES``
    against ``name``; a sealed product whose name matches none of them (or
    whose name is missing/empty, e.g. an older cached products-metadata
    entry fetched before this feature persisted ``name`` -- see
    ``load_or_fetch_products_metadata``) gets "sealed-other", per the T4
    brief, rather than being silently dropped or misclassified.
    """

    if kind == "unknown":
        return "unknown"
    if kind != "sealed":
        return "single"
    haystack = name or ""
    for format_id, pattern in _SEALED_FORMAT_RULES:
        if pattern.search(haystack):
            return format_id
    return "sealed-other"


# ---------------------------------------------------------------------------
# Products metadata fetch (community-free-access)
# ---------------------------------------------------------------------------


def _url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/") + "/"
    result = urljoin(base, path.lstrip("/"))
    if not result.startswith(base):
        raise HedonicFeatureError("products path escaped the configured origin")
    return result


FetchGroupProductsJson = Callable[[str, int, int], object]


def _default_fetch_group_products_json(
    base_url: str,
    category_id: int,
    group_id: int,
    *,
    user_agent: str,
    timeout_seconds: float,
) -> object:
    request = Request(
        _url(base_url, f"tcgplayer/{category_id}/{group_id}/products"),
        headers={"User-Agent": user_agent, "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310
            payload = response.read(MAX_PRODUCTS_JSON_BYTES + 1)
    except HTTPError as exc:
        if exc.code == 404:
            return {"success": True, "results": []}
        raise HedonicFeatureError(
            f"products fetch failed for category {category_id} group {group_id}: HTTP {exc.code}"
        ) from exc
    except URLError as exc:
        raise HedonicFeatureError(
            f"products fetch failed for category {category_id} group {group_id}: {exc.reason}"
        ) from exc
    if len(payload) > MAX_PRODUCTS_JSON_BYTES:
        raise HedonicFeatureError("products response exceeds its size limit")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HedonicFeatureError(
            f"products response for category {category_id} group {group_id} is not valid JSON"
        ) from exc


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _content_sha256(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class ProductsFetchResult:
    """Summary of one (possibly partial) products-metadata fetch pass."""

    groups_requested: int
    groups_already_cached: int
    groups_fetched_this_call: int
    groups_failed_this_call: int
    requests_made_this_call: int
    elapsed_seconds: float
    truncated: bool
    cache_content_hash: str
    product_count: int


def load_or_fetch_products_metadata(
    cache_path: Path,
    group_keys: Sequence[tuple[int, int]],
    *,
    max_requests: int = DEFAULT_MAX_REQUESTS,
    request_delay_seconds: float = REQUEST_DELAY_SECONDS,
    base_url: str = DEFAULT_BASE_URL,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout_seconds: float = 30.0,
    fetch_json: FetchGroupProductsJson | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[dict[tuple[int, int], dict[str, object]], ProductsFetchResult]:
    """Fetch (and durably, resumably cache) per-product card_number/rarity.

    ``group_keys`` is the full set of ``(category_id, group_id)`` pairs the
    caller wants covered. Groups already present in the cache's
    ``fetchedGroups`` set are skipped without a network call. At most
    ``max_requests`` *new* HTTP requests are made in this call; if more
    groups remain uncovered afterward, ``ProductsFetchResult.truncated`` is
    ``True`` and the caller may invoke this function again later to
    continue, or proceed without full rarity/number coverage per the T3
    brief's graceful-degradation clause.

    Returns ``{(category_id, product_id): normalized_product_record}`` for
    every product ever fetched into this cache (not just this call's new
    groups), plus a per-call fetch summary for receipts.
    """

    fetcher = fetch_json or (
        lambda cat, grp: _default_fetch_group_products_json(
            base_url, cat, grp, user_agent=user_agent, timeout_seconds=timeout_seconds
        )
    )

    cache_path = Path(cache_path)
    fetched_groups: set[tuple[int, int]] = set()
    products: dict[tuple[int, int], dict[str, object]] = {}
    if cache_path.is_file():
        with gzip.open(cache_path, "rt", encoding="utf-8") as handle:
            raw = json.load(handle)
        for cat, grp in raw.get("fetchedGroups", []):
            fetched_groups.add((int(cat), int(grp)))
        for row in raw.get("products", []):
            products[(int(row["category_id"]), int(row["product_id"]))] = row

    requested = {(int(c), int(g)) for c, g in group_keys}
    already_cached = len(requested & fetched_groups)
    remaining = sorted(requested - fetched_groups)

    started = time.monotonic()
    requests_made = 0
    fetched_this_call = 0
    failed_this_call = 0
    truncated = False

    for idx, (category_id, group_id) in enumerate(remaining):
        if requests_made >= max_requests:
            truncated = True
            break
        try:
            payload = fetcher(category_id, group_id)
        except HedonicFeatureError:
            failed_this_call += 1
            requests_made += 1
            if idx + 1 < len(remaining):
                sleep(request_delay_seconds)
            continue
        requests_made += 1
        if isinstance(payload, Mapping) and payload.get("success") is True:
            rows = payload.get("results")
            if isinstance(rows, list):
                for raw_product in rows:
                    if not isinstance(raw_product, Mapping):
                        continue
                    try:
                        normalized = normalize_product(category_id, group_id, raw_product)
                    except Exception:  # noqa: BLE001 -- one malformed product must not abort the pass
                        continue
                    key = (int(normalized["category_id"]), int(normalized["product_id"]))
                    # Persist the fields this module's features actually
                    # consume (card_number, rarity, and -- FA-04 -- name,
                    # needed to classify a sealed product's productFormat
                    # from its own listing title) plus enough identity/hash
                    # for receipts -- still deliberately dropping
                    # normalize_product's description/extendedData/cleanName
                    # to avoid retaining more provider content than these
                    # features need (PRD Sec1 source-rights minimalism).
                    # ``name`` is the same public listing title already
                    # rendered on TCGCSV/TCGplayer product pages, not new
                    # exposure. Additive vs. the pre-FA-04 cache schema: an
                    # older cache file fetched before this change simply has
                    # no "name" key per product, and every reader here
                    # already treats a missing/falsy field as an honest
                    # "unknown"/"sealed-other", never an error.
                    products[key] = {
                        "category_id": normalized["category_id"],
                        "group_id": normalized["group_id"],
                        "product_id": normalized["product_id"],
                        "name": normalized["name"],
                        "card_number": normalized["card_number"],
                        "rarity": normalized["rarity"],
                        "card_type": normalized["card_type"],
                        "product_sha256": normalized["product_sha256"],
                    }
            fetched_groups.add((category_id, group_id))
            fetched_this_call += 1
        else:
            failed_this_call += 1
        if idx + 1 < len(remaining):
            sleep(request_delay_seconds)

    elapsed = time.monotonic() - started

    payload_out = {
        "fetchedGroups": sorted([list(pair) for pair in fetched_groups]),
        "products": [products[key] for key in sorted(products)],
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = cache_path.with_suffix(cache_path.suffix + ".part")
    with gzip.open(tmp_path, "wt", encoding="utf-8") as handle:
        handle.write(_canonical_json(payload_out))
    tmp_path.replace(cache_path)

    result = ProductsFetchResult(
        groups_requested=len(requested),
        groups_already_cached=already_cached,
        groups_fetched_this_call=fetched_this_call,
        groups_failed_this_call=failed_this_call,
        requests_made_this_call=requests_made,
        elapsed_seconds=round(elapsed, 3),
        truncated=truncated,
        cache_content_hash=_content_sha256(payload_out),
        product_count=len(products),
    )
    return products, result


# ---------------------------------------------------------------------------
# Per-category FeatureRow assembly (panel + groups metadata + optional
# products metadata -> hedonic.FeatureRow objects, one per variant)
# ---------------------------------------------------------------------------

#: Continuous fields used by the main hedonic model (see trajectory_cli.py's
#: fit-hedonic wiring). "desirabilityProxy" is deliberately excluded here --
#: it is an exact alias of "releaseAgeWeeks" kept only for the video_model_v0
#: ablation's literal two-feature naming (see hedonic.fit_video_model_v0_ablation),
#: and including both would make the main model's design matrix trivially
#: collinear in that one column pair for no modeling benefit.
#: "groupSealedLogPriceMedian" (FA-04) is additive to, not a replacement
#: for, "groupLogPriceMedian": the regression gets to see both the group's
#: overall (singles-dominated) price level and its sealed-only price level,
#: and productFormat/productKind dummies let it learn which one each row's
#: format actually tracks.
MAIN_MODEL_CONTINUOUS_FIELDS = (
    "releaseAgeWeeks", "groupLogPriceMedian", "groupSealedLogPriceMedian", "scarcityProxy",
)

#: Continuous fields used by the video_model_v0 ablation fit, matching its
#: original two-feature form (pull_cost, desirability) -- see
#: hedonic.ABLATION_PROXY_NOTES for the honest proxy-substitution disclosure.
ABLATION_CONTINUOUS_FIELDS = ("scarcityProxy", "desirabilityProxy")


@dataclass(frozen=True, slots=True)
class CategoryFeatureSet:
    """One category's assembled hedonic inputs, one entry per variant.

    Ordering matches ``sorted(variant_index.items())`` (i.e. sorted by
    ``(product_id, subtype)``), the same deterministic order
    ``trajectory.process_category`` emits packet rows in.
    """

    category_id: int
    keys: tuple[tuple[int, str], ...]  # (product_id, subtype)
    variant_group: tuple[int, ...]
    rows: tuple[FeatureRow, ...]
    log_price: tuple[float, ...]  # nan for variants with no usable history
    has_history: tuple[bool, ...]
    rarity_coverage: float  # fraction of variants with non-"unknown" rarity


def _group_log_price_features(variant_group: Sequence[int], log_price: Sequence[float]) -> list[float]:
    """Leave-one-out group median log-price (a "group-level price statistic").

    Leave-one-out for variants that themselves have a known price (so the
    feature is not a trivial leak of that variant's own target through the
    group aggregate); the plain group median for cold-start variants (they
    have no own price to leave out and are never part of the training
    target, so no leakage risk there). Falls back to the category-wide
    median for singleton/fully-cold-start groups.
    """

    by_group: dict[int, list[int]] = {}
    for i, g in enumerate(variant_group):
        if not isnan(log_price[i]):
            by_group.setdefault(g, []).append(i)
    category_values = [lp for lp in log_price if not isnan(lp)]
    category_fallback = median(category_values) if category_values else 0.0

    out = [category_fallback] * len(variant_group)
    for indices in by_group.values():
        if len(indices) < 2:
            continue
        values = [log_price[j] for j in indices]
        for local_pos, i in enumerate(indices):
            others = values[:local_pos] + values[local_pos + 1:]
            out[i] = median(others)
    for i, lp in enumerate(log_price):
        if isnan(lp):
            indices = by_group.get(variant_group[i])
            if indices:
                out[i] = median(log_price[j] for j in indices)
    return out


def _group_sealed_log_price_features(
    variant_group: Sequence[int],
    log_price: Sequence[float],
    is_sealed: Sequence[bool],
    group_wide_median: Sequence[float],
) -> list[float]:
    """FA-04: leave-one-out group median log-price across SEALED variants only.

    Mirrors ``_group_log_price_features``'s leave-one-out anti-leakage
    construction (a priced variant never sees its own price folded into its
    own feature value), restricted to ``productKind == "sealed"`` variants
    with a known price. The plain (all-kinds) ``groupLogPriceMedian`` is
    singles-dominated in every group that mixes singles and sealed product
    -- exactly what saturates the hedonic anchor downward for premium
    sealed items (see this module's productFormat section docstring). This
    feature isolates the sealed price *level* instead.

    Falls back to ``group_wide_median[i]`` (the caller's already-computed
    all-kinds group median) for any variant whose group has fewer than two
    priced sealed variants: below that a sealed-only leave-one-out estimate
    is either undefined (zero priced sealed variants in the group -- the
    documented fallback case per the T4 brief) or would trivially leak the
    lone sealed price back to itself (exactly one). A non-sealed variant in
    a group that DOES have >=2 priced sealed variants still gets that
    group's real sealed-only median -- it is never that variant's own
    price, so there is no leakage risk there.
    """

    members_by_group: dict[int, list[int]] = {}
    for i, g in enumerate(variant_group):
        members_by_group.setdefault(g, []).append(i)

    by_group_sealed: dict[int, list[int]] = {}
    for i, g in enumerate(variant_group):
        if is_sealed[i] and not isnan(log_price[i]):
            by_group_sealed.setdefault(g, []).append(i)

    out = list(group_wide_median)
    for g, sealed_indices in by_group_sealed.items():
        if len(sealed_indices) < 2:
            continue
        values = [log_price[j] for j in sealed_indices]
        sealed_set = set(sealed_indices)
        plain_median = median(values)
        for local_pos, i in enumerate(sealed_indices):
            others = values[:local_pos] + values[local_pos + 1:]
            out[i] = median(others)
        for i in members_by_group[g]:
            if i not in sealed_set:
                out[i] = plain_median
    return out


def build_category_feature_rows(
    panel_dir: Path,
    category_id: int,
    dates: Sequence[date],
    groups_metadata: Mapping[tuple[int, int], Mapping[str, object]],
    products_metadata: Mapping[tuple[int, int], Mapping[str, object]] | None,
    as_of: date,
) -> CategoryFeatureSet:
    """Assemble one ``hedonic.FeatureRow`` per variant for a category.

    ``products_metadata`` may be ``None`` or partial (see
    ``load_or_fetch_products_metadata``'s resumability/graceful-degradation
    note): variants with no matching entry simply get ``rarity="unknown"``
    and ``productKind`` derived from an empty card_number/rarity (i.e.
    "sealed" -- see ``product_kind``'s docstring for the honesty tradeoff
    this implies when metadata is merely missing rather than genuinely
    sealed; documented in the T3 report, not silently swallowed).
    """

    variant_index, variant_group, prices = _load_category_prices(panel_dir, category_id, dates)
    ordered_keys = sorted(variant_index.items())  # [((product_id, subtype), idx), ...]

    log_price: list[float] = [float("nan")] * len(ordered_keys)
    has_history: list[bool] = [False] * len(ordered_keys)
    # FA-04: productKind/name resolved up front (per-product lookups that
    # do not depend on groups_metadata) so the sealed-only group median
    # feature below can be computed before the main per-variant loop runs.
    kind_by_idx: list[str] = ["unknown"] * len(ordered_keys)
    name_by_idx: list[object] = [None] * len(ordered_keys)
    for (product_id, _subtype), idx in ordered_keys:
        found = last_known(prices[idx])
        if found is not None:
            _t, price = found
            log_price[idx] = log(price)
            has_history[idx] = True
        product_meta = (products_metadata or {}).get((category_id, product_id))
        card_number = product_meta.get("card_number") if product_meta else None
        rarity = product_meta.get("rarity") if product_meta else None
        kind_by_idx[idx] = product_kind(card_number, rarity) if product_meta is not None else "unknown"
        name_by_idx[idx] = product_meta.get("name") if product_meta else None
    is_sealed = [k == "sealed" for k in kind_by_idx]

    group_counts: dict[int, int] = {}
    for g in variant_group:
        group_counts[g] = group_counts.get(g, 0) + 1

    group_median_feature = _group_log_price_features(variant_group, log_price)
    group_sealed_median_feature = _group_sealed_log_price_features(
        variant_group, log_price, is_sealed, group_median_feature,
    )

    known_ages = []
    for (_pid, _sub), idx in ordered_keys:
        group_id = variant_group[idx]
        meta = groups_metadata.get((category_id, group_id), {})
        age = release_age_weeks(meta.get("published_on"), as_of)
        if age is not None:
            known_ages.append(age)
    fallback_age = float(median(known_ages)) if known_ages else 0.0

    rows: list[FeatureRow] = []
    keys_out: list[tuple[int, str]] = []
    variant_group_out: list[int] = []
    log_price_out: list[float] = []
    has_history_out: list[bool] = []
    rarity_known = 0

    for (product_id, subtype), idx in ordered_keys:
        group_id = variant_group[idx]
        group_meta = groups_metadata.get((category_id, group_id), {})
        group_name = group_meta.get("name")
        is_supplemental = bool((group_meta.get("metadata") or {}).get("isSupplemental", False))
        age = release_age_weeks(group_meta.get("published_on"), as_of)
        release_age = float(age) if age is not None else fallback_age

        product_meta = (products_metadata or {}).get((category_id, product_id))
        rarity = product_meta.get("rarity") if product_meta else None
        if rarity:
            rarity_known += 1
        # "unknown" (not product_kind()'s "sealed") when metadata was never
        # fetched for this product at all -- a genuinely sealed product and
        # a single with merely-missing metadata must not collapse into the
        # same bucket (see PRODUCT_KIND_IDS docstring). Computed above
        # (kind_by_idx/name_by_idx) so it is available to the sealed-only
        # group median feature; reused here rather than recomputed.
        kind = kind_by_idx[idx]
        fmt = product_format(name_by_idx[idx], kind)

        scarcity = structural_scarcity_proxy(group_counts.get(group_id, 1))
        categorical = {
            "setFamily": set_family(str(group_name) if group_name else None, is_supplemental),
            "productKind": kind,
            "productFormat": fmt,
            "finish": subtype or "unknown",
            "rarity": rarity or "unknown",
        }
        continuous = {
            "releaseAgeWeeks": release_age,
            "groupLogPriceMedian": group_median_feature[idx],
            "groupSealedLogPriceMedian": group_sealed_median_feature[idx],
            "scarcityProxy": scarcity,
            "desirabilityProxy": release_age,
        }
        rows.append(FeatureRow(group_id=group_id, categorical=categorical, continuous=continuous))
        keys_out.append((product_id, subtype))
        variant_group_out.append(group_id)
        log_price_out.append(log_price[idx])
        has_history_out.append(has_history[idx])

    rarity_coverage = (rarity_known / len(ordered_keys)) if ordered_keys else 0.0

    return CategoryFeatureSet(
        category_id=category_id,
        keys=tuple(keys_out),
        variant_group=tuple(variant_group_out),
        rows=tuple(rows),
        log_price=tuple(log_price_out),
        has_history=tuple(has_history_out),
        rarity_coverage=rarity_coverage,
    )


#: Default subtype assigned to a genuinely-never-priced product (see
#: ``cold_start_candidates``). The panel key space is (product_id,
#: subTypeName) but products_metadata (the /products endpoint) has no
#: per-finish breakdown -- a brand-new product's eventual finish mix is
#: unknown until it is first priced. "Normal" is overwhelmingly the modal
#: subtype across the current panel; a documented simplification, not a
#: reconstruction of unknowable finish data.
COLD_START_DEFAULT_SUBTYPE = "Normal"


@dataclass(frozen=True, slots=True)
class ColdStartFeatureSet:
    """Hedonic feature rows for products with ZERO price observations ever.

    Unlike ``CategoryFeatureSet`` (built from ``variant_index``, which by
    construction only ever contains already-priced variants -- see
    ``trajectory._load_category_prices``), this is sourced from
    ``products_metadata`` products whose ``product_id`` never appears in
    the panel at all, under ANY subtype. Requires ``products_metadata``;
    returns an empty set without it (no other source lists products that
    were never priced), consistent with the T3 brief's graceful-degradation
    clause.
    """

    category_id: int
    keys: tuple[tuple[int, str], ...]  # (product_id, COLD_START_DEFAULT_SUBTYPE)
    group_by_key: Mapping[tuple[int, str], int]
    rows: tuple[FeatureRow, ...]


def cold_start_candidates(
    panel_dir: Path,
    category_id: int,
    dates: Sequence[date],
    groups_metadata: Mapping[tuple[int, int], Mapping[str, object]],
    products_metadata: Mapping[tuple[int, int], Mapping[str, object]] | None,
    as_of: date,
) -> ColdStartFeatureSet:
    """Assemble hedonic ``FeatureRow``s for never-priced products.

    Feeds ``trajectory.process_category``'s ``cold_start_variants``
    parameter (via ``group_by_key``) together with hedonic predictions for
    ``keys`` (via ``hedonic_log_price``), so these products get real
    "cold-start" packets instead of the branch being structurally
    unreachable (see ``process_category``'s docstring for why: every
    ``variant_index`` entry already has >=1 price by construction).
    """

    if not products_metadata:
        return ColdStartFeatureSet(category_id=category_id, keys=(), group_by_key={}, rows=())

    variant_index, variant_group, prices = _load_category_prices(panel_dir, category_id, dates)
    priced_product_ids = {product_id for product_id, _subtype in variant_index}

    log_price: list[float] = [float("nan")] * len(variant_index)
    is_sealed: list[bool] = [False] * len(variant_index)
    for (priced_product_id, _subtype), idx in variant_index.items():
        found = last_known(prices[idx])
        if found is not None:
            _t, price = found
            log_price[idx] = log(price)
        # FA-04: kind of the (already-priced) variant itself, needed for
        # the sealed-only group median feature below -- products_metadata
        # is guaranteed non-empty here (see the early return above).
        priced_meta = products_metadata.get((category_id, priced_product_id))
        priced_kind = (
            product_kind(priced_meta.get("card_number"), priced_meta.get("rarity"))
            if priced_meta is not None else "unknown"
        )
        is_sealed[idx] = priced_kind == "sealed"
    group_counts: dict[int, int] = {}
    for g in variant_group:
        group_counts[g] = group_counts.get(g, 0) + 1
    group_wide_feature = _group_log_price_features(variant_group, log_price)
    group_median_by_group: dict[int, float] = {}
    for group_median, g in zip(group_wide_feature, variant_group):
        group_median_by_group.setdefault(g, group_median)
    group_sealed_feature = _group_sealed_log_price_features(
        variant_group, log_price, is_sealed, group_wide_feature,
    )
    group_sealed_median_by_group: dict[int, float] = {}
    for group_sealed_median, g in zip(group_sealed_feature, variant_group):
        group_sealed_median_by_group.setdefault(g, group_sealed_median)
    category_priced = [lp for lp in log_price if not isnan(lp)]
    category_fallback = median(category_priced) if category_priced else 0.0

    candidates = sorted(
        {
            (int(cat), int(pid)): meta
            for (cat, pid), meta in products_metadata.items()
            if cat == category_id and pid not in priced_product_ids
        }.items()
    )

    keys: list[tuple[int, str]] = []
    group_by_key: dict[tuple[int, str], int] = {}
    rows: list[FeatureRow] = []
    for (_cat, product_id), meta in candidates:
        group_id = int(meta.get("group_id", 0))
        group_meta = groups_metadata.get((category_id, group_id), {})
        group_name = group_meta.get("name")
        is_supplemental = bool((group_meta.get("metadata") or {}).get("isSupplemental", False))
        age = release_age_weeks(group_meta.get("published_on"), as_of)
        release_age = float(age) if age is not None else 0.0
        card_number = meta.get("card_number")
        rarity = meta.get("rarity")
        kind = product_kind(card_number, rarity)
        fmt = product_format(meta.get("name"), kind)
        scarcity = structural_scarcity_proxy(group_counts.get(group_id, 1))
        categorical = {
            "setFamily": set_family(str(group_name) if group_name else None, is_supplemental),
            "productKind": kind,
            "productFormat": fmt,
            "finish": COLD_START_DEFAULT_SUBTYPE,
            "rarity": rarity or "unknown",
        }
        continuous = {
            "releaseAgeWeeks": release_age,
            "groupLogPriceMedian": group_median_by_group.get(group_id, category_fallback),
            "groupSealedLogPriceMedian": group_sealed_median_by_group.get(group_id, category_fallback),
            "scarcityProxy": scarcity,
            "desirabilityProxy": release_age,
        }
        key = (product_id, COLD_START_DEFAULT_SUBTYPE)
        keys.append(key)
        group_by_key[key] = group_id
        rows.append(FeatureRow(group_id=group_id, categorical=categorical, continuous=continuous))

    return ColdStartFeatureSet(
        category_id=category_id, keys=tuple(keys), group_by_key=group_by_key, rows=tuple(rows),
    )
