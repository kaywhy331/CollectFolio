"""Persistent first-seen provenance for rolling Cardbase history imports."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
from hashlib import sha256
import json
from typing import Iterable, Mapping

from .market_pipeline import RawPriceRecord


LEDGER_CONTRACT_VERSION = "cardbase-first-seen-ledger-v1"
MAX_LEDGER_RECORDS = 200_000


def _utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _datetime(value: object, name: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO timestamp") from exc
    return _utc(parsed, name)


def _canonical_hash(value: object) -> str:
    return sha256(json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")).hexdigest()


def _record_identity(record: RawPriceRecord) -> dict[str, object]:
    return {
        "externalRecordId": record.external_record_id,
        "externalProductId": record.external_product_id,
        "externalVariantKey": record.external_variant_key,
        "priceSemantics": record.price_semantics,
        "currency": record.currency,
        "marketPrice": record.market_price,
        "observedAt": record.observed_at.isoformat(),
        "qualityScore": record.quality_score,
    }


def cardbase_record_identity_sha256(record: RawPriceRecord) -> str:
    """Hash every immutable field except first-seen availability."""

    if not isinstance(record, RawPriceRecord):
        raise ValueError("record must be a RawPriceRecord")
    return _canonical_hash(_record_identity(record))


@dataclass(frozen=True, slots=True)
class CardbaseFirstSeenEntry:
    external_record_id: str
    identity_sha256: str
    available_at: datetime

    def __post_init__(self) -> None:
        external_record_id = str(self.external_record_id or "").strip()
        if not external_record_id.startswith("cardbase:"):
            raise ValueError("ledger external_record_id must be a Cardbase record")
        object.__setattr__(self, "external_record_id", external_record_id)
        digest = str(self.identity_sha256 or "").strip().lower()
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("ledger identity_sha256 must be a SHA-256 digest")
        object.__setattr__(self, "identity_sha256", digest)
        object.__setattr__(self, "available_at", _utc(
            self.available_at, "ledger.available_at"
        ))

    def as_dict(self) -> dict[str, str]:
        return {
            "externalRecordId": self.external_record_id,
            "identitySha256": self.identity_sha256,
            "availableAt": self.available_at.isoformat(),
        }


@dataclass(frozen=True, slots=True)
class CardbaseFirstSeenLedger:
    entries: tuple[CardbaseFirstSeenEntry, ...] = ()

    def __post_init__(self) -> None:
        try:
            entries = tuple(self.entries)
        except TypeError as exc:
            raise ValueError("ledger entries must be an array") from exc
        if len(entries) > MAX_LEDGER_RECORDS or any(
            not isinstance(item, CardbaseFirstSeenEntry) for item in entries
        ):
            raise ValueError("ledger contains invalid or excessive entries")
        ids = [item.external_record_id for item in entries]
        if len(ids) != len(set(ids)):
            raise ValueError("ledger contains duplicate external record identities")
        object.__setattr__(self, "entries", tuple(sorted(
            entries, key=lambda item: item.external_record_id
        )))

    @classmethod
    def from_dict(cls, value: object) -> "CardbaseFirstSeenLedger":
        if value is None:
            return cls()
        if not isinstance(value, Mapping):
            raise ValueError("Cardbase first-seen ledger must be an object")
        if value.get("contractVersion") != LEDGER_CONTRACT_VERSION:
            raise ValueError("Cardbase first-seen ledger contract is unsupported")
        raw_entries = value.get("entries")
        if not isinstance(raw_entries, list):
            raise ValueError("Cardbase first-seen ledger entries must be an array")
        record_count = value.get("recordCount")
        if (
            isinstance(record_count, bool)
            or not isinstance(record_count, int)
            or record_count != len(raw_entries)
        ):
            raise ValueError("Cardbase first-seen ledger recordCount is invalid")
        entries: list[CardbaseFirstSeenEntry] = []
        for index, raw in enumerate(raw_entries):
            if not isinstance(raw, Mapping):
                raise ValueError(f"ledger.entries[{index}] must be an object")
            entries.append(CardbaseFirstSeenEntry(
                external_record_id=str(raw.get("externalRecordId") or ""),
                identity_sha256=str(raw.get("identitySha256") or ""),
                available_at=_datetime(
                    raw.get("availableAt"), f"ledger.entries[{index}].availableAt"
                ),
            ))
        ledger = cls(tuple(entries))
        expected_hash = value.get("ledgerSha256")
        if not isinstance(expected_hash, str) or expected_hash != ledger.ledger_sha256:
            raise ValueError("Cardbase first-seen ledger hash does not match its entries")
        return ledger

    @property
    def ledger_sha256(self) -> str:
        return _canonical_hash([item.as_dict() for item in self.entries])

    def as_dict(self) -> dict[str, object]:
        return {
            "contractVersion": LEDGER_CONTRACT_VERSION,
            "recordCount": len(self.entries),
            "entries": [item.as_dict() for item in self.entries],
            "ledgerSha256": self.ledger_sha256,
        }

    def reconcile(
        self,
        records: Iterable[RawPriceRecord],
        *,
        first_seen_at: datetime,
    ) -> tuple[tuple[RawPriceRecord, ...], "CardbaseFirstSeenLedger"]:
        """Reuse prior availability and append genuinely new/revised points."""

        first_seen = _utc(first_seen_at, "first_seen_at")
        previous = {item.external_record_id: item for item in self.entries}
        current_entries = dict(previous)
        reconciled: list[RawPriceRecord] = []
        seen: set[str] = set()
        for record in records:
            if not isinstance(record, RawPriceRecord):
                raise ValueError("records must contain RawPriceRecord values")
            if record.external_record_id in seen:
                raise ValueError("records contain duplicate external_record_id values")
            seen.add(record.external_record_id)
            digest = cardbase_record_identity_sha256(record)
            prior = previous.get(record.external_record_id)
            if prior is not None:
                if prior.identity_sha256 != digest:
                    raise ValueError(
                        "Cardbase record identity conflicts with its first-seen ledger"
                    )
                available_at = prior.available_at
            else:
                available_at = first_seen
                current_entries[record.external_record_id] = CardbaseFirstSeenEntry(
                    external_record_id=record.external_record_id,
                    identity_sha256=digest,
                    available_at=available_at,
                )
            if available_at < record.observed_at or available_at > first_seen:
                raise ValueError("Cardbase first-seen availability is outside valid bounds")
            reconciled.append(replace(record, available_at=available_at))
        updated = CardbaseFirstSeenLedger(tuple(current_entries.values()))
        return tuple(reconciled), updated
