"""Rollback-first SQL generation for reviewed pull-rate registry packets."""

from __future__ import annotations

from typing import Mapping, Sequence

from .pull_rate_curation import PACKET_MODE, pull_rate_packet_hash

SOURCE_COLUMNS = (
    "id", "publisher", "title", "url", "published_at", "retrieved_at",
    "sample_size", "methodology", "region", "language", "confidence_grade",
)
RATE_COLUMNS = (
    "id", "set_id", "source_id", "rarity_slot", "probability", "ci_lower",
    "ci_upper", "one_in_packs", "eligible_count", "specific_probability",
    "specific_one_in_packs", "equal_distribution_assumed", "collation_notes",
    "effective_from", "effective_to", "version",
)
UNAVAILABLE_COLUMNS = (
    "id", "set_id", "source_id", "scope", "rarity_slot", "reason", "checked_at",
)
CATALOG_COLUMNS = ("set_id", "canonical_key", "set_code", "name", "release_date")


def _literal(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _rows(entries: Sequence[Mapping[str, object]], columns: Sequence[str]) -> str:
    return ",\n".join(
        "(" + ", ".join(_literal(entry.get(column)) for column in columns) + ")"
        for entry in entries
    )


def _packet_rows(
    packet: Mapping[str, object],
) -> tuple[
    list[Mapping[str, object]],
    list[Mapping[str, object]],
    list[Mapping[str, object]],
    list[Mapping[str, object]],
]:
    if not isinstance(packet, Mapping) or packet.get("mode") != PACKET_MODE:
        raise ValueError(f"packet must be a {PACKET_MODE} packet")
    if packet.get("review_required") is not True or packet.get("public_display_candidates") != []:
        raise ValueError("packet must be review-gated with no public display candidates")
    rows = packet.get("rows")
    evidence = packet.get("evidence")
    coverage = packet.get("coverage")
    if not isinstance(rows, Mapping) or not isinstance(evidence, Mapping) or not isinstance(coverage, Mapping):
        raise ValueError("packet rows, evidence, and coverage are required")
    expected_hash = pull_rate_packet_hash(rows, evidence, coverage)
    if packet.get("packet_hash") != expected_hash:
        raise ValueError("packet_hash does not match rows, evidence, and coverage")
    sources = rows.get("pull_rate_sources")
    rates = rows.get("set_pull_rates")
    unavailable = rows.get("pull_rate_unavailability")
    catalog_sets = evidence.get("catalog_sets")
    if not isinstance(sources, list) or not sources or not all(isinstance(row, Mapping) for row in sources):
        raise ValueError("packet must contain pull_rate_sources rows")
    if not isinstance(rates, list) or not rates or not all(isinstance(row, Mapping) for row in rates):
        raise ValueError("packet must contain set_pull_rates rows")
    if not isinstance(unavailable, list) or not unavailable or not all(isinstance(row, Mapping) for row in unavailable):
        raise ValueError("packet must contain pull_rate_unavailability rows")
    if not isinstance(catalog_sets, list) or not catalog_sets or not all(isinstance(row, Mapping) for row in catalog_sets):
        raise ValueError("packet evidence must contain catalog_sets")
    counts = packet.get("counts")
    if (
        not isinstance(counts, Mapping)
        or counts.get("sources") != len(sources)
        or counts.get("entries") != len(rates)
        or counts.get("unavailable_records") != len(unavailable)
    ):
        raise ValueError("packet counts do not match its rows")
    source_ids = [str(row.get("id") or "") for row in sources]
    rate_ids = [str(row.get("id") or "") for row in rates]
    catalog_ids = {str(row.get("set_id") or "") for row in catalog_sets}
    if len(set(source_ids)) != len(source_ids) or "" in source_ids:
        raise ValueError("source row IDs must be present and unique")
    if len(set(rate_ids)) != len(rate_ids) or "" in rate_ids:
        raise ValueError("pull-rate row IDs must be present and unique")
    if any(str(row.get("source_id") or "") not in set(source_ids) for row in rates):
        raise ValueError("every pull-rate row must reference a packet source")
    if any(str(row.get("set_id") or "") not in catalog_ids for row in rates):
        raise ValueError("every pull-rate row must reference packet catalog evidence")
    unavailable_ids = [str(row.get("id") or "") for row in unavailable]
    if len(set(unavailable_ids)) != len(unavailable_ids) or "" in unavailable_ids:
        raise ValueError("unavailability row IDs must be present and unique")
    if any(str(row.get("set_id") or "") not in catalog_ids for row in unavailable):
        raise ValueError("every unavailability row must reference packet catalog evidence")
    if any(
        row.get("source_id") is not None and str(row.get("source_id")) not in set(source_ids)
        for row in unavailable
    ):
        raise ValueError("an unavailability source_id must reference a packet source")
    return sources, rates, unavailable, catalog_sets


def build_pull_rate_sql(packet: Mapping[str, object], *, commit: bool = False) -> str:
    """Generate guarded, idempotent SQL; defaults to a rollback rehearsal."""

    sources, rates, unavailable, catalog_sets = _packet_rows(packet)
    packet_hash = str(packet["packet_hash"])
    pieces = [
        f"-- Generated from a {PACKET_MODE} packet (hash {packet_hash}).",
        "begin;",
        """create temporary table _collectfolio_expected_catalog_sets (
  set_id uuid primary key,
  canonical_key text not null unique,
  set_code text not null unique,
  name text not null,
  release_date date not null
) on commit drop;""",
        "insert into pg_temp._collectfolio_expected_catalog_sets "
        f"({', '.join(CATALOG_COLUMNS)})\nvalues\n"
        + _rows(catalog_sets, CATALOG_COLUMNS)
        + ";",
        """create temporary table _collectfolio_expected_pull_rate_sources (
  id uuid primary key,
  publisher text not null,
  title text not null,
  url text not null,
  published_at date,
  retrieved_at timestamptz not null,
  sample_size integer not null,
  methodology text not null,
  region text not null,
  language text not null,
  confidence_grade text not null
) on commit drop;""",
        "insert into pg_temp._collectfolio_expected_pull_rate_sources "
        f"({', '.join(SOURCE_COLUMNS)})\nvalues\n"
        + _rows(sources, SOURCE_COLUMNS)
        + ";",
        """create temporary table _collectfolio_expected_set_pull_rates (
  id uuid primary key,
  set_id uuid not null,
  source_id uuid not null,
  rarity_slot text not null,
  probability numeric(12,10) not null,
  ci_lower numeric(12,10),
  ci_upper numeric(12,10),
  one_in_packs numeric(12,2) not null,
  eligible_count integer,
  specific_probability numeric(14,12),
  specific_one_in_packs numeric(14,2),
  equal_distribution_assumed boolean not null,
  collation_notes text not null,
  effective_from date not null,
  effective_to date,
  version integer not null
) on commit drop;""",
        "insert into pg_temp._collectfolio_expected_set_pull_rates "
        f"({', '.join(RATE_COLUMNS)})\nvalues\n"
        + _rows(rates, RATE_COLUMNS)
        + ";",
        """create temporary table _collectfolio_expected_pull_rate_unavailability (
  id uuid primary key,
  set_id uuid not null,
  source_id uuid,
  scope text not null,
  rarity_slot text,
  reason text not null,
  checked_at timestamptz not null
) on commit drop;""",
        "insert into pg_temp._collectfolio_expected_pull_rate_unavailability "
        f"({', '.join(UNAVAILABLE_COLUMNS)})\nvalues\n"
        + _rows(unavailable, UNAVAILABLE_COLUMNS)
        + ";",
        """do $catalog_guard$
begin
  if exists (
    select 1
    from pg_temp._collectfolio_expected_catalog_sets expected
    left join public.catalog_sets actual
      on actual.id = expected.set_id
     and actual.canonical_key = expected.canonical_key
     and actual.name = expected.name
     and actual.release_date = expected.release_date
    where actual.id is null
  ) then
    raise exception 'Pull-rate packet catalog identity does not match the hosted canonical catalog';
  end if;
end;
$catalog_guard$;""",
        "insert into public.pull_rate_sources "
        f"({', '.join(SOURCE_COLUMNS)})\nselect {', '.join(SOURCE_COLUMNS)}\n"
        "from pg_temp._collectfolio_expected_pull_rate_sources\n"
        "on conflict (id) do nothing;",
        "insert into public.set_pull_rates "
        f"({', '.join(RATE_COLUMNS)})\nselect {', '.join(RATE_COLUMNS)}\n"
        "from pg_temp._collectfolio_expected_set_pull_rates\n"
        "on conflict (id) do nothing;",
        "insert into public.pull_rate_unavailability "
        f"({', '.join(UNAVAILABLE_COLUMNS)})\nselect {', '.join(UNAVAILABLE_COLUMNS)}\n"
        "from pg_temp._collectfolio_expected_pull_rate_unavailability\n"
        "on conflict (id) do nothing;",
        """do $exact_guard$
begin
  if exists (
    select 1
    from pg_temp._collectfolio_expected_pull_rate_sources expected
    left join public.pull_rate_sources actual on actual.id = expected.id
    where actual.id is null
       or row(actual.publisher, actual.title, actual.url, actual.published_at,
              actual.retrieved_at, actual.sample_size, actual.methodology,
              actual.region, actual.language, actual.confidence_grade)
          is distinct from
          row(expected.publisher, expected.title, expected.url, expected.published_at,
              expected.retrieved_at, expected.sample_size, expected.methodology,
              expected.region, expected.language, expected.confidence_grade)
  ) then
    raise exception 'Hosted pull-rate source identity conflicts with the reviewed packet';
  end if;
  if exists (
    select 1
    from pg_temp._collectfolio_expected_set_pull_rates expected
    left join public.set_pull_rates actual on actual.id = expected.id
    where actual.id is null
       or row(actual.set_id, actual.source_id, actual.rarity_slot, actual.probability,
              actual.ci_lower, actual.ci_upper, actual.one_in_packs,
              actual.eligible_count, actual.specific_probability,
              actual.specific_one_in_packs, actual.equal_distribution_assumed,
              actual.collation_notes, actual.effective_from, actual.effective_to,
              actual.version)
          is distinct from
          row(expected.set_id, expected.source_id, expected.rarity_slot,
              expected.probability, expected.ci_lower, expected.ci_upper,
              expected.one_in_packs, expected.eligible_count,
              expected.specific_probability, expected.specific_one_in_packs,
              expected.equal_distribution_assumed, expected.collation_notes,
              expected.effective_from, expected.effective_to, expected.version)
  ) then
    raise exception 'Hosted pull-rate row identity conflicts with the reviewed packet';
  end if;
  if exists (
    select 1
    from pg_temp._collectfolio_expected_pull_rate_unavailability expected
    left join public.pull_rate_unavailability actual on actual.id = expected.id
    where actual.id is null
       or row(actual.set_id, actual.source_id, actual.scope, actual.rarity_slot,
              actual.reason, actual.checked_at)
          is distinct from
          row(expected.set_id, expected.source_id, expected.scope,
              expected.rarity_slot, expected.reason, expected.checked_at)
  ) then
    raise exception 'Hosted pull-rate unavailability identity conflicts with the reviewed packet';
  end if;
end;
$exact_guard$;""",
        "commit;" if commit else "rollback; -- rehearsal by default; regenerate with commit for the real run",
    ]
    return "\n\n".join(pieces) + "\n"
