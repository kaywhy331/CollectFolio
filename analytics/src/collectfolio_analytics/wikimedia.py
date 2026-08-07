"""Bounded Wikimedia per-article pageview ingestion (PRD Sec 15.7).

Wikimedia pageview counts are an external character-interest proxy with open
licensing, but the Analytics API access policy still requires an identifying
User-Agent with a contact route, and the point-in-time contract still
applies: every observation is stamped ``available_at`` with the actual
retrieval instant, never the historical view date, so a backfill can never
masquerade as data CollectFolio possessed earlier (walk-forward Sec 25.1).

Character-to-article identity is an operator-curated mapping input — this
module never guesses which Wikipedia article a Pokémon character corresponds
to, mirroring the "exact mapping is mandatory" rule for price sources.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from hashlib import sha256
import json
from typing import Callable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

API_ORIGIN = "https://wikimedia.org/api/rest_v1"
MAX_ARTICLES_PER_RUN = 50
MAX_WINDOW_DAYS = 400
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
ALLOWED_PROJECTS = ("en.wikipedia.org",)


class WikimediaPayloadError(ValueError):
    """The Wikimedia response violated this module's bounded contract."""


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D102 - fixed origin only
        raise WikimediaPayloadError("Wikimedia requests must not redirect")


@dataclass(frozen=True, slots=True)
class CharacterPageMapping:
    """Operator-curated identity: which article proxies which character."""

    character_key: str
    article: str
    project: str = "en.wikipedia.org"

    def __post_init__(self) -> None:
        if not str(self.character_key or "").strip():
            raise ValueError("character_key is required")
        if not str(self.article or "").strip():
            raise ValueError("article is required")
        if self.project not in ALLOWED_PROJECTS:
            raise ValueError(f"project must be one of {ALLOWED_PROJECTS}")


@dataclass(frozen=True, slots=True)
class PageviewObservation:
    character_key: str
    project: str
    article: str
    view_date: date
    views: int
    access: str
    agent: str
    available_at: datetime

    def database_row(self) -> dict[str, object]:
        return {
            "character_key": self.character_key,
            "project": self.project,
            "article": self.article,
            "view_date": self.view_date.isoformat(),
            "views": self.views,
            "access": self.access,
            "agent": self.agent,
            "available_at": self.available_at.isoformat(),
        }


def validate_user_agent(user_agent: str) -> str:
    """The access policy requires an identifying UA with a contact route."""

    value = str(user_agent or "").strip()
    if len(value) < 10 or ("@" not in value and "http" not in value):
        raise ValueError(
            "user_agent must identify CollectFolio and include a contact route "
            "(an email address or URL) per the Wikimedia access policy"
        )
    return value


def pageview_url(mapping: CharacterPageMapping, start: date, end: date) -> str:
    article = quote(mapping.article.replace(" ", "_"), safe="")
    return (
        f"{API_ORIGIN}/metrics/pageviews/per-article/{mapping.project}"
        f"/all-access/user/{article}/daily/{start.strftime('%Y%m%d')}/{end.strftime('%Y%m%d')}"
    )


def _default_fetch_json(url: str, headers: Mapping[str, str], *, timeout_seconds: float) -> object:
    request = Request(url, headers=dict(headers))
    opener = build_opener(_RejectRedirects())
    try:
        with opener.open(request, timeout=timeout_seconds) as response:  # noqa: S310 - fixed HTTPS origin
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        raise WikimediaPayloadError(f"Wikimedia request failed ({exc.code})") from exc
    except (URLError, TimeoutError) as exc:
        raise WikimediaPayloadError("Wikimedia request failed") from exc
    if len(payload) > MAX_RESPONSE_BYTES:
        raise WikimediaPayloadError("Wikimedia response exceeds the configured size limit")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WikimediaPayloadError("Wikimedia response is not valid JSON") from exc


def _parse_items(
    mapping: CharacterPageMapping,
    payload: object,
    start: date,
    end: date,
    available_at: datetime,
) -> tuple[PageviewObservation, ...]:
    if not isinstance(payload, Mapping) or not isinstance(payload.get("items"), list):
        raise WikimediaPayloadError("Wikimedia payload must contain an items array")
    observations = []
    seen_dates: set[date] = set()
    expected_article = mapping.article.replace(" ", "_")
    for item in payload["items"]:
        if not isinstance(item, Mapping):
            raise WikimediaPayloadError("Wikimedia item must be an object")
        if str(item.get("article")) != expected_article:
            raise WikimediaPayloadError("Wikimedia item article does not match the requested mapping")
        timestamp = str(item.get("timestamp") or "")
        try:
            view_date = datetime.strptime(timestamp[:8], "%Y%m%d").date()
        except ValueError as exc:
            raise WikimediaPayloadError(f"Wikimedia timestamp {timestamp!r} is invalid") from exc
        if not start <= view_date <= end:
            raise WikimediaPayloadError("Wikimedia item falls outside the requested window")
        if view_date in seen_dates:
            raise WikimediaPayloadError("Wikimedia items must not repeat a view date")
        seen_dates.add(view_date)
        views = item.get("views")
        if isinstance(views, bool) or not isinstance(views, int) or views < 0:
            raise WikimediaPayloadError("Wikimedia views must be a non-negative integer")
        observations.append(PageviewObservation(
            character_key=mapping.character_key,
            project=mapping.project,
            article=expected_article,
            view_date=view_date,
            views=views,
            access=str(item.get("access") or "all-access"),
            agent=str(item.get("agent") or "user"),
            available_at=available_at,
        ))
    return tuple(sorted(observations, key=lambda entry: entry.view_date))


def fetch_daily_pageviews(
    mappings: Sequence[CharacterPageMapping],
    start: date,
    end: date,
    *,
    user_agent: str,
    retrieved_at: datetime,
    fetch_json: Callable[..., object] = _default_fetch_json,
    timeout_seconds: float = 30.0,
) -> dict[str, object]:
    """Fetches bounded daily pageviews for every curated mapping.

    Fails closed on any contract violation rather than skipping entries, so a
    partial or malformed run can never silently thin the demand signal.
    """

    if not mappings:
        raise ValueError("at least one character mapping is required")
    if len(mappings) > MAX_ARTICLES_PER_RUN:
        raise ValueError(f"at most {MAX_ARTICLES_PER_RUN} articles may be fetched per run")
    if any(not isinstance(entry, CharacterPageMapping) for entry in mappings):
        raise ValueError("mappings must contain CharacterPageMapping values")
    if len({(entry.project, entry.article) for entry in mappings}) != len(mappings):
        raise ValueError("mappings must not repeat a project/article pair")
    if not isinstance(start, date) or not isinstance(end, date) or end < start:
        raise ValueError("start and end must be dates with end >= start")
    if (end - start).days > MAX_WINDOW_DAYS:
        raise ValueError(f"the requested window may span at most {MAX_WINDOW_DAYS} days")
    if not isinstance(retrieved_at, datetime) or retrieved_at.tzinfo is None:
        raise ValueError("retrieved_at must be timezone-aware")
    agent = validate_user_agent(user_agent)

    available_at = retrieved_at.astimezone(timezone.utc)
    headers = {"User-Agent": agent, "Api-User-Agent": agent, "Accept": "application/json"}
    observations: list[PageviewObservation] = []
    for mapping in mappings:
        payload = fetch_json(pageview_url(mapping, start, end), headers, timeout_seconds=timeout_seconds)
        observations.extend(_parse_items(mapping, payload, start, end, available_at))

    rows = [entry.database_row() for entry in observations]
    return {
        "mode": "wikimedia_pageview_ingest",
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "retrieved_at": available_at.isoformat(),
        "counts": {"articles": len(mappings), "observations": len(rows)},
        "observations": rows,
        "packet_hash": sha256(
            json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }
