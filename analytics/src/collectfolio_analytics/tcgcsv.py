"""Research-only TCGCSV adapter with explicit rights and mapping gates."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from hashlib import sha256
import json
import shutil
import subprocess
import tempfile
from typing import Callable, Iterable, Mapping
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from .catalog_mapping import (
    ApprovedMapping,
    CanonicalVariant,
    CatalogIngestionPacket,
    ExternalProduct,
    build_catalog_ingestion_packet,
    normalize_identity,
)
from .market_pipeline import (
    ObservationBatch,
    ObservationMapping,
    RawPriceRecord,
    SourceTerms,
    prepare_observation_batch,
)
from .observations import PriceObservation


DEFAULT_BASE_URL = "https://tcgcsv.com/"
DEFAULT_USER_AGENT = "CollectFolio/0.1 research qualification (source review required)"
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_MEMBER_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_SAMPLES = 53
ARCHIVE_INTERVAL_DAYS = 7
ARCHIVE_AVAILABILITY_LAG_DAYS = 1


class TCGCSVPayloadError(ValueError):
    """Raised when an upstream response cannot satisfy the source contract."""


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: object) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool):
        raise TCGCSVPayloadError(f"{name} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise TCGCSVPayloadError(f"{name} must be a positive integer") from exc
    if parsed <= 0:
        raise TCGCSVPayloadError(f"{name} must be a positive integer")
    return parsed


def _utc_timestamp(value: str) -> datetime:
    text = str(value or "").strip()
    if not text:
        raise TCGCSVPayloadError("TCGCSV last-updated timestamp is missing")
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise TCGCSVPayloadError("TCGCSV last-updated timestamp is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise TCGCSVPayloadError("TCGCSV last-updated timestamp must include an offset")
    return parsed.astimezone(timezone.utc)


def _extended_value(product: Mapping[str, object], name: str) -> str:
    values = product.get("extendedData", [])
    if not isinstance(values, list):
        raise TCGCSVPayloadError("product extendedData must be an array")
    for item in values:
        if isinstance(item, Mapping) and str(item.get("name", "")).casefold() == name.casefold():
            return str(item.get("value", "")).strip()
    return ""


def _card_name(product: Mapping[str, object], number: str) -> str:
    name = str(product.get("name", "")).strip()
    if not name:
        raise TCGCSVPayloadError("product name is required")
    suffix = f" - {number}"
    if number and name.casefold().endswith(suffix.casefold()):
        name = name[: -len(suffix)].strip()
    return name


def _result_array(payload: object, label: str) -> tuple[Mapping[str, object], ...]:
    if not isinstance(payload, Mapping) or payload.get("success") is not True:
        raise TCGCSVPayloadError(f"{label} response was not successful")
    results = payload.get("results")
    if not isinstance(results, list) or any(not isinstance(item, Mapping) for item in results):
        raise TCGCSVPayloadError(f"{label} results must be an array of objects")
    return tuple(results)


def _default_fetch_bytes(
    url: str,
    *,
    timeout_seconds: float,
    user_agent: str,
    accept: str,
    max_bytes: int,
) -> bytes:
    request = Request(url, headers={"User-Agent": user_agent, "Accept": accept})
    with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310 - fixed HTTPS origin
        declared = response.headers.get("Content-Length")
        try:
            declared_size = int(declared) if declared else None
        except ValueError as exc:
            raise TCGCSVPayloadError("TCGCSV response has an invalid size") from exc
        if declared_size is not None and declared_size > max_bytes:
            raise TCGCSVPayloadError("TCGCSV response exceeds the configured size limit")
        payload = response.read(max_bytes + 1)
    if len(payload) > max_bytes:
        raise TCGCSVPayloadError("TCGCSV response exceeds the configured size limit")
    return payload


def _default_fetch_text(url: str, *, timeout_seconds: float, user_agent: str) -> str:
    payload = _default_fetch_bytes(
        url,
        timeout_seconds=timeout_seconds,
        user_agent=user_agent,
        accept="application/json,text/plain",
        max_bytes=MAX_RESPONSE_BYTES,
    )
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise TCGCSVPayloadError("TCGCSV response is not UTF-8") from exc


def _default_extract_archive_member(
    archive: bytes,
    member_path: str,
    *,
    timeout_seconds: float,
) -> bytes:
    executable = shutil.which("7z")
    if not executable:
        raise TCGCSVPayloadError("7z is required to read TCGCSV PPMd archives")
    with tempfile.NamedTemporaryFile(prefix="collectfolio-tcgcsv-", suffix=".7z") as handle:
        handle.write(archive)
        handle.flush()
        process = subprocess.Popen(  # noqa: S603 - fixed executable and generated member path
            [executable, "x", "-so", "-bd", "-y", handle.name, member_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            if process.stdout is None:
                raise TCGCSVPayloadError("7z did not expose archive output")
            payload = process.stdout.read(MAX_ARCHIVE_MEMBER_BYTES + 1)
            if len(payload) > MAX_ARCHIVE_MEMBER_BYTES:
                process.kill()
                process.communicate()
                raise TCGCSVPayloadError("TCGCSV archive member exceeds the configured size limit")
            try:
                _, stderr = process.communicate(timeout=timeout_seconds)
            except subprocess.TimeoutExpired as exc:
                process.kill()
                process.communicate()
                raise TCGCSVPayloadError("TCGCSV archive extraction timed out") from exc
        except BaseException:
            if process.poll() is None:
                process.kill()
                process.communicate()
            raise
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        suffix = f": {detail[-400:]}" if detail else ""
        raise TCGCSVPayloadError(f"TCGCSV archive member could not be extracted{suffix}")
    return payload


def _archive_day(value: date) -> date:
    if isinstance(value, datetime) or not isinstance(value, date):
        raise ValueError("archive dates must be date values")
    return value


def _sha256_digest(value: str, name: str) -> str:
    digest = str(value or "").strip().lower()
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise ValueError(f"{name} must be a SHA-256 digest")
    return digest


@dataclass(frozen=True, slots=True)
class TCGCSVSnapshot:
    category_id: int
    group_id: int
    source_updated_at: datetime
    products: tuple[Mapping[str, object], ...]
    prices: tuple[Mapping[str, object], ...]
    snapshot_hash: str

    def _selected_product_ids(self, product_ids: Iterable[int] | None) -> set[int]:
        available = {_positive_int(item.get("productId"), "productId") for item in self.products}
        if product_ids is None:
            return available
        selected = {_positive_int(value, "product_id") for value in product_ids}
        missing = selected - available
        if missing:
            raise TCGCSVPayloadError(f"selected product IDs are absent: {sorted(missing)}")
        return selected

    def external_products(
        self,
        *,
        source_id: str,
        canonical_set_key: str,
        product_ids: Iterable[int] | None = None,
        game: str = "pokemon",
        language: str = "en",
    ) -> tuple[ExternalProduct, ...]:
        selected = self._selected_product_ids(product_ids)
        product_index = {
            _positive_int(product.get("productId"), "productId"): product
            for product in self.products
            if _positive_int(product.get("productId"), "productId") in selected
        }
        values: list[ExternalProduct] = []
        for price in self.prices:
            product_id = _positive_int(price.get("productId"), "productId")
            if product_id not in product_index:
                continue
            finish = normalize_identity(str(price.get("subTypeName", "")))
            if not finish:
                raise TCGCSVPayloadError("price subTypeName is required")
            product = product_index[product_id]
            number = _extended_value(product, "Number")
            if not number:
                raise TCGCSVPayloadError(f"product {product_id} has no card number")
            values.append(ExternalProduct(
                source_id=source_id,
                external_product_id=str(product_id),
                external_variant_key=finish,
                game=game,
                language=language,
                canonical_set_key=canonical_set_key,
                name=_card_name(product, number),
                number=number,
                edition="standard",
                finish=finish,
                condition_class="raw",
            ))
        return tuple(sorted(values, key=lambda item: (item.external_product_id, item.external_variant_key)))

    def raw_price_records(
        self,
        *,
        product_ids: Iterable[int] | None = None,
        quality_score: float = 0.80,
    ) -> tuple[RawPriceRecord, ...]:
        selected = self._selected_product_ids(product_ids)
        values: list[RawPriceRecord] = []
        timestamp = self.source_updated_at.isoformat()
        for price in self.prices:
            product_id = _positive_int(price.get("productId"), "productId")
            if product_id not in selected:
                continue
            finish = normalize_identity(str(price.get("subTypeName", "")))
            if not finish:
                raise TCGCSVPayloadError("price subTypeName is required")
            market_value = price.get("marketPrice")
            if market_value is not None:
                try:
                    market_value = float(market_value)
                except (TypeError, ValueError) as exc:
                    raise TCGCSVPayloadError("marketPrice must be numeric or null") from exc
            values.append(RawPriceRecord(
                external_record_id=(
                    f"tcgcsv:{self.category_id}:{self.group_id}:"
                    f"{product_id}:{finish}:{timestamp}"
                ),
                external_product_id=str(product_id),
                external_variant_key=finish,
                price_semantics="tcgplayer_market",
                currency="USD",
                market_price=market_value,
                observed_at=self.source_updated_at,
                available_at=self.source_updated_at,
                quality_score=quality_score,
            ))
        return tuple(sorted(values, key=lambda item: (item.external_product_id, item.external_variant_key)))


@dataclass(frozen=True, slots=True)
class TCGCSVArchiveSnapshot:
    """One price-only daily archive with conservative point-in-time metadata."""

    archive_date: date
    category_id: int
    group_id: int
    prices: tuple[Mapping[str, object], ...]
    artifact_hash: str
    snapshot_hash: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "archive_date", _archive_day(self.archive_date))
        object.__setattr__(self, "category_id", _positive_int(self.category_id, "category_id"))
        object.__setattr__(self, "group_id", _positive_int(self.group_id, "group_id"))
        prices = tuple(self.prices)
        if not prices or any(not isinstance(item, Mapping) for item in prices):
            raise ValueError("archive prices must contain at least one object")
        object.__setattr__(self, "prices", prices)
        object.__setattr__(self, "artifact_hash", _sha256_digest(
            self.artifact_hash, "artifact_hash"
        ))
        object.__setattr__(self, "snapshot_hash", _sha256_digest(
            self.snapshot_hash, "snapshot_hash"
        ))

    @property
    def observed_at(self) -> datetime:
        return datetime.combine(self.archive_date, time.min, tzinfo=timezone.utc)

    @property
    def available_at(self) -> datetime:
        return self.observed_at + timedelta(days=ARCHIVE_AVAILABILITY_LAG_DAYS)

    def raw_price_records(
        self,
        *,
        product_ids: Iterable[int],
        quality_score: float = 0.75,
    ) -> tuple[RawPriceRecord, ...]:
        selected = {_positive_int(value, "product_id") for value in product_ids}
        if not selected:
            raise ValueError("at least one product_id is required for archive extraction")
        available = {
            _positive_int(price.get("productId"), "productId")
            for price in self.prices
        }
        missing = selected - available
        if missing:
            raise TCGCSVPayloadError(
                f"selected product IDs are absent from {self.archive_date.isoformat()}: {sorted(missing)}"
            )
        values: list[RawPriceRecord] = []
        timestamp = self.observed_at.isoformat()
        for price in self.prices:
            product_id = _positive_int(price.get("productId"), "productId")
            if product_id not in selected:
                continue
            finish = normalize_identity(str(price.get("subTypeName", "")))
            if not finish:
                raise TCGCSVPayloadError("price subTypeName is required")
            market_value = price.get("marketPrice")
            if market_value is not None:
                try:
                    market_value = float(market_value)
                except (TypeError, ValueError) as exc:
                    raise TCGCSVPayloadError("marketPrice must be numeric or null") from exc
            values.append(RawPriceRecord(
                external_record_id=(
                    f"tcgcsv-archive:{self.category_id}:{self.group_id}:"
                    f"{product_id}:{finish}:{timestamp}"
                ),
                external_product_id=str(product_id),
                external_variant_key=finish,
                price_semantics="tcgplayer_market",
                currency="USD",
                market_price=market_value,
                observed_at=self.observed_at,
                available_at=self.available_at,
                quality_score=quality_score,
            ))
        return tuple(sorted(values, key=lambda item: (item.external_product_id, item.external_variant_key)))


@dataclass(frozen=True, slots=True)
class TCGCSVArchiveHistory:
    """A bounded, exact-weekly collection of price archives."""

    snapshots: tuple[TCGCSVArchiveSnapshot, ...]
    history_hash: str
    expected_interval_days: int = ARCHIVE_INTERVAL_DAYS
    availability_lag_days: int = ARCHIVE_AVAILABILITY_LAG_DAYS
    max_reference_lag_days: int = ARCHIVE_INTERVAL_DAYS

    def __post_init__(self) -> None:
        snapshots = tuple(self.snapshots)
        if not snapshots or len(snapshots) > MAX_ARCHIVE_SAMPLES:
            raise ValueError(
                f"archive history must contain 1 to {MAX_ARCHIVE_SAMPLES} samples"
            )
        if any(not isinstance(item, TCGCSVArchiveSnapshot) for item in snapshots):
            raise ValueError("archive history must contain TCGCSVArchiveSnapshot values")
        if any(
            right.archive_date - left.archive_date != timedelta(days=ARCHIVE_INTERVAL_DAYS)
            for left, right in zip(snapshots, snapshots[1:])
        ):
            raise ValueError("archive history must use exact seven-day intervals")
        identities = {(item.category_id, item.group_id) for item in snapshots}
        if len(identities) != 1:
            raise ValueError("archive history cannot mix category or group identities")
        if (
            self.expected_interval_days != ARCHIVE_INTERVAL_DAYS
            or self.availability_lag_days != ARCHIVE_AVAILABILITY_LAG_DAYS
            or self.max_reference_lag_days != ARCHIVE_INTERVAL_DAYS
        ):
            raise ValueError("archive history timing contract cannot be overridden")
        object.__setattr__(self, "snapshots", snapshots)
        object.__setattr__(self, "history_hash", _sha256_digest(
            self.history_hash, "history_hash"
        ))

    def raw_price_records(
        self,
        *,
        product_ids: Iterable[int],
        quality_score: float = 0.75,
    ) -> tuple[RawPriceRecord, ...]:
        selected = tuple(product_ids)
        return tuple(
            record
            for snapshot in self.snapshots
            for record in snapshot.raw_price_records(
                product_ids=selected,
                quality_score=quality_score,
            )
        )


class TCGCSVResearchClient:
    """Small bounded client for TCGCSV's cached JSON research surface."""

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout_seconds: float = 20,
        user_agent: str = DEFAULT_USER_AGENT,
        fetch_text: Callable[[str], str] | None = None,
        fetch_archive: Callable[[str], bytes] | None = None,
        extract_archive_member: Callable[[bytes, str], bytes] | None = None,
    ) -> None:
        if not base_url.startswith("https://"):
            raise ValueError("TCGCSV base_url must use HTTPS")
        if timeout_seconds <= 0 or timeout_seconds > 60:
            raise ValueError("timeout_seconds must be between zero and 60")
        if not str(user_agent).strip():
            raise ValueError("user_agent is required")
        self.base_url = base_url.rstrip("/") + "/"
        self.timeout_seconds = float(timeout_seconds)
        self.user_agent = str(user_agent).strip()
        self._fetch_override = fetch_text
        self._fetch_archive_override = fetch_archive
        self._extract_archive_override = extract_archive_member

    def _fetch(self, path: str) -> str:
        url = urljoin(self.base_url, path.lstrip("/"))
        if not url.startswith(self.base_url):
            raise ValueError("TCGCSV path escaped the configured origin")
        if self._fetch_override is not None:
            return self._fetch_override(url)
        return _default_fetch_text(
            url,
            timeout_seconds=self.timeout_seconds,
            user_agent=self.user_agent,
        )

    def _json(self, path: str) -> object:
        try:
            return json.loads(self._fetch(path))
        except json.JSONDecodeError as exc:
            raise TCGCSVPayloadError("TCGCSV response is not valid JSON") from exc

    def _archive(self, path: str) -> bytes:
        url = urljoin(self.base_url, path.lstrip("/"))
        if not url.startswith(self.base_url):
            raise ValueError("TCGCSV path escaped the configured origin")
        if self._fetch_archive_override is not None:
            payload = self._fetch_archive_override(url)
            if not isinstance(payload, bytes):
                raise TCGCSVPayloadError("TCGCSV archive fetcher must return bytes")
            if len(payload) > MAX_ARCHIVE_BYTES:
                raise TCGCSVPayloadError("TCGCSV response exceeds the configured size limit")
            return payload
        return _default_fetch_bytes(
            url,
            timeout_seconds=self.timeout_seconds,
            user_agent=self.user_agent,
            accept="application/octet-stream",
            max_bytes=MAX_ARCHIVE_BYTES,
        )

    def _archive_member(self, archive: bytes, member_path: str) -> bytes:
        if self._extract_archive_override is not None:
            payload = self._extract_archive_override(archive, member_path)
            if not isinstance(payload, bytes):
                raise TCGCSVPayloadError("TCGCSV archive extractor must return bytes")
            if len(payload) > MAX_ARCHIVE_MEMBER_BYTES:
                raise TCGCSVPayloadError("TCGCSV archive member exceeds the configured size limit")
            return payload
        return _default_extract_archive_member(
            archive,
            member_path,
            timeout_seconds=self.timeout_seconds,
        )

    def snapshot(self, category_id: int, group_id: int) -> TCGCSVSnapshot:
        category = _positive_int(category_id, "category_id")
        group = _positive_int(group_id, "group_id")
        timestamp_before = _utc_timestamp(self._fetch("last-updated.txt"))
        products = _result_array(
            self._json(f"tcgplayer/{category}/{group}/products"),
            "products",
        )
        prices = _result_array(
            self._json(f"tcgplayer/{category}/{group}/prices"),
            "prices",
        )
        timestamp_after = _utc_timestamp(self._fetch("last-updated.txt"))
        if timestamp_after != timestamp_before:
            raise TCGCSVPayloadError("TCGCSV changed while the snapshot was being read; retry")
        normalized = {
            "categoryId": category,
            "groupId": group,
            "sourceUpdatedAt": timestamp_after.isoformat(),
            "products": products,
            "prices": prices,
        }
        return TCGCSVSnapshot(
            category_id=category,
            group_id=group,
            source_updated_at=timestamp_after,
            products=products,
            prices=prices,
            snapshot_hash=_hash(normalized),
        )

    def price_archive(
        self,
        archive_date: date,
        category_id: int,
        group_id: int,
    ) -> TCGCSVArchiveSnapshot:
        day = _archive_day(archive_date)
        category = _positive_int(category_id, "category_id")
        group = _positive_int(group_id, "group_id")
        archive = self._archive(
            f"archive/tcgplayer/prices-{day.isoformat()}.ppmd.7z"
        )
        member_path = f"{day.isoformat()}/{category}/{group}/prices"
        payload = self._archive_member(archive, member_path)
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise TCGCSVPayloadError("TCGCSV archive member is not UTF-8") from exc
        except json.JSONDecodeError as exc:
            raise TCGCSVPayloadError("TCGCSV archive member is not valid JSON") from exc
        prices = _result_array(parsed, f"prices archive {day.isoformat()}")
        normalized = {
            "archiveDate": day.isoformat(),
            "categoryId": category,
            "groupId": group,
            "prices": prices,
        }
        return TCGCSVArchiveSnapshot(
            archive_date=day,
            category_id=category,
            group_id=group,
            prices=prices,
            artifact_hash=sha256(archive).hexdigest(),
            snapshot_hash=_hash(normalized),
        )

    def weekly_price_history(
        self,
        *,
        start_date: date,
        end_date: date,
        category_id: int,
        group_id: int,
    ) -> TCGCSVArchiveHistory:
        start = _archive_day(start_date)
        end = _archive_day(end_date)
        span_days = (end - start).days
        if span_days < 0:
            raise ValueError("end_date must not precede start_date")
        if span_days % ARCHIVE_INTERVAL_DAYS:
            raise ValueError("archive range must align to an exact seven-day interval")
        sample_count = (span_days // ARCHIVE_INTERVAL_DAYS) + 1
        if sample_count > MAX_ARCHIVE_SAMPLES:
            raise ValueError(
                f"archive history is limited to {MAX_ARCHIVE_SAMPLES} weekly samples"
            )
        snapshots = tuple(
            self.price_archive(
                start + timedelta(days=index * ARCHIVE_INTERVAL_DAYS),
                category_id,
                group_id,
            )
            for index in range(sample_count)
        )
        normalized = {
            "expectedIntervalDays": ARCHIVE_INTERVAL_DAYS,
            "availabilityLagDays": ARCHIVE_AVAILABILITY_LAG_DAYS,
            "maxReferenceLagDays": ARCHIVE_INTERVAL_DAYS,
            "snapshots": [
                {
                    "archiveDate": item.archive_date.isoformat(),
                    "artifactHash": item.artifact_hash,
                    "snapshotHash": item.snapshot_hash,
                }
                for item in snapshots
            ],
        }
        return TCGCSVArchiveHistory(
            snapshots=snapshots,
            history_hash=_hash(normalized),
        )


def assert_tcgcsv_research_terms(terms: SourceTerms, at: datetime) -> None:
    """TCGCSV is intentionally barred from every production/public permission."""

    if not isinstance(terms, SourceTerms):
        raise ValueError("terms must be SourceTerms")
    if terms.decision != "research_only" or any((
        terms.commercial_use_allowed,
        terms.catalog_metadata_allowed,
        terms.public_raw_display_allowed,
        terms.public_derived_display_allowed,
    )):
        raise PermissionError("TCGCSV requires a strictly research-only source review")
    if not terms.permits_research_ingestion(at):
        raise PermissionError("current TCGCSV terms do not permit research ingestion")


@dataclass(frozen=True, slots=True)
class TCGCSVResearchPacket:
    snapshot_hash: str
    catalog: CatalogIngestionPacket
    observations: ObservationBatch
    source_updated_at: datetime
    raw_record_count: int

    @property
    def gate_status(self) -> Mapping[str, object]:
        accepted = self.observations.status_counts["accepted"]
        return {
            "sourceRights": "research_only",
            "mapping": "approved" if accepted else "operator_review_required",
            "publicPublication": "blocked",
        }


def build_tcgcsv_research_packet(
    snapshot: TCGCSVSnapshot,
    catalog: Iterable[CanonicalVariant],
    terms: SourceTerms,
    *,
    canonical_set_key: str,
    ingestion_run_id: str,
    ingested_at: datetime,
    permission_checked_at: datetime | None = None,
    mapping_version: str,
    product_ids: Iterable[int] | None = None,
    approved_mappings: Iterable[ApprovedMapping] = (),
    observation_mappings: Iterable[ObservationMapping] = (),
    history_by_variant: Mapping[str, Iterable[PriceObservation]] | None = None,
    actor_label: str = "tcgcsv-research-adapter-v1",
) -> TCGCSVResearchPacket:
    assert_tcgcsv_research_terms(terms, permission_checked_at or ingested_at)
    external_products = snapshot.external_products(
        source_id=terms.source_id,
        canonical_set_key=canonical_set_key,
        product_ids=product_ids,
    )
    catalog_packet = build_catalog_ingestion_packet(
        catalog,
        external_products,
        ingestion_run_id=ingestion_run_id,
        terms_review_id=terms.terms_review_id,
        approved_mappings=approved_mappings,
        mapping_version=mapping_version,
    )
    raw_records = snapshot.raw_price_records(product_ids=product_ids)
    observations = prepare_observation_batch(
        raw_records,
        observation_mappings,
        terms,
        history_by_variant or {},
        ingestion_run_id=ingestion_run_id,
        ingested_at=ingested_at,
        actor_label=actor_label,
    )
    return TCGCSVResearchPacket(
        snapshot_hash=snapshot.snapshot_hash,
        catalog=catalog_packet,
        observations=observations,
        source_updated_at=snapshot.source_updated_at,
        raw_record_count=len(raw_records),
    )
