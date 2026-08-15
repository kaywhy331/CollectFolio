"""Compile a private current-origin TCGCSV Structural Gap Lab packet."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Mapping, Sequence

from .structural_gap import compile_structural_gap_lab
from .tcgcsv_universe import TCGCSVUniverseError, canonical_json


def _read_object(path: str | Path) -> Mapping[str, object]:
    with Path(path).open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, Mapping):
        raise TCGCSVUniverseError(f"{path} must contain a JSON object")
    return value


def _write_new(path: str | Path, value: object, *, pretty: bool) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(target, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            if pretty:
                json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
                handle.write("\n")
            else:
                handle.write(canonical_json(value) + "\n")
    except Exception:
        target.unlink(missing_ok=True)
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--features", required=True)
    parser.add_argument("--archive-packet", required=True)
    parser.add_argument("--catalog-snapshot", required=True)
    parser.add_argument("--prior-packet", action="append", default=[])
    parser.add_argument("--output", required=True)
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        packet = compile_structural_gap_lab(
            args.features,
            _read_object(args.archive_packet),
            _read_object(args.catalog_snapshot),
            prior_packets=tuple(_read_object(path) for path in args.prior_packet),
        )
        _write_new(args.output, packet, pretty=args.pretty)
        print(canonical_json({
            "output": str(Path(args.output).resolve()),
            "labStatus": packet["labStatus"],
            "reasonCodes": packet["reasonCodes"],
            "pricedSeriesCount": packet["pricedSeriesCount"],
            "completeGroupCount": packet["completeGroupCount"],
            "packetContentSha256": packet["packetContentSha256"],
        }))
        return 0
    except (OSError, ValueError, RuntimeError, TCGCSVUniverseError) as exc:
        print(f"structural-gap-lab: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
