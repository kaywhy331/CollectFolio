"""CLI for reviewed, rollback-first mapping supersession SQL."""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
from typing import Mapping, Sequence

from .mapping_supersession_sql import build_mapping_supersession_sql


def _verify_review_document(manifest: Mapping[str, object], repo_root: Path) -> None:
    review = manifest.get("review")
    if not isinstance(review, Mapping):
        raise ValueError("manifest review is missing")
    document = review.get("document")
    expected = review.get("document_sha256")
    if not isinstance(document, str) or not isinstance(expected, str):
        raise ValueError("manifest review document and hash are required")
    path = (repo_root / document).resolve()
    try:
        path.relative_to(repo_root.resolve())
    except ValueError as exc:
        raise ValueError("review document must remain inside the repository") from exc
    actual = sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError("mapping review document hash is stale")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate guarded SQL for one reviewed mapping supersession.",
    )
    parser.add_argument("manifest", help="reviewed mapping supersession JSON path")
    parser.add_argument("output", help="new mode-0600 SQL path; existing files are refused")
    parser.add_argument(
        "--repo-root",
        default=".",
        help="repository root used to resolve the immutable review document",
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="end with COMMIT; the default is a rollback rehearsal",
    )
    args = parser.parse_args(argv)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    _verify_review_document(manifest, Path(args.repo_root))
    sql = build_mapping_supersession_sql(manifest, commit=args.commit)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(sql)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
