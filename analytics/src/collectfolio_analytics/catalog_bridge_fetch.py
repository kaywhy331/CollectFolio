"""Resumable provider fetch layer for catalog-v2 B2 (provider <-> TCGCSV bridge).

Mirrors ``hedonic_features.py``'s ``load_or_fetch_products_metadata`` resumable
pattern (bounded per-call request budget, injectable ``fetch_json``/``sleep``
seams, atomic gzip cache writes, a ``truncated`` flag so callers know to
re-invoke) crossed with ``tcgcsv_panel_cli.py``'s plain, human-diffable
``state.json`` progress ledger (one entry per unit of work, persisted after
every unit so an interrupted run resumes without refetching completed
units). Python stdlib only -- ``urllib.request``, no third-party HTTP client.

Three providers, one per flagship category (see ``catalog_bridge.py``'s
``FLAGSHIP_PROVIDERS``):

  pokemon     api.pokemontcg.io  -- ``X-Api-Key`` header only if
              ``POKEMONTCG_API_KEY`` is set; unauthenticated works fine at a
              lower rate limit (graceful degradation, no hard dependency on
              a key).
  scryfall    api.scryfall.com   -- requires an identifying ``User-Agent``
              and ``Accept: application/json`` per Scryfall's API
              guidelines; their documented minimum delay is 50-100ms but
              this module uses the same >=1s default as the others
              (coordinator direction: "use 1s anyway").
  ygoprodeck  db.ygoprodeck.com  -- bulk-friendly: the sets list and the
              *entire* card catalog are each one HTTP request (no
              per-set pagination needed or wanted); per-set membership is
              derived from each card's own ``card_sets`` array.

Two units of work per provider, each independently resumable:

  sets   one cache entry, near-always a single request (provider set
         catalogs are small; pokemon/scryfall return every set in one
         page). Cached at ``<cache_dir>/<provider>/sets.json.gz``.
  cards  cached at ``<cache_dir>/<provider>/cards.json.gz``, resumed via
         ``<cache_dir>/<provider>/state.json``. For pokemon/scryfall the
         unit is one *matched* provider set id (card_bridge.py's set-level
         matcher already narrows the requested set id list down to sets
         TCGCSV actually has a candidate for -- there is no reason to ever
         fetch cards for a provider set with no possible TCGCSV match).
         For ygoprodeck the single "bulk" unit fetches every card in one
         request regardless of which set ids were requested.

Callers only need the identifiers ``catalog_bridge.match_products`` and the
app's lazy per-card provider fetch (``services/catalog-enrichment.js`` ->
``services/providers/{pokemon,scryfall,ygoprodeck}.js``) actually consume:
``id`` (kept in the exact ``externalId`` shape those app modules expect --
see each provider's normalizer below), ``name``, ``number``, ``rarity``,
``setId``. Nothing else from the raw provider payloads is retained, per the
same source-rights minimalism ``hedonic_features.py`` already documents for
its own products-metadata cache.
"""

from __future__ import annotations

import gzip
import json
import os
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Callable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class BridgeFetchError(RuntimeError):
    """Raised when a provider fetch cannot be completed or parsed."""


SUPPORTED_PROVIDERS: tuple[str, ...] = ("pokemon", "scryfall", "ygoprodeck")

#: Politeness delay between requests, applied uniformly across all three
#: providers (coordinator direction: pokemontcg.io/ygoprodeck have no
#: stated minimum, scryfall's documented minimum is 50-100ms -- use 1s
#: everywhere rather than tuning per provider).
DEFAULT_REQUEST_DELAY_SECONDS = 1.0
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_USER_AGENT = "CollectFolio/0.1 catalog-v2 bridge (community-free-access)"

#: Per-response size ceiling. ygoprodeck's bulk cardinfo.php call (the
#: entire card catalog, ~13k cards) is far larger than any single-set
#: response from the other two providers, so it gets its own, larger cap;
#: both are trivial against the lane's <=1.5GB RSS ceiling since the
#: payload is only ever held transiently, never accumulated across calls.
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_BULK_RESPONSE_BYTES = 48 * 1024 * 1024

#: Cards-per-set-request page size for the two paginated providers, and a
#: hard ceiling on pages fetched for any one set within a single unit of
#: work (a set this large would be a data anomaly, not a real TCG set --
#: this bound exists so one malformed/huge set can't turn a single unit of
#: resumable work into an unbounded fetch loop).
PAGE_SIZE = 250
MAX_PAGES_PER_SET = 8

FetchJson = Callable[[str, Mapping[str, str]], object]


def _default_fetch_json(url: str, headers: Mapping[str, str], *, timeout_seconds: float, max_bytes: int) -> object:
    request = Request(url, headers=dict(headers))
    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310
            payload = response.read(max_bytes + 1)
    except HTTPError as exc:
        raise BridgeFetchError(f"fetch failed for {url}: HTTP {exc.code}") from exc
    except URLError as exc:
        raise BridgeFetchError(f"fetch failed for {url}: {exc.reason}") from exc
    if len(payload) > max_bytes:
        raise BridgeFetchError(f"response for {url} exceeds its size limit")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BridgeFetchError(f"response for {url} is not valid JSON") from exc


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _content_sha256(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _read_cache(path: Path) -> object | None:
    if not path.is_file():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _write_cache_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".part")
    with gzip.open(tmp_path, "wt", encoding="utf-8") as handle:
        handle.write(_canonical_json(value))
    tmp_path.replace(path)


def _load_state(path: Path) -> dict:
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def _save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".part")
    tmp_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def _require_provider(provider: str) -> None:
    if provider not in SUPPORTED_PROVIDERS:
        raise BridgeFetchError(f"unsupported provider: {provider!r}")


@dataclass(frozen=True, slots=True)
class FetchResult:
    """Summary of one (possibly partial) fetch pass, for CLI receipts."""

    provider: str
    stage: str  # "sets" | "cards"
    units_requested: int
    units_already_cached: int
    units_fetched_this_call: int
    units_failed_this_call: int
    requests_made_this_call: int
    elapsed_seconds: float
    truncated: bool
    cache_content_hash: str
    record_count: int
    #: Units that completed with the API genuinely reporting zero cards
    #: (as opposed to a mismatched/error response silently treated as
    #: "0 cards, done" -- see ``_fetch_pokemon_set_cards``'s total-count
    #: consistency check). Surfaced separately from ``units_fetched_this_call``
    #: so an operator can spot a systemic zero-card bug in receipts instead
    #: of it hiding inside an otherwise-healthy-looking fetch pass.
    zero_card_units: int = 0


# ---------------------------------------------------------------------------
# Provider-specific endpoint construction + normalization
# ---------------------------------------------------------------------------


def _pokemon_headers(user_agent: str, api_key: str | None) -> dict[str, str]:
    headers = {"User-Agent": user_agent, "Accept": "application/json"}
    if api_key:
        headers["X-Api-Key"] = api_key
    return headers


def _normalize_pokemon_set(raw: Mapping[str, object]) -> dict[str, object]:
    return {
        "id": str(raw.get("id", "")),
        "name": str(raw.get("name", "")),
        "abbreviation": str(raw.get("ptcgoCode") or raw.get("id", "")),
        "releaseDate": str(raw.get("releaseDate", ""))[:10],
    }


def _normalize_pokemon_card(raw: Mapping[str, object], set_id: str) -> dict[str, object]:
    # externalId shape matches services/providers/pokemon.js's
    # normalizePokemonCard() (id used verbatim) -- so the app's
    # getPokemonCard(externalId) can look this id up directly.
    return {
        "id": str(raw.get("id", "")),
        "name": str(raw.get("name", "")),
        "number": str(raw.get("number", "")),
        "rarity": str(raw.get("rarity", "")),
        "setId": set_id,
    }


def _scryfall_headers(user_agent: str) -> dict[str, str]:
    return {"User-Agent": user_agent, "Accept": "application/json"}


def _normalize_scryfall_set(raw: Mapping[str, object]) -> dict[str, object]:
    return {
        "id": str(raw.get("code", "")),
        "name": str(raw.get("name", "")),
        "abbreviation": str(raw.get("code", "")),
        "releaseDate": str(raw.get("released_at", ""))[:10],
    }


def _normalize_scryfall_card(raw: Mapping[str, object], set_id: str) -> dict[str, object]:
    # externalId shape matches services/providers/scryfall.js's
    # normalizeScryfallCard() (card.id, a Scryfall UUID, used verbatim).
    return {
        "id": str(raw.get("id", "")),
        "name": str(raw.get("name", "")),
        "number": str(raw.get("collector_number", "")),
        "rarity": str(raw.get("rarity", "")),
        "setId": set_id,
    }


def _ygoprodeck_headers(user_agent: str) -> dict[str, str]:
    return {"User-Agent": user_agent, "Accept": "application/json"}


def _normalize_ygo_set(raw: Mapping[str, object]) -> dict[str, object]:
    code = str(raw.get("set_code", ""))
    return {
        "id": code or str(raw.get("set_name", "")),
        "name": str(raw.get("set_name", "")),
        "abbreviation": code,
        "releaseDate": str(raw.get("tcg_date", ""))[:10],
    }


def _ygo_set_id_from_printing_code(set_code: str) -> str:
    """Derive the base set id from a per-printing ``set_code``.

    A card's own ``card_sets[].set_code`` is the full per-printing code --
    ``"PSV-EN088"``, ``"2017-EN001"`` (set code + region infix + number) --
    which is a DIFFERENT id space from the provider's own set list
    (``_normalize_ygo_set``'s ``id``, sourced from cardsets.php's own
    ``set_code`` field: ``"PSV"``, ``"2017"``). Joining cards to sets by the
    full per-printing code (the pre-fix bug) essentially never matches the
    set list; splitting off everything before the first hyphen recovers the
    same base code the set list itself uses, making the join key identical
    on both sides. Set codes with no hyphen at all (rare) are left as-is.
    """

    return set_code.split("-", 1)[0] if set_code else ""


def _normalize_ygo_cards(raw_cards: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    # Every printing (card_sets entry) is its own bridgeable row, matching
    # services/providers/ygoprodeck.js's normalizeYGOCard(), which emits
    # one item per printing with externalId `${cardId}:${setCode}` -- the
    # exact id shape reproduced here so getYGOCard(externalId) resolves. A
    # card with no card_sets entries (tokens, some skill cards) contributes
    # no rows at all -- deliberately, rather than a single phantom row with
    # an empty setId, which is unjoinable to any set and only pollutes the
    # cache with un-bridgeable noise.
    records: list[dict[str, object]] = []
    for card in raw_cards:
        card_id = str(card.get("id", ""))
        printings = card.get("card_sets")
        if not isinstance(printings, list):
            continue
        for printing in printings:
            if not isinstance(printing, Mapping):
                continue
            set_code = str(printing.get("set_code", ""))
            set_id = _ygo_set_id_from_printing_code(set_code)
            if not set_id:
                continue
            records.append({
                "id": f"{card_id}:{set_code}" if set_code else card_id,
                "name": str(card.get("name", "")),
                "number": set_code,
                "rarity": str(printing.get("set_rarity", "")),
                "setId": set_id,
            })
    return records


# ---------------------------------------------------------------------------
# Sets fetch (one unit of work per provider)
# ---------------------------------------------------------------------------


def fetch_provider_sets(
    provider: str,
    cache_dir: Path,
    *,
    api_key: str | None = None,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    fetch_json: FetchJson | None = None,
    force_refresh: bool = False,
) -> tuple[list[dict[str, object]], FetchResult]:
    """Fetch (and durably cache) one provider's full set list.

    A provider's set catalog is small enough that this is always exactly
    one HTTP request (pokemon/scryfall each return every set in a single
    page; ygoprodeck's cardsets endpoint has no pagination at all) -- so
    unlike ``fetch_provider_cards`` below, this has no per-call request
    budget. It is still cached and force-refreshable so a caller building
    the same bridge table repeatedly does not needlessly re-hit the
    network.
    """

    _require_provider(provider)
    cache_dir = Path(cache_dir) / provider
    sets_path = cache_dir / "sets.json.gz"
    started = time.monotonic()

    cached = None if force_refresh else _read_cache(sets_path)
    if cached is not None:
        sets = cached.get("sets", [])
        return sets, FetchResult(
            provider=provider, stage="sets",
            units_requested=1, units_already_cached=1, units_fetched_this_call=0,
            units_failed_this_call=0, requests_made_this_call=0,
            elapsed_seconds=round(time.monotonic() - started, 3),
            cache_content_hash=_content_sha256(cached), record_count=len(sets), truncated=False,
        )

    fetcher = fetch_json or (lambda url, headers, max_bytes=MAX_RESPONSE_BYTES: _default_fetch_json(
        url, headers, timeout_seconds=timeout_seconds, max_bytes=max_bytes
    ))

    try:
        if provider == "pokemon":
            raw = fetcher("https://api.pokemontcg.io/v2/sets?pageSize=250", _pokemon_headers(user_agent, api_key))
            rows = raw.get("data", []) if isinstance(raw, Mapping) else []
            sets = [_normalize_pokemon_set(row) for row in rows if isinstance(row, Mapping)]
        elif provider == "scryfall":
            raw = fetcher("https://api.scryfall.com/sets", _scryfall_headers(user_agent))
            rows = raw.get("data", []) if isinstance(raw, Mapping) else []
            sets = [_normalize_scryfall_set(row) for row in rows if isinstance(row, Mapping)]
        else:  # ygoprodeck
            raw = fetcher("https://db.ygoprodeck.com/api/v7/cardsets.php", _ygoprodeck_headers(user_agent))
            rows = raw if isinstance(raw, list) else []
            sets = [_normalize_ygo_set(row) for row in rows if isinstance(row, Mapping)]
    except BridgeFetchError:
        elapsed = time.monotonic() - started
        return [], FetchResult(
            provider=provider, stage="sets",
            units_requested=1, units_already_cached=0, units_fetched_this_call=0,
            units_failed_this_call=1, requests_made_this_call=1,
            elapsed_seconds=round(elapsed, 3), cache_content_hash="", record_count=0, truncated=True,
        )

    payload_out = {"provider": provider, "sets": sorted(sets, key=lambda row: row["id"])}
    _write_cache_atomic(sets_path, payload_out)
    elapsed = time.monotonic() - started
    return payload_out["sets"], FetchResult(
        provider=provider, stage="sets",
        units_requested=1, units_already_cached=0, units_fetched_this_call=1,
        units_failed_this_call=0, requests_made_this_call=1,
        elapsed_seconds=round(elapsed, 3),
        cache_content_hash=_content_sha256(payload_out), record_count=len(payload_out["sets"]), truncated=False,
    )


# ---------------------------------------------------------------------------
# Cards fetch (resumable, one unit of work per matched provider set id --
# or a single "bulk" unit for ygoprodeck)
# ---------------------------------------------------------------------------


def _fetch_pokemon_set_cards(fetcher: FetchJson, headers: Mapping[str, str], set_id: str) -> list[dict[str, object]]:
    """Fetch every card in one pokemontcg.io set, paginating past 250.

    pokemontcg.io's error responses (rate-limit throttling, bad query, etc.)
    are frequently still HTTP 200 with an ``{"error": {...}}`` body and no
    ``"data"`` key at all -- ``raw.get("data", [])`` would silently read
    that as "zero cards, page complete" and let the caller mark the whole
    set unit ``"completed"`` with zero cards fetched (the root cause of the
    ~106 matched-but-empty pokemon sets in the coverage report). Both
    checks below turn that failure mode into a raised
    ``BridgeFetchError`` instead, so the unit is recorded ``"failed"`` and
    retried on the next resumable pass rather than silently "completed".
    """

    cards: list[dict[str, object]] = []
    expected_total: int | None = None
    page = 1
    while page <= MAX_PAGES_PER_SET:
        query = urlencode({"q": f"set.id:{set_id}", "page": page, "pageSize": PAGE_SIZE})
        raw = fetcher(f"https://api.pokemontcg.io/v2/cards?{query}", headers)
        if not isinstance(raw, Mapping) or "data" not in raw:
            raise BridgeFetchError(f"cards response for pokemon set {set_id} page {page} is missing its data envelope")
        rows = raw.get("data", [])
        if not isinstance(rows, list):
            raise BridgeFetchError(f"cards response for pokemon set {set_id} page {page} has a non-list data field")
        if page == 1:
            total_count = raw.get("totalCount")
            if isinstance(total_count, int):
                expected_total = total_count
        cards.extend(_normalize_pokemon_card(row, set_id) for row in rows if isinstance(row, Mapping))
        if len(rows) < PAGE_SIZE:
            break
        page += 1
    if expected_total is not None and len(cards) != expected_total:
        raise BridgeFetchError(
            f"cards response for pokemon set {set_id} fetched {len(cards)} cards but the API reported totalCount={expected_total}"
        )
    return cards


def _fetch_scryfall_set_cards(fetcher: FetchJson, headers: Mapping[str, str], set_id: str) -> list[dict[str, object]]:
    cards: list[dict[str, object]] = []
    query = urlencode({"q": f"set:{set_id}", "order": "set", "unique": "prints"})
    url: str | None = f"https://api.scryfall.com/cards/search?{query}"
    pages = 0
    while url and pages < MAX_PAGES_PER_SET:
        raw = fetcher(url, headers)
        pages += 1
        if not isinstance(raw, Mapping):
            break
        rows = raw.get("data", [])
        cards.extend(_normalize_scryfall_card(row, set_id) for row in rows if isinstance(row, Mapping))
        url = raw.get("next_page") if raw.get("has_more") else None
    return cards


def fetch_provider_cards(
    provider: str,
    cache_dir: Path,
    provider_set_ids: Sequence[str],
    *,
    max_requests: int = 500,
    request_delay_seconds: float = DEFAULT_REQUEST_DELAY_SECONDS,
    api_key: str | None = None,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    fetch_json: FetchJson | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[list[dict[str, object]], FetchResult]:
    """Resumably fetch provider cards for the given (matched) set ids.

    ``provider_set_ids`` should already be narrowed to sets
    ``catalog_bridge.match_sets`` actually matched to a TCGCSV group --
    fetching cards for a provider set with no possible TCGCSV counterpart
    would be a wasted, impolite request. ygoprodeck ignores
    ``provider_set_ids`` entirely: its one "bulk" unit fetches every card
    in a single request and per-set membership falls out of each card's
    own ``card_sets`` array (community-free-access etiquette: pulling one
    ~13k-card payload once is far more polite than ~13k individual
    per-set-membership lookups).

    Units already recorded ``"completed"`` in ``<cache_dir>/<provider>/
    state.json`` are skipped without a network call. At most
    ``max_requests`` new HTTP requests are made this call; if units remain
    afterward, the returned ``FetchResult.truncated`` is ``True`` and the
    caller (or the CLI) should simply invoke this again to continue.
    """

    _require_provider(provider)
    provider_dir = Path(cache_dir) / provider
    cards_path = provider_dir / "cards.json.gz"
    state_path = provider_dir / "state.json"

    state = _load_state(state_path)
    units_state: dict = state.setdefault("cardUnits", {})

    cached_cards = _read_cache(cards_path)
    by_set: dict[str, list[dict[str, object]]] = {}
    if cached_cards is not None:
        for row in cached_cards.get("cards", []):
            by_set.setdefault(str(row["setId"]), []).append(row)

    fetcher = fetch_json or (lambda url, headers, max_bytes=MAX_RESPONSE_BYTES: _default_fetch_json(
        url, headers, timeout_seconds=timeout_seconds, max_bytes=max_bytes
    ))

    started = time.monotonic()
    requests_made = 0
    fetched_this_call = 0
    failed_this_call = 0
    zero_card_units = 0
    truncated = False

    if provider == "ygoprodeck":
        units_requested = 1
        already_cached = 1 if units_state.get("bulk", {}).get("status") == "completed" else 0
        if already_cached == 0:
            if requests_made >= max_requests:
                truncated = True
            else:
                try:
                    raw = fetcher(
                        "https://db.ygoprodeck.com/api/v7/cardinfo.php",
                        _ygoprodeck_headers(user_agent),
                        MAX_BULK_RESPONSE_BYTES,
                    )
                    requests_made += 1
                    rows = raw.get("data", []) if isinstance(raw, Mapping) else []
                    exploded = _normalize_ygo_cards([row for row in rows if isinstance(row, Mapping)])
                    for record in exploded:
                        by_set.setdefault(record["setId"], []).append(record)
                    units_state["bulk"] = {"status": "completed", "cardCount": len(exploded)}
                    fetched_this_call += 1
                    if not exploded:
                        zero_card_units += 1
                except BridgeFetchError as exc:
                    requests_made += 1
                    units_state["bulk"] = {"status": "failed", "error": str(exc)}
                    failed_this_call += 1
    else:
        requested = list(dict.fromkeys(str(set_id) for set_id in provider_set_ids))
        units_requested = len(requested)
        already_cached = sum(1 for set_id in requested if units_state.get(set_id, {}).get("status") == "completed")
        remaining = [set_id for set_id in requested if units_state.get(set_id, {}).get("status") != "completed"]
        headers = _pokemon_headers(user_agent, api_key) if provider == "pokemon" else _scryfall_headers(user_agent)
        set_fetcher = _fetch_pokemon_set_cards if provider == "pokemon" else _fetch_scryfall_set_cards

        for idx, set_id in enumerate(remaining):
            if requests_made >= max_requests:
                truncated = True
                break
            try:
                cards = set_fetcher(fetcher, headers, set_id)
                requests_made += 1
                by_set[set_id] = cards
                units_state[set_id] = {"status": "completed", "cardCount": len(cards)}
                fetched_this_call += 1
                if not cards:
                    zero_card_units += 1
            except BridgeFetchError as exc:
                requests_made += 1
                units_state[set_id] = {"status": "failed", "error": str(exc)}
                failed_this_call += 1
            if idx + 1 < len(remaining):
                sleep(request_delay_seconds)

    all_cards = [row for rows in by_set.values() for row in rows]
    all_cards.sort(key=lambda row: (str(row["setId"]), str(row["id"])))
    payload_out = {"provider": provider, "cards": all_cards}
    _write_cache_atomic(cards_path, payload_out)
    _save_state(state_path, state)

    elapsed = time.monotonic() - started
    return all_cards, FetchResult(
        provider=provider, stage="cards",
        units_requested=units_requested, units_already_cached=already_cached,
        units_fetched_this_call=fetched_this_call, units_failed_this_call=failed_this_call,
        requests_made_this_call=requests_made, elapsed_seconds=round(elapsed, 3),
        truncated=truncated, cache_content_hash=_content_sha256(payload_out), record_count=len(all_cards),
        zero_card_units=zero_card_units,
    )


def pokemontcg_api_key_from_env() -> str | None:
    """Optional ``X-Api-Key``; unauthenticated pokemontcg.io calls still work."""

    return os.environ.get("POKEMONTCG_API_KEY") or None
