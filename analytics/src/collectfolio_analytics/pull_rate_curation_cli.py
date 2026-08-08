"""CLI for producing a deterministic migration-0009 curation packet."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Mapping, Sequence

from .pull_rate_curation import build_curated_pull_rate_packet
from .pull_rate_source_verify import verify_manifest_source_snapshots


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a checked-in pull-rate curation manifest and emit a "
            "permission-restricted, no-write registry packet."
        ),
    )
    parser.add_argument("manifest", help="research_only_pull_rate_curation JSON path")
    parser.add_argument("output", help="new mode-0600 packet path; existing files are refused")
    parser.add_argument(
        "--verify-sources",
        action="store_true",
        help="fetch each bounded public article API record and require its identity/body hash to match",
    )
    args = parser.parse_args(argv)

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if not isinstance(manifest, Mapping):
        raise ValueError("manifest must be a JSON object")
    packet = build_curated_pull_rate_packet(manifest)
    if args.verify_sources:
        verified = verify_manifest_source_snapshots(manifest)
        print(f"verified {len(verified)} immutable article snapshots")
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(packet, output, ensure_ascii=False, indent=2)
        output.write("\n")
    counts = packet["counts"]
    print(
        "pull-rate packet: "
        f"{counts['sources']} sources, {counts['entries']} entries, "
        f"{counts['covered_sets']}/{counts['target_sets']} sets covered -> {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
