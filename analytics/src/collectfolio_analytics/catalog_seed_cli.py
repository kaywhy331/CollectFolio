"""CLI for building a rights-gated catalog seed packet from local files."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from typing import Mapping, Sequence

from .catalog_seed import CatalogSeedRights, build_catalog_seed_packet


def _load(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Build a reviewable catalog seed packet from an operator-downloaded "
            "pokemon-tcg-data-shaped export. Performs no network access and no "
            "database writes."
        ),
    )
    parser.add_argument("manifest", help="JSON manifest with rights, sets_path, cards_dir, set_ids")
    parser.add_argument("output", help="new mode-0600 packet path; existing files are refused")
    args = parser.parse_args(argv)

    manifest = _load(Path(args.manifest))
    if not isinstance(manifest, Mapping):
        raise ValueError("manifest must be a JSON object")
    rights = CatalogSeedRights(**manifest["rights"])
    manifest_dir = Path(args.manifest).resolve().parent
    sets_path = (manifest_dir / str(manifest["sets_path"])).resolve()
    cards_dir = (manifest_dir / str(manifest["cards_dir"])).resolve()
    set_ids = manifest.get("set_ids")
    if not isinstance(set_ids, list) or not set_ids or not all(isinstance(v, str) and v for v in set_ids):
        raise ValueError("manifest set_ids must be a non-empty list of set-code strings")

    all_sets = _load(sets_path)
    if not isinstance(all_sets, list):
        raise ValueError("sets file must contain a JSON array")
    wanted = {code: None for code in set_ids}
    selected = [entry for entry in all_sets if isinstance(entry, Mapping) and entry.get("id") in wanted]
    missing = set(set_ids) - {entry.get("id") for entry in selected}
    if missing:
        raise ValueError(f"sets file is missing declared set ids: {sorted(missing)}")

    cards_by_set = {code: _load(cards_dir / f"{code}.json") for code in set_ids}
    packet = build_catalog_seed_packet(
        rights, selected, cards_by_set, generated_at=datetime.now(timezone.utc)
    )

    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(packet, output, ensure_ascii=False, indent=2)
        output.write("\n")
    counts = packet["counts"]
    print(f"catalog seed packet: {counts['sets']} sets, {counts['cards']} cards, {counts['variants']} placeholder variants -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
