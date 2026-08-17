"""Operator CLI for the resumable trajectory-v1 TCGCSV archive panel builder.

Subcommands:
  probe-date   bounded HEAD probe of one archive date (size/availability, no download)
  plan-dates   print the exact-interval date list a backfill would target (no network)
  backfill     resumable download + single-pass 7z extract + panel build across a date range
  report       rebuild the committed receipts from local panel state, no network access

`backfill` is safe to interrupt and rerun: completed dates are recorded in
`<panel-dir>/state.json` and are skipped without refetching; a partially
downloaded archive on disk is reused instead of refetched.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence

from .tcgcsv_panel import (
    ARCHIVE_INTERVAL_DAYS,
    DEFAULT_BASE_URL,
    DEFAULT_CATEGORY_IDS,
    DEFAULT_MIN_FREE_BYTES,
    DEFAULT_USER_AGENT,
    PANEL_CONTRACT_VERSION,
    TCGCSVPanelError,
    TCGCSVPanelUnavailable,
    ensure_free_disk,
    plan_weekly_dates,
    probe_archive_date,
    process_archive_date,
    summarize_panel,
)


def _load_state(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {"contractVersion": PANEL_CONTRACT_VERSION, "categoryIds": [], "dates": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def _save_state(path: Path, state: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(
        json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)


def _category_ids(args: argparse.Namespace) -> tuple[int, ...]:
    return tuple(args.category_id) if args.category_id else DEFAULT_CATEGORY_IDS


def _planned_dates(args: argparse.Namespace) -> tuple[date, ...]:
    start = date.fromisoformat(args.start_date)
    end = date.fromisoformat(args.end_date) if args.end_date else None
    return plan_weekly_dates(
        start, count=args.count, end_date=end, interval_days=args.interval_days,
    )


def _probe_command(args: argparse.Namespace) -> int:
    probe = probe_archive_date(
        date.fromisoformat(args.date),
        base_url=args.base_url,
        user_agent=args.user_agent,
        timeout_seconds=args.timeout_seconds,
    )
    print(json.dumps(probe.as_dict(), indent=2, sort_keys=True))
    return 0 if probe.available else 1


def _plan_command(args: argparse.Namespace) -> int:
    planned = _planned_dates(args)
    payload = {
        "intervalDays": args.interval_days,
        "count": len(planned),
        "spanDays": (planned[-1] - planned[0]).days if len(planned) > 1 else 0,
        "dates": [item.isoformat() for item in planned],
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def _render_markdown(summary: Mapping[str, object]) -> str:
    coverage = summary["coverage"]
    lines = [
        "# TCGCSV weekly archive panel -- coverage summary",
        "",
        f"- Generated at: {summary['generatedAt']}",
        f"- Category IDs: {summary['categoryIds']}",
        (
            f"- Dates planned / completed / unavailable / failed: "
            f"{coverage['datesPlanned']} / {coverage['datesCompleted']} / "
            f"{coverage['datesUnavailable']} / {coverage['datesFailed']}"
        ),
        (
            f"- Span: {coverage['earliestCompletedDate']} .. {coverage['latestCompletedDate']} "
            f"({coverage['spanDays']} days)"
        ),
        f"- Total archive bytes downloaded: {coverage['totalArchiveBytesDownloaded']}",
        "",
        "| Category | Dates covered | Rows | Distinct variants | Earliest | Latest |",
        "|---|---|---|---|---|---|",
    ]
    for category_id in summary["categoryIds"]:
        row = coverage["perCategory"].get(str(category_id), {})
        lines.append(
            f"| {category_id} | {row.get('datesCovered')} | {row.get('rowCount')} | "
            f"{row.get('variantCount')} | {row.get('earliestDate')} | {row.get('latestDate')} |"
        )
    lines.append("")
    return "\n".join(lines)


def _write_receipts(
    state: Mapping[str, object],
    panel_dir: Path,
    category_ids: Sequence[int],
    receipts_dir: Path,
    receipt_name: str,
    *,
    pretty: bool,
) -> dict[str, object]:
    dates_state = dict(state.get("dates") or {})
    entries: list[dict[str, object]] = []
    completed = unavailable = failed = 0
    total_archive_bytes = 0
    for key in sorted(dates_state):
        entry = dict(dates_state[key])
        entry["archiveDate"] = key
        status = entry.get("status")
        if status == "completed":
            completed += 1
            total_archive_bytes += int(entry.get("archiveBytes") or 0)
        elif status == "unavailable":
            unavailable += 1
        elif status == "failed":
            failed += 1
        entries.append(entry)

    completed_dates = sorted(key for key, value in dates_state.items() if value.get("status") == "completed")
    span_days = None
    if len(completed_dates) >= 1:
        span_days = (date.fromisoformat(completed_dates[-1]) - date.fromisoformat(completed_dates[0])).days

    category_summaries = summarize_panel(panel_dir, category_ids)

    summary = {
        "contractVersion": PANEL_CONTRACT_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "categoryIds": list(category_ids),
        "dates": entries,
        "coverage": {
            "datesPlanned": len(entries),
            "datesCompleted": completed,
            "datesUnavailable": unavailable,
            "datesFailed": failed,
            "earliestCompletedDate": completed_dates[0] if completed_dates else None,
            "latestCompletedDate": completed_dates[-1] if completed_dates else None,
            "spanDays": span_days,
            "totalArchiveBytesDownloaded": total_archive_bytes,
            "perCategory": {str(item.category_id): item.as_dict() for item in category_summaries},
        },
    }

    receipts_dir.mkdir(parents=True, exist_ok=True)
    json_path = receipts_dir / f"{receipt_name}.json"
    json_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2 if pretty else None, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    md_path = receipts_dir / f"{receipt_name}.md"
    md_path.write_text(_render_markdown(summary), encoding="utf-8")
    return summary


def _backfill_command(args: argparse.Namespace) -> int:
    category_ids = _category_ids(args)
    planned = _planned_dates(args)
    archive_dir = Path(args.archive_dir)
    panel_dir = Path(args.panel_dir)
    state_path = Path(args.state_file) if args.state_file else panel_dir / "state.json"

    state = _load_state(state_path)
    state["contractVersion"] = PANEL_CONTRACT_VERSION
    state["categoryIds"] = list(category_ids)
    dates_state = state.setdefault("dates", {})

    for day in planned:
        key = day.isoformat()
        entry = dates_state.get(key)
        if isinstance(entry, dict) and entry.get("status") == "completed":
            print(f"[skip] {key} already completed (resume, no refetch)")
            continue

        attempts = 0
        while attempts < args.max_attempts:
            attempts += 1
            try:
                ensure_free_disk(archive_dir, args.min_free_bytes)
                receipt = process_archive_date(
                    day,
                    category_ids,
                    archive_dir=archive_dir,
                    panel_dir=panel_dir,
                    base_url=args.base_url,
                    user_agent=args.user_agent,
                    timeout_seconds=args.timeout_seconds,
                )
            except TCGCSVPanelUnavailable as exc:
                dates_state[key] = {
                    "status": "unavailable",
                    "error": str(exc),
                    "attempts": attempts,
                    "lastAttemptAt": datetime.now(timezone.utc).isoformat(),
                }
                _save_state(state_path, state)
                print(f"[unavailable] {key} {exc}")
                break
            except Exception as exc:  # noqa: BLE001 - a bad date must not kill the backfill loop
                print(f"[retry] {key} attempt={attempts}/{args.max_attempts} error={exc}")
                if attempts >= args.max_attempts:
                    dates_state[key] = {
                        "status": "failed",
                        "error": str(exc),
                        "attempts": attempts,
                        "lastAttemptAt": datetime.now(timezone.utc).isoformat(),
                    }
                    _save_state(state_path, state)
                    print(f"[failed] {key} {exc}")
                else:
                    time.sleep(args.retry_delay_seconds * attempts)
            else:
                record = receipt.as_dict()
                record["status"] = "completed"
                record["attempts"] = attempts
                record["completedAt"] = datetime.now(timezone.utc).isoformat()
                dates_state[key] = record
                _save_state(state_path, state)
                total_rows = sum(item["rowCount"] for item in receipt.categories.values())
                print(f"[ok] {key} archiveBytes={receipt.archive_bytes} rows={total_rows} attempts={attempts}")
                break

        if args.sleep_between_dates_seconds > 0:
            time.sleep(args.sleep_between_dates_seconds)

    summary = _write_receipts(
        state, panel_dir, category_ids, Path(args.receipts_dir), args.receipt_name, pretty=True,
    )
    coverage = summary["coverage"]
    print(
        "[done] planned={0} completed={1} unavailable={2} failed={3}".format(
            coverage["datesPlanned"], coverage["datesCompleted"],
            coverage["datesUnavailable"], coverage["datesFailed"],
        )
    )
    return 0


def _report_command(args: argparse.Namespace) -> int:
    category_ids = _category_ids(args)
    panel_dir = Path(args.panel_dir)
    state_path = Path(args.state_file) if args.state_file else panel_dir / "state.json"
    state = _load_state(state_path)
    summary = _write_receipts(
        state, panel_dir, category_ids, Path(args.receipts_dir), args.receipt_name,
        pretty=not args.compact,
    )
    print(json.dumps(summary["coverage"], indent=2, sort_keys=True))
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Resumable weekly TCGCSV archive panel builder for trajectory-v1 (PRD Data "
            "Contract, section 3 / task T1). Each archive date is downloaded once, every "
            "scoped category is extracted in a single 7z pass, and per-variant weekly rows "
            "are appended as compact gzip JSONL under analytics/data/panel/. "
            "`backfill` persists progress to <panel-dir>/state.json after every date so an "
            "interrupted run resumes without refetching completed dates or re-downloading an "
            "archive that already finished downloading."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    probe = subparsers.add_parser(
        "probe-date",
        help="bounded HEAD probe of one archive date's size and availability (no download)",
    )
    probe.add_argument("date", help="archive date, YYYY-MM-DD")
    probe.add_argument("--base-url", default=DEFAULT_BASE_URL)
    probe.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    probe.add_argument("--timeout-seconds", type=float, default=20.0)
    probe.set_defaults(handler=_probe_command)

    plan = subparsers.add_parser(
        "plan-dates",
        help="print the exact-interval archive dates a backfill would target (no network)",
    )
    plan.add_argument("--start-date", required=True)
    plan_span = plan.add_mutually_exclusive_group(required=True)
    plan_span.add_argument("--count", type=int, help="number of weekly samples")
    plan_span.add_argument("--end-date", help="inclusive end date, must align to --interval-days")
    plan.add_argument("--interval-days", type=int, default=ARCHIVE_INTERVAL_DAYS)
    plan.set_defaults(handler=_plan_command)

    backfill = subparsers.add_parser(
        "backfill",
        help="resumable download + single-pass 7z extract + panel build across a planned date range",
    )
    backfill.add_argument("--start-date", required=True)
    backfill_span = backfill.add_mutually_exclusive_group(required=True)
    backfill_span.add_argument("--count", type=int, help="number of weekly samples")
    backfill_span.add_argument("--end-date", help="inclusive end date, must align to --interval-days")
    backfill.add_argument("--interval-days", type=int, default=ARCHIVE_INTERVAL_DAYS)
    backfill.add_argument(
        "--category-id", action="append", type=int,
        help=f"repeatable; defaults to {list(DEFAULT_CATEGORY_IDS)}",
    )
    backfill.add_argument("--archive-dir", default="analytics/data/archives")
    backfill.add_argument("--panel-dir", default="analytics/data/panel")
    backfill.add_argument("--state-file", help="defaults to <panel-dir>/state.json")
    backfill.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    backfill.add_argument("--receipt-name", default="panel-coverage-summary")
    backfill.add_argument("--base-url", default=DEFAULT_BASE_URL)
    backfill.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    backfill.add_argument("--timeout-seconds", type=float, default=60.0)
    backfill.add_argument("--max-attempts", type=int, default=3, help="retries per date on transient failure")
    backfill.add_argument("--retry-delay-seconds", type=float, default=5.0)
    backfill.add_argument("--sleep-between-dates-seconds", type=float, default=1.0, help="politeness pacing")
    backfill.add_argument("--min-free-bytes", type=int, default=DEFAULT_MIN_FREE_BYTES)
    backfill.set_defaults(handler=_backfill_command)

    report = subparsers.add_parser(
        "report",
        help="rebuild the committed receipts from local panel state; touches no network",
    )
    report.add_argument(
        "--category-id", action="append", type=int,
        help=f"repeatable; defaults to {list(DEFAULT_CATEGORY_IDS)}",
    )
    report.add_argument("--panel-dir", default="analytics/data/panel")
    report.add_argument("--state-file", help="defaults to <panel-dir>/state.json")
    report.add_argument("--receipts-dir", default="docs/receipts/trajectory-v1")
    report.add_argument("--receipt-name", default="panel-coverage-summary")
    report.add_argument("--compact", action="store_true", help="write compact JSON instead of indented")
    report.set_defaults(handler=_report_command)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except (OSError, ValueError, RuntimeError, TCGCSVPanelError) as exc:
        print(f"tcgcsv-panel: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
