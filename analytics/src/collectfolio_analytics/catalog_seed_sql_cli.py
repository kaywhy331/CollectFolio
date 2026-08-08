"""CLI for rollback-first catalog seed SQL generation."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Sequence

from .catalog_seed_sql import build_catalog_seed_sql


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate guarded, idempotent SQL from a catalog seed packet.",
    )
    parser.add_argument("packet", help="catalog seed packet JSON path")
    parser.add_argument("output", help="new mode-0600 SQL path; existing files are refused")
    parser.add_argument(
        "--commit",
        action="store_true",
        help="end with COMMIT; the default is a rollback rehearsal",
    )
    args = parser.parse_args(argv)
    packet = json.loads(Path(args.packet).read_text(encoding="utf-8"))
    sql = build_catalog_seed_sql(packet, commit=args.commit)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(sql)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
