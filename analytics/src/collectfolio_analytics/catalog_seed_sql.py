"""Guarded SQL generation for catalog seed packets.

Turns a reviewed ``catalog_seed`` packet into idempotent INSERT statements
for the hosted catalog tables. Follows the repository's rollback-first
convention: the generated script ends with ROLLBACK unless commit is
explicitly requested, and it opens with a guard that re-verifies — at
execution time, inside the transaction — that the packet's source is
registered with a current research-only or approved terms review. Inserts
use ON CONFLICT (canonical_key) DO NOTHING so a rerun or an overlapping
later packet can never duplicate or rewrite identity rows.
"""

from __future__ import annotations

from typing import Mapping, Sequence


def _literal(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def _rows(entries: Sequence[Mapping[str, object]], columns: Sequence[str]) -> str:
    return ",\n".join(
        "(" + ", ".join(_literal(entry.get(column)) for column in columns) + ")"
        for entry in entries
    )


def build_catalog_seed_sql(packet: Mapping[str, object], *, commit: bool = False) -> str:
    if not isinstance(packet, Mapping) or packet.get("mode") != "research_only_catalog_seed":
        raise ValueError("packet must be a research_only_catalog_seed packet")
    if packet.get("review_required") is not True or packet.get("public_display_candidates") != []:
        raise ValueError("packet must be review-gated with no public display candidates")
    rights = packet.get("rights")
    if not isinstance(rights, Mapping) or not str(rights.get("source_code") or "").strip():
        raise ValueError("packet rights must name the reviewed source")
    rows = packet.get("rows")
    if not isinstance(rows, Mapping):
        raise ValueError("packet rows are missing")
    sets = rows.get("catalog_sets") or []
    cards = rows.get("catalog_cards") or []
    variants = rows.get("catalog_variants") or []
    if not sets or not cards or not variants:
        raise ValueError("packet must contain set, card, and variant rows")

    source_code = _literal(rights["source_code"])
    pieces = [
        "-- Generated from a research_only_catalog_seed packet"
        f" (hash {str(packet.get('packet_hash', ''))[:16]}...).",
        "begin;",
        # Execution-time re-verification: the registered review must still be
        # current and non-rejected when this script actually runs.
        f"""do $guard$
begin
  if not exists (
    select 1
    from public.data_sources source
    join public.source_terms_reviews review
      on review.id = source.current_terms_review_id
    where source.code = {source_code}
      and source.active
      and review.decision in ('research_only', 'approved')
      and (review.expires_at is null or review.expires_at > now())
  ) then
    raise exception 'Catalog seed source % lacks a current usable terms review', {source_code};
  end if;
end;
$guard$;""",
        "insert into public.catalog_sets (id, canonical_key, game, name, series, language, release_date)\nvalues\n"
        + _rows(sets, ("id", "canonical_key", "game", "name", "series", "language", "release_date"))
        + "\non conflict (canonical_key) do nothing;",
        "insert into public.catalog_cards (id, set_id, canonical_key, name, number, rarity, artist, release_date)\nvalues\n"
        + _rows(cards, ("id", "set_id", "canonical_key", "name", "number", "rarity", "artist", "release_date"))
        + "\non conflict (canonical_key) do nothing;",
        "insert into public.catalog_variants (id, card_id, canonical_key, language, edition, finish, variant_name, raw_condition_class)\nvalues\n"
        + _rows(variants, ("id", "card_id", "canonical_key", "language", "edition", "finish", "variant_name", "raw_condition_class"))
        + "\non conflict (canonical_key) do nothing;",
        "commit;" if commit else "rollback; -- rehearsal by default; regenerate with commit for the real run",
    ]
    return "\n\n".join(pieces) + "\n"
