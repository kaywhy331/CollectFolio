"""Bounded live verification for checked-in TCGplayer article snapshots."""

from __future__ import annotations

from hashlib import sha256
import json
import time
from typing import Callable, Mapping
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

ARTICLE_API_ORIGIN = "https://infinite-api.tcgplayer.com"
MAX_ARTICLE_BYTES = 2_000_000
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_article(article_id: str) -> Mapping[str, object]:
    """Fetch one public article JSON document without following redirects."""

    UUID(article_id)
    url = f"{ARTICLE_API_ORIGIN}/content/article/{article_id}/"
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "CollectFolioPullRateVerifier/1.0",
        },
    )
    opener = build_opener(_NoRedirect)
    for attempt, delay in enumerate((0.0, 0.5, 1.0, 2.0)):
        if delay:
            time.sleep(delay)
        try:
            with opener.open(request, timeout=20) as response:
                final = urlsplit(response.geturl())
                if final.scheme != "https" or final.netloc != "infinite-api.tcgplayer.com":
                    raise ValueError("article API response escaped the fixed HTTPS origin")
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > MAX_ARTICLE_BYTES:
                    raise ValueError("article API response exceeds the size bound")
                body = response.read(MAX_ARTICLE_BYTES + 1)
                if len(body) > MAX_ARTICLE_BYTES:
                    raise ValueError("article API response exceeds the size bound")
                payload = json.loads(body)
                article = payload.get("result", {}).get("article")
                if not isinstance(article, Mapping):
                    raise ValueError("article API response is missing result.article")
                return article
        except HTTPError as exc:
            if exc.code not in RETRYABLE_STATUS or attempt == 3:
                raise
    raise RuntimeError("article verification retries exhausted")


def verify_manifest_source_snapshots(
    manifest: Mapping[str, object],
    *,
    fetcher: Callable[[str], Mapping[str, object]] = fetch_article,
) -> tuple[str, ...]:
    """Require every live article body and immutable identity to match."""

    studies = manifest.get("studies")
    if not isinstance(studies, list) or not studies:
        raise ValueError("manifest studies must be a non-empty array")
    verified: list[str] = []
    for study in studies:
        if not isinstance(study, Mapping) or not isinstance(study.get("source"), Mapping):
            raise ValueError("every study must contain a source object")
        source = study["source"]
        article_id = str(source.get("article_id") or "")
        UUID(article_id)
        article = fetcher(article_id)
        if str(article.get("uuid") or "") != article_id:
            raise ValueError(f"live article UUID mismatch for {article_id}")
        if str(article.get("title") or "") != str(source.get("title") or ""):
            raise ValueError(f"live article title mismatch for {article_id}")
        published_at = str(article.get("dateTime") or "")[:10]
        if published_at != str(source.get("published_at") or ""):
            raise ValueError(f"live article publication date mismatch for {article_id}")
        if str(article.get("updatedTime") or "") != str(source.get("article_updated_at") or ""):
            raise ValueError(f"live article updated_at mismatch for {article_id}")
        body = article.get("body")
        if not isinstance(body, str):
            raise ValueError(f"live article body is missing for {article_id}")
        digest = sha256(body.encode("utf-8")).hexdigest()
        if digest != str(source.get("article_body_sha256") or ""):
            raise ValueError(f"live article body hash mismatch for {article_id}")
        verified.append(article_id)
    return tuple(verified)
