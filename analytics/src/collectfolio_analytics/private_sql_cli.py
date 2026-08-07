"""CLI for guarded private-evidence SQL generation."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Mapping, Sequence

from .private_sql import build_private_evidence_sql


def _packet(path: str) -> Mapping[str, object]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, Mapping):
        raise ValueError("operator packet must be an object")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate guarded SQL for private research evidence.",
    )
    parser.add_argument("packet", help="operator packet JSON path")
    parser.add_argument("output", help="new SQL output path; existing files are refused")
    parser.add_argument(
        "--commit",
        action="store_true",
        help="end with COMMIT; the default is a rollback rehearsal",
    )
    args = parser.parse_args(argv)
    sql = build_private_evidence_sql(_packet(args.packet), commit=args.commit)
    descriptor = os.open(
        args.output,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(sql)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
