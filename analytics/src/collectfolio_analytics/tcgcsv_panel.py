"""Resumable weekly TCGCSV archive panel builder (trajectory-v1 PRD §3/T1).

Downloads each scoped archive date from ``tcgcsv.com`` exactly once, expands
it with a single ``7z`` pass, and streams every requested category's price
members into compact per-category/per-date JSONL panels under
``analytics/data/panel/``. Panel rows carry the archive date as observed
time and archive date + 1 day as a conservative available time, matching
``historical_import.py``'s ``archive_release`` point-in-time semantics.

This module intentionally does not depend on ``tcgcsv_universe.py``'s
private-market/SQL pipeline: it is a small, dependency-free (stdlib only)
panel builder scoped to the trajectory-v1 forecasting inputs. It reuses the
same download/extract *patterns* as ``tcgcsv.py`` and ``tcgcsv_universe.py``
(bounded fetch, injectable fetch/extract seams for tests, full single-pass
``7z x`` expansion, path-escape guards) without importing their private
helpers directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from hashlib import sha256
from math import isfinite
from pathlib import Path
from typing import Callable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen
import gzip
import json
import shutil
import subprocess
import tempfile


DEFAULT_BASE_URL = "https://tcgcsv.com/"
DEFAULT_USER_AGENT = "CollectFolio/0.1 trajectory-v1 panel builder (community-free-access)"

PANEL_CONTRACT_VERSION = "tcgcsv-panel-v1"

#: Card categories in scope for trajectory-v1 (Magic, YuGiOh, Pokemon, Pokemon Japan).
DEFAULT_CATEGORY_IDS = (1, 2, 3, 85)

#: Preferred-price fallback order, matching app/assets/js/services/providers/tcgcsv.js
#: PRICE_FIELDS so the panel's canonical "price" always agrees with the app's own
#: preference order.
PRICE_FIELDS = ("marketPrice", "midPrice", "lowPrice", "directLowPrice", "highPrice")

ARCHIVE_INTERVAL_DAYS = 7
AVAILABILITY_LAG_DAYS = 1

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_FILES = 20_000
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 16 * 1024 * 1024
DEFAULT_MIN_FREE_BYTES = 300 * 1024 * 1024


class TCGCSVPanelError(ValueError):
    """Raised when an archive date cannot satisfy the panel contract."""


class TCGCSVPanelUnavailable(TCGCSVPanelError):
    """Raised when the source has no archive published for a requested date."""


def _archive_day(value: date) -> date:
    if isinstance(value, datetime) or not isinstance(value, date):
        raise ValueError("archive_date must be a date value")
    return value


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a positive integer")
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if parsed <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return parsed


def _archive_url(base_url: str, archive_date: date) -> str:
    base = base_url.rstrip("/") + "/"
    url = urljoin(base, f"archive/tcgplayer/prices-{archive_date.isoformat()}.ppmd.7z")
    if not url.startswith(base):
        raise ValueError("TCGCSV archive path escaped the configured origin")
    return url


def plan_weekly_dates(
    start_date: date,
    *,
    count: int | None = None,
    end_date: date | None = None,
    interval_days: int = ARCHIVE_INTERVAL_DAYS,
) -> tuple[date, ...]:
    """Return a bounded, exact-interval sequence of archive dates.

    Exactly one of ``count`` or ``end_date`` must be given. ``end_date`` must
    align to an exact multiple of ``interval_days`` after ``start_date``,
    matching the fixed-weekday sampling the archive history contract expects.
    """

    start = _archive_day(start_date)
    if interval_days <= 0:
        raise ValueError("interval_days must be positive")
    if (count is None) == (end_date is None):
        raise ValueError("exactly one of count or end_date is required")
    if count is not None:
        if count <= 0:
            raise ValueError("count must be positive")
        steps = count
    else:
        end = _archive_day(end_date)
        span_days = (end - start).days
        if span_days < 0:
            raise ValueError("end_date must not precede start_date")
        if span_days % interval_days:
            raise ValueError("date range must align to an exact interval")
        steps = span_days // interval_days + 1
    return tuple(start + timedelta(days=index * interval_days) for index in range(steps))


def observed_at(archive_date: date) -> datetime:
    return datetime.combine(_archive_day(archive_date), time.min, tzinfo=timezone.utc)


def available_at(archive_date: date) -> datetime:
    return observed_at(archive_date) + timedelta(days=AVAILABILITY_LAG_DAYS)


def ensure_free_disk(path: Path, minimum_bytes: int) -> int:
    """Fail closed before a download/extract step if free disk is too low."""

    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(path)
    if usage.free < minimum_bytes:
        raise TCGCSVPanelError(
            f"only {usage.free} bytes free at {path}; refusing to continue below the "
            f"{minimum_bytes} byte safety floor"
        )
    return usage.free


# --------------------------------------------------------------------------
# Download seam
# --------------------------------------------------------------------------


def _default_fetch_archive_bytes(
    url: str,
    *,
    timeout_seconds: float,
    user_agent: str,
    max_bytes: int,
) -> bytes:
    request = Request(url, headers={"User-Agent": user_agent, "Accept": "application/octet-stream"})
    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310 - fixed HTTPS origin
            declared = response.headers.get("Content-Length")
            if declared:
                try:
                    if int(declared) > max_bytes:
                        raise TCGCSVPanelError("archive response exceeds the configured size limit")
                except ValueError as exc:
                    raise TCGCSVPanelError("archive response has an invalid size") from exc
            payload = response.read(max_bytes + 1)
    except HTTPError as exc:
        if exc.code == 404:
            raise TCGCSVPanelUnavailable(
                f"no archive published for this date (HTTP 404): {url}"
            ) from exc
        raise TCGCSVPanelError(f"archive request failed: HTTP {exc.code}") from exc
    except URLError as exc:
        raise TCGCSVPanelError(f"archive request failed: {exc.reason}") from exc
    if len(payload) > max_bytes:
        raise TCGCSVPanelError("archive response exceeds the configured size limit")
    return payload


def _default_head(url: str, *, timeout_seconds: float, user_agent: str) -> tuple[int, int | None]:
    request = Request(url, headers={"User-Agent": user_agent}, method="HEAD")
    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310 - fixed HTTPS origin
            declared = response.headers.get("Content-Length")
            length = int(declared) if declared else None
            return int(response.status), length
    except HTTPError as exc:
        return exc.code, None
    except URLError as exc:
        raise TCGCSVPanelError(f"probe request failed: {exc.reason}") from exc


@dataclass(frozen=True, slots=True)
class ArchiveProbe:
    archive_date: date
    url: str
    available: bool
    status_code: int | None
    content_length_bytes: int | None

    def as_dict(self) -> dict[str, object]:
        return {
            "archiveDate": self.archive_date.isoformat(),
            "url": self.url,
            "available": self.available,
            "statusCode": self.status_code,
            "contentLengthBytes": self.content_length_bytes,
        }


def probe_archive_date(
    archive_date: date,
    *,
    base_url: str = DEFAULT_BASE_URL,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout_seconds: float = 20.0,
    head: Callable[[str], tuple[int, int | None]] | None = None,
) -> ArchiveProbe:
    """Bounded HEAD probe of one archive date; never downloads the body."""

    day = _archive_day(archive_date)
    url = _archive_url(base_url, day)
    if head is not None:
        status_code, content_length = head(url)
    else:
        status_code, content_length = _default_head(
            url, timeout_seconds=timeout_seconds, user_agent=user_agent
        )
    return ArchiveProbe(
        archive_date=day,
        url=url,
        available=status_code == 200,
        status_code=status_code,
        content_length_bytes=content_length,
    )


# --------------------------------------------------------------------------
# Extraction seam (single 7z pass; full expansion, then filesystem filtering)
# --------------------------------------------------------------------------


def _default_extract_archive(archive_bytes: bytes, dest_dir: Path, *, timeout_seconds: float) -> None:
    executable = shutil.which("7z")
    if not executable:
        raise TCGCSVPanelError("7z is required to expand TCGCSV PPMd archives")
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix="collectfolio-tcgcsv-panel-", suffix=".7z") as handle:
        handle.write(archive_bytes)
        handle.flush()
        try:
            result = subprocess.run(  # noqa: S603 - fixed executable and local paths
                [executable, "x", "-bd", "-y", f"-o{dest_dir}", handle.name],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise TCGCSVPanelError("7z extraction timed out") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
        raise TCGCSVPanelError(f"7z extraction failed: {detail[-500:]}")
    resolved_dest = dest_dir.resolve()
    file_count = 0
    expanded_bytes = 0
    for member in dest_dir.rglob("*"):
        if member.is_symlink():
            raise TCGCSVPanelError("archive extraction produced a symlink")
        if not member.is_file():
            continue
        if not member.resolve().is_relative_to(resolved_dest):
            raise TCGCSVPanelError("archive extraction escaped its destination directory")
        file_count += 1
        expanded_bytes += member.stat().st_size
    if file_count == 0:
        raise TCGCSVPanelError("archive extraction produced no files")
    if file_count > MAX_EXPANDED_FILES:
        raise TCGCSVPanelError("archive extraction exceeds the configured file-count limit")
    if expanded_bytes > MAX_EXPANDED_BYTES:
        raise TCGCSVPanelError("archive extraction exceeds the configured size limit")


# --------------------------------------------------------------------------
# Row parsing
# --------------------------------------------------------------------------


def _price_row(group_id: int, item: Mapping[str, object]) -> tuple[dict[str, object] | None, str | None]:
    """Parse one raw archive price entry into a panel row, or a reject reason."""

    if not isinstance(item, Mapping):
        return None, "invalid_row_shape"
    try:
        product_id = _positive_int(item.get("productId"), "productId")
    except ValueError:
        return None, "invalid_product_id"
    subtype = str(item.get("subTypeName") or "").strip()
    if not subtype:
        return None, "missing_subtype_name"
    if len(subtype) > 200:
        return None, "subtype_name_too_long"
    values: dict[str, float] = {}
    for field_name in PRICE_FIELDS:
        raw_value = item.get(field_name)
        if raw_value is None:
            continue
        if isinstance(raw_value, bool):
            return None, f"invalid_{field_name}"
        try:
            parsed_value = float(raw_value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None, f"invalid_{field_name}"
        if not isfinite(parsed_value) or parsed_value < 0:
            return None, f"invalid_{field_name}"
        values[field_name] = round(parsed_value, 4)
    if not values:
        return None, "no_price_data"
    preferred_field = next(name for name in PRICE_FIELDS if name in values)
    row: dict[str, object] = {
        "groupId": group_id,
        "productId": product_id,
        "subTypeName": subtype,
        "price": values[preferred_field],
        "priceField": preferred_field,
    }
    row.update(values)
    return row, None


@dataclass(frozen=True, slots=True)
class GroupPanelResult:
    category_id: int
    group_id: int
    member_path: str
    member_sha256: str
    member_bytes: int
    row_count: int
    reject_count: int


def _write_panel_rows(
    extracted_root: Path,
    archive_date: date,
    category_ids: Sequence[int],
    panel_dir: Path,
) -> tuple[tuple[GroupPanelResult, ...], dict[str, int], tuple[int, ...]]:
    """Stream every scoped member's rows into one gzip JSONL file per category.

    Returns ``(group_results, reject_counts, missing_category_ids)``.
    """

    root = Path(extracted_root).resolve()
    base = root / archive_date.isoformat()
    if not base.is_dir():
        raise TCGCSVPanelError("archive extraction lacks its dated root directory")
    base = base.resolve()
    requested = tuple(sorted({_positive_int(c, "category_id") for c in category_ids}))
    panel_dir = Path(panel_dir)

    group_results: list[GroupPanelResult] = []
    reject_counts: dict[str, int] = {}
    discovered: set[int] = set()
    writers: dict[int, gzip.GzipFile] = {}
    tmp_paths: dict[int, Path] = {}
    final_paths: dict[int, Path] = {}

    def _bump(reason: str) -> None:
        reject_counts[reason] = reject_counts.get(reason, 0) + 1

    try:
        for member in sorted(base.glob("*/*/prices"), key=lambda item: item.as_posix()):
            if member.is_symlink() or not member.is_file():
                raise TCGCSVPanelError("archive member escaped the extraction root")
            if not member.resolve().is_relative_to(base):
                raise TCGCSVPanelError("archive member escaped the extraction root")
            try:
                category_id = _positive_int(member.parent.parent.name, "archive category")
                group_id = _positive_int(member.parent.name, "archive group")
            except ValueError:
                continue
            if category_id not in requested:
                continue
            discovered.add(category_id)
            member_relpath = member.relative_to(root).as_posix()
            payload = member.read_bytes()
            if not payload or len(payload) > MAX_MEMBER_BYTES:
                _bump("invalid_member_size")
                group_results.append(GroupPanelResult(
                    category_id, group_id, member_relpath,
                    sha256(payload).hexdigest() if payload else "", len(payload), 0, 1,
                ))
                continue
            try:
                parsed = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                _bump("invalid_member_json")
                group_results.append(GroupPanelResult(
                    category_id, group_id, member_relpath,
                    sha256(payload).hexdigest(), len(payload), 0, 1,
                ))
                continue
            if (
                not isinstance(parsed, Mapping)
                or parsed.get("success") is not True
                or not isinstance(parsed.get("results"), list)
            ):
                _bump("invalid_member_payload")
                group_results.append(GroupPanelResult(
                    category_id, group_id, member_relpath,
                    sha256(payload).hexdigest(), len(payload), 0, 1,
                ))
                continue

            seen: set[tuple[int, str]] = set()
            rows: list[dict[str, object]] = []
            member_rejects = 0
            for item in parsed["results"]:
                row, reason = _price_row(group_id, item)
                if reason is not None:
                    member_rejects += 1
                    _bump(reason)
                    continue
                identity = (row["productId"], row["subTypeName"])
                if identity in seen:
                    member_rejects += 1
                    _bump("duplicate_series")
                    continue
                seen.add(identity)
                rows.append(row)
            rows.sort(key=lambda item: (item["productId"], item["subTypeName"]))

            if category_id not in writers:
                category_dir = panel_dir / f"category-{category_id}"
                category_dir.mkdir(parents=True, exist_ok=True)
                final_path = category_dir / f"{archive_date.isoformat()}.jsonl.gz"
                tmp_path = category_dir / f"{archive_date.isoformat()}.jsonl.gz.part"
                writers[category_id] = gzip.open(tmp_path, "wb", compresslevel=6)
                tmp_paths[category_id] = tmp_path
                final_paths[category_id] = final_path
            handle = writers[category_id]
            for row in rows:
                line = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                handle.write((line + "\n").encode("utf-8"))

            group_results.append(GroupPanelResult(
                category_id, group_id, member_relpath, sha256(payload).hexdigest(),
                len(payload), len(rows), member_rejects,
            ))

        for handle in writers.values():
            handle.close()
        for category_id, tmp_path in tmp_paths.items():
            tmp_path.replace(final_paths[category_id])
    except BaseException:
        for handle in writers.values():
            try:
                handle.close()
            except OSError:
                pass
        for tmp_path in tmp_paths.values():
            tmp_path.unlink(missing_ok=True)
        raise

    missing = tuple(sorted(requested_id for requested_id in requested if requested_id not in discovered))
    if missing and len(missing) == len(requested):
        raise TCGCSVPanelError(
            f"none of the requested categories were found in the {archive_date.isoformat()} archive"
        )
    return tuple(group_results), reject_counts, missing


# --------------------------------------------------------------------------
# Per-date orchestration
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ArchiveDateReceipt:
    archive_date: date
    archive_sha256: str
    archive_bytes: int
    members_digest: str
    scoped_expanded_bytes: int
    categories: Mapping[int, Mapping[str, int]]
    reject_counts: Mapping[str, int]
    missing_category_ids: tuple[int, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "archiveDate": self.archive_date.isoformat(),
            "observedAt": observed_at(self.archive_date).isoformat(),
            "availableAt": available_at(self.archive_date).isoformat(),
            "archiveSha256": self.archive_sha256,
            "archiveBytes": self.archive_bytes,
            "membersDigest": self.members_digest,
            "scopedExpandedBytes": self.scoped_expanded_bytes,
            "categories": {
                str(category_id): dict(counts)
                for category_id, counts in sorted(self.categories.items())
            },
            "rejectCounts": dict(sorted(self.reject_counts.items())),
            "missingCategoryIds": list(self.missing_category_ids),
        }


def _members_digest(group_results: Sequence[GroupPanelResult]) -> str:
    payload = [
        {"path": item.member_path, "sha256": item.member_sha256, "bytes": item.member_bytes}
        for item in sorted(group_results, key=lambda item: item.member_path)
    ]
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode("utf-8")).hexdigest()


def process_archive_date(
    archive_date: date,
    category_ids: Sequence[int],
    *,
    archive_dir: Path,
    panel_dir: Path,
    base_url: str = DEFAULT_BASE_URL,
    user_agent: str = DEFAULT_USER_AGENT,
    timeout_seconds: float = 60.0,
    max_archive_bytes: int = MAX_ARCHIVE_BYTES,
    keep_archive: bool = False,
    fetch_archive: Callable[[str], bytes] | None = None,
    extract_archive: Callable[[bytes, Path], None] | None = None,
) -> ArchiveDateReceipt:
    """Download (once, resumable), extract (single 7z pass), and panel one date.

    If ``archive_dir`` already holds a complete download for this date (from a
    prior interrupted run), the download is skipped entirely -- this is the
    resume path. The archive is deleted after a successful pass unless
    ``keep_archive`` is set, keeping peak disk usage bounded to one date at a
    time across a long backfill.
    """

    day = _archive_day(archive_date)
    requested = tuple(sorted({_positive_int(c, "category_id") for c in category_ids}))
    if not requested:
        raise ValueError("at least one category_id is required")

    archive_dir = Path(archive_dir)
    archive_dir.mkdir(parents=True, exist_ok=True)
    panel_dir = Path(panel_dir)
    archive_path = archive_dir / f"prices-{day.isoformat()}.ppmd.7z"

    if archive_path.is_file() and archive_path.stat().st_size > 0:
        archive_bytes = archive_path.read_bytes()
    else:
        fetch = fetch_archive or (lambda target: _default_fetch_archive_bytes(
            target, timeout_seconds=timeout_seconds, user_agent=user_agent, max_bytes=max_archive_bytes,
        ))
        archive_bytes = fetch(_archive_url(base_url, day))
        if not isinstance(archive_bytes, bytes):
            raise TCGCSVPanelError("archive fetcher must return bytes")
        if len(archive_bytes) > max_archive_bytes:
            raise TCGCSVPanelError("archive response exceeds the configured size limit")
        if not archive_bytes:
            raise TCGCSVPanelError("archive response was empty")
        tmp_path = archive_path.with_name(archive_path.name + ".part")
        tmp_path.write_bytes(archive_bytes)
        tmp_path.replace(archive_path)

    archive_sha256 = sha256(archive_bytes).hexdigest()
    extract = extract_archive or (lambda payload, dest: _default_extract_archive(
        payload, dest, timeout_seconds=timeout_seconds,
    ))

    with tempfile.TemporaryDirectory(prefix="collectfolio-tcgcsv-panel-extract-") as tmp:
        extracted_root = Path(tmp)
        extract(archive_bytes, extracted_root)
        group_results, reject_counts, missing = _write_panel_rows(
            extracted_root, day, requested, panel_dir,
        )

    if not keep_archive:
        archive_path.unlink(missing_ok=True)

    categories: dict[int, dict[str, int]] = {category_id: {"groupCount": 0, "rowCount": 0, "rejectCount": 0} for category_id in requested}
    scoped_expanded_bytes = 0
    for item in group_results:
        bucket = categories.setdefault(item.category_id, {"groupCount": 0, "rowCount": 0, "rejectCount": 0})
        bucket["groupCount"] += 1
        bucket["rowCount"] += item.row_count
        bucket["rejectCount"] += item.reject_count
        scoped_expanded_bytes += item.member_bytes

    return ArchiveDateReceipt(
        archive_date=day,
        archive_sha256=archive_sha256,
        archive_bytes=len(archive_bytes),
        members_digest=_members_digest(group_results),
        scoped_expanded_bytes=scoped_expanded_bytes,
        categories=categories,
        reject_counts=reject_counts,
        missing_category_ids=missing,
    )


# --------------------------------------------------------------------------
# Read-back coverage summary (verifies the panel that actually landed on disk)
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CategoryPanelSummary:
    category_id: int
    dates_covered: int
    row_count: int
    variant_count: int
    earliest_date: date | None
    latest_date: date | None

    def as_dict(self) -> dict[str, object]:
        return {
            "categoryId": self.category_id,
            "datesCovered": self.dates_covered,
            "rowCount": self.row_count,
            "variantCount": self.variant_count,
            "earliestDate": self.earliest_date.isoformat() if self.earliest_date else None,
            "latestDate": self.latest_date.isoformat() if self.latest_date else None,
        }


def summarize_panel(panel_dir: Path, category_ids: Sequence[int]) -> tuple[CategoryPanelSummary, ...]:
    """Read every panel file back from disk and report what is actually there."""

    panel_dir = Path(panel_dir)
    summaries: list[CategoryPanelSummary] = []
    for category_id in sorted({_positive_int(c, "category_id") for c in category_ids}):
        category_dir = panel_dir / f"category-{category_id}"
        variants: set[tuple[int, str]] = set()
        row_count = 0
        dates: list[date] = []
        if category_dir.is_dir():
            for path in sorted(category_dir.glob("*.jsonl.gz")):
                try:
                    day = date.fromisoformat(path.name[: -len(".jsonl.gz")])
                except ValueError:
                    continue
                dates.append(day)
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    for line in handle:
                        line = line.strip()
                        if not line:
                            continue
                        row = json.loads(line)
                        row_count += 1
                        variants.add((int(row["productId"]), str(row["subTypeName"])))
        summaries.append(CategoryPanelSummary(
            category_id=category_id,
            dates_covered=len(dates),
            row_count=row_count,
            variant_count=len(variants),
            earliest_date=min(dates) if dates else None,
            latest_date=max(dates) if dates else None,
        ))
    return tuple(summaries)
