#!/usr/bin/env python3
"""Exercise the private forecast receipt contract against a disposable PostgreSQL DB."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from collectfolio_analytics.prospective import (
    prepare_prospective_candidate,
    sign_execution_receipt,
)


ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "supabase" / "migrations"
FIXTURE = ROOT / "tests" / "postgres" / "forecast-runtime-fixture.sql"
SCORECARD_FIXTURE = ROOT / "tests" / "postgres" / "forecast-scorecard-fixture.sql"
PSQL = os.environ.get("COLLECTFOLIO_PSQL", "psql")
PSQL_ARGS = (PSQL, "-X", "-qAt", "-v", "ON_ERROR_STOP=1")
FORECAST_RUN_ID = "00000000-0000-0000-0000-000000000113"
TREND_RUN_ID = "00000000-0000-0000-0000-000000000112"
SNAPSHOT_ID = "00000000-0000-0000-0000-000000000114"
SERIES_ID = "00000000-0000-0000-0000-000000000107"
TERMS_REVIEW_ID = "00000000-0000-0000-0000-000000000102"
HMAC_SECRET = bytes.fromhex("ab" * 32)
LOCK_SENTINEL = 841_337_001
SCORECARD_LOCK_SENTINEL = 841_337_002


class RuntimeTestFailure(RuntimeError):
    pass


def run_psql(
    sql: str | None = None,
    *,
    file: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    if (sql is None) == (file is None):
        raise ValueError("provide exactly one of sql or file")
    command = list(PSQL_ARGS)
    if file is not None:
        command.extend(("-f", str(file)))
    result = subprocess.run(
        command,
        input=sql,
        text=True,
        capture_output=True,
        env=os.environ,
        check=False,
    )
    if check and result.returncode:
        target = str(file) if file is not None else "SQL input"
        raise RuntimeTestFailure(
            f"psql failed for {target}:\n{result.stderr.strip()}"
        )
    return result


def scalar(sql: str) -> str:
    result = run_psql(sql)
    values = [line for line in result.stdout.splitlines() if line.strip()]
    if not values:
        raise RuntimeTestFailure("query returned no scalar value")
    return values[-1]


def expect_failure(sql: str, expected: str) -> None:
    result = run_psql(sql, check=False)
    if result.returncode == 0:
        raise RuntimeTestFailure(f"SQL unexpectedly succeeded; wanted {expected!r}")
    combined = f"{result.stdout}\n{result.stderr}".lower()
    if expected.lower() not in combined:
        raise RuntimeTestFailure(
            f"SQL failed without {expected!r}:\n{combined.strip()}"
        )


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def json_literal(value: object, tag: str) -> str:
    rendered = json.dumps(value, separators=(",", ":"), allow_nan=False)
    delimiter = f"${tag}$"
    if delimiter in rendered:
        raise RuntimeTestFailure(f"JSON unexpectedly contains delimiter {delimiter}")
    return f"{delimiter}{rendered}{delimiter}::jsonb"


def bootstrap_database() -> bool:
    database_name = os.environ.get("PGDATABASE", "")
    if not database_name:
        raise RuntimeTestFailure("PGDATABASE must identify a fresh disposable database")
    if os.environ.get("COLLECTFOLIO_FORECAST_DB_TEST") != database_name:
        raise RuntimeTestFailure(
            "COLLECTFOLIO_FORECAST_DB_TEST must exactly match PGDATABASE to "
            "acknowledge the isolated disposable cluster and database"
        )
    public_tables = int(scalar(
        "select count(*) from information_schema.tables "
        "where table_schema = 'public' and table_type = 'BASE TABLE';"
    ))
    if public_tables:
        raise RuntimeTestFailure(
            f"refusing non-empty database {database_name!r}: {public_tables} public tables"
        )
    server_version = int(scalar("show server_version_num;"))
    if server_version < 150000:
        raise RuntimeTestFailure("forecast runtime tests require PostgreSQL 15 or newer")

    run_psql("""
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  elsif exists (
    select 1 from pg_roles where rolname = 'anon' and rolcanlogin
  ) then
    raise exception 'Runtime harness refuses an existing login-capable anon role';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  elsif exists (
    select 1 from pg_roles where rolname = 'authenticated' and rolcanlogin
  ) then
    raise exception 'Runtime harness refuses an existing login-capable authenticated role';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  elsif exists (
    select 1 from pg_roles
    where rolname = 'service_role' and (rolcanlogin or not rolbypassrls)
  ) then
    raise exception 'Runtime harness refuses to alter an existing service_role';
  end if;
end;
$$;
create schema auth;
create table auth.users (
  id uuid primary key,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid()
returns uuid language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.jwt()
returns jsonb language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt()
  to anon, authenticated, service_role;
""")

    pgcrypto_library = os.environ.get("COLLECTFOLIO_PGCRYPTO_LIBRARY")
    if not pgcrypto_library:
        run_psql("create extension if not exists pgcrypto;")
        return False
    library_path = Path(pgcrypto_library)
    if not library_path.is_absolute():
        raise RuntimeTestFailure("COLLECTFOLIO_PGCRYPTO_LIBRARY must be absolute")
    if not library_path.exists() and not Path(f"{library_path}.so").exists():
        raise RuntimeTestFailure(f"pgcrypto library is absent: {library_path}")
    library_sql = sql_literal(str(library_path))
    run_psql(f"""
create function public.digest(text, text)
returns bytea as {library_sql}, 'pg_digest'
language c immutable strict parallel safe;
create function public.digest(bytea, text)
returns bytea as {library_sql}, 'pg_digest'
language c immutable strict parallel safe;
create function public.hmac(text, text, text)
returns bytea as {library_sql}, 'pg_hmac'
language c immutable strict parallel safe;
create function public.hmac(bytea, bytea, text)
returns bytea as {library_sql}, 'pg_hmac'
language c immutable strict parallel safe;
create function public.gen_random_bytes(int4)
returns bytea as {library_sql}, 'pg_random_bytes'
language c volatile strict parallel safe;
""")
    return True


def apply_migrations(manual_pgcrypto: bool) -> None:
    for migration in sorted(MIGRATIONS.glob("*.sql")):
        if migration.name == "0008_demand_aggregation_schedule.sql":
            continue
        if manual_pgcrypto and migration.name == "0001_initial.sql":
            source = migration.read_text(encoding="utf-8")
            extension_line = "create extension if not exists pgcrypto;\n"
            if source.count(extension_line) != 1:
                raise RuntimeTestFailure("migration 0001 pgcrypto statement changed")
            result = run_psql(source.replace(extension_line, "", 1), check=False)
            if result.returncode:
                raise RuntimeTestFailure(
                    f"migration {migration.name} failed:\n{result.stderr.strip()}"
                )
            continue
        result = run_psql(file=migration, check=False)
        if result.returncode:
            raise RuntimeTestFailure(
                f"migration {migration.name} failed:\n{result.stderr.strip()}"
            )


def create_challenge() -> dict[str, object]:
    seconds = float(scalar(
        "select greatest(extract(epoch from origin_start - clock_timestamp()), 0) "
        "from public.prospective_scorecard_plans limit 1;"
    ))
    if seconds:
        time.sleep(seconds + 0.05)
    payload = scalar(f"""
set role service_role;
select public.begin_prospective_forecast_execution(jsonb_build_object(
  'scorecardPlanId', (
    select id from public.prospective_scorecard_plans limit 1
  ),
  'forecastAnalyticsRunId', '{FORECAST_RUN_ID}',
  'trendAnalyticsRunId', '{TREND_RUN_ID}'
))::text;
reset role;
""")
    return json.loads(payload)


def candidate_payload(challenge: dict[str, object]) -> dict[str, object]:
    identity_hash = scalar(
        f"select identity_hash from public.market_series where id = '{SERIES_ID}';"
    )
    return prepare_prospective_candidate(
        {
            "trendSnapshotId": SNAPSHOT_ID,
            "q10": 80,
            "q25": 90,
            "q50": 110,
            "q75": 125,
            "q90": 140,
            "probabilityUp": 0.7,
            "confidence": 61.5,
            "predictionStatus": "research_only",
            "reasonCodes": ["runtime_fixture"],
            "costQuote": {
                "status": "complete",
                "semantics": "provider_listing",
                "quoteMarketSeriesId": SERIES_ID,
                "termsReviewId": TERMS_REVIEW_ID,
                "externalQuoteId": "runtime-listing-1",
                "observedAt": challenge["issuedAt"],
                "evidenceHash": "a" * 64,
                "offerPrice": 75,
                "taxRate": 0.08,
                "buyShipping": 0,
                "sellFeeRate": 0.13,
                "sellFeeFixed": 0,
                "sellShipping": 0,
                "liquidityStatus": "source_backed",
                "liquidityHaircutRate": 0.1,
                "liquidityEvidenceHash": "b" * 64,
            },
        },
        market_series_identity_hash=identity_hash,
        baseline_prices={
            "no_change": 100,
            "damped_momentum": 105,
            "market_index": 103,
            "lifecycle_cohort": 107,
            "structural_convergence": 108,
        },
        probability_net_positive=0.74,
        structural_lower_price=95,
    )


def sign(
    challenge: dict[str, object], candidate: dict[str, object]
) -> tuple[dict[str, str], str]:
    started = datetime.now(timezone.utc)
    return sign_execution_receipt(
        HMAC_SECRET,
        challenge,
        [candidate],
        execution_started_at=started,
        execution_completed_at=datetime.now(timezone.utc),
    )


def recording_sql(
    execution: dict[str, str], candidate: dict[str, object]
) -> str:
    return f"""
set role service_role;
select public.record_challenged_prospective_forecast_run(
  {json_literal(execution, 'execution')},
  {json_literal([candidate], 'candidates')}
)::text;
reset role;
"""


def assert_candidate_rejections(
    challenge: dict[str, object], candidate: dict[str, object]
) -> None:
    nan_candidate = deepcopy(candidate)
    nan_quote = {
        "status": "complete",
        "semantics": "user_entered_offer",
        "observedAt": challenge["issuedAt"],
        "evidenceHash": "a" * 64,
        "offerPrice": "NaN",
        "taxRate": "0",
        "buyShipping": "0",
        "sellFeeRate": "0.1",
        "sellFeeFixed": "0",
        "sellShipping": "0",
        "liquidityStatus": "unknown",
        "liquidityHaircutRate": None,
        "liquidityEvidenceHash": None,
    }
    nan_candidate["costQuote"] = nan_quote
    nan_candidate["costQuoteHash"] = scalar(
        "select public.canonical_prospective_cost_quote_hash("
        f"{json_literal(nan_quote, 'quote')});"
    )
    valid_execution, _ = sign(challenge, candidate)
    expect_failure(
        recording_sql(valid_execution, nan_candidate),
        "Challenged outputs contain malformed, ambiguous, or unsupported fields",
    )

    missing_reason = deepcopy(candidate)
    missing_reason["reasonCodes"].remove("public_forecast_disabled")
    invalid_execution, _ = sign(challenge, missing_reason)
    expect_failure(
        recording_sql(invalid_execution, missing_reason),
        "Challenged outputs contain malformed, ambiguous, or unsupported fields",
    )


def challenged_run_state() -> dict[str, object]:
    return json.loads(scalar(f"""
select jsonb_build_object(
  'runStatus', (
    select status from public.analytics_runs where id = '{FORECAST_RUN_ID}'::uuid
  ),
  'prospectiveRuns', (select count(*) from public.prospective_forecast_runs),
  'universes', (select count(*) from public.prospective_candidate_universes),
  'members', (select count(*) from public.prospective_candidate_universe_members),
  'costQuotes', (select count(*) from public.prospective_acquisition_cost_quotes),
  'predictions', (select count(*) from public.card_forecast_predictions),
  'receipts', (select count(*) from public.forecast_execution_receipts),
  'outputs', (select count(*) from public.prospective_prediction_outputs)
)::text;
"""))


def assert_terminal_trend_run_guard() -> None:
    expect_failure("""
set role service_role;
insert into public.trend_feature_snapshots
select (jsonb_populate_record(
  null::public.trend_feature_snapshots,
  to_jsonb(snapshot) || jsonb_build_object(
    'id', '00000000-0000-0000-0000-000000000198',
    'market_series_id', null,
    'snapshot_hash', repeat('f', 64),
    'created_at', clock_timestamp()
  )
)).*
from public.trend_feature_snapshots snapshot
where snapshot.id = '00000000-0000-0000-0000-000000000114'::uuid;
""", "Trend snapshots require a running unfinished trend_build analytics run")


def assert_acl_guards() -> None:
    for role in ("anon", "authenticated"):
        expect_failure(
            f"set role {role}; select count(*) "
            "from public.forecast_execution_receipts;",
            "permission denied",
        )
        expect_failure(
            f"set role {role}; select "
            "public.begin_prospective_forecast_execution('{}'::jsonb);",
            "permission denied for function",
        )
        expect_failure(
            f"set role {role}; select "
            "public.record_challenged_prospective_forecast_run("
            "'{}'::jsonb, '[]'::jsonb);",
            "permission denied for function",
        )
    expect_failure(
        "set role service_role; select "
        "public.record_prospective_forecast_run('{}'::jsonb, '[]'::jsonb);",
        "permission denied for function",
    )
    expect_failure(
        "set role service_role; delete from public.forecast_executor_keys "
        "where false;",
        "permission denied",
    )


def assert_hmac_rejections(
    challenge: dict[str, object], candidate: dict[str, object]
) -> None:
    clean_state = challenged_run_state()
    execution, _ = sign(challenge, candidate)
    tampered_candidate = deepcopy(candidate)
    tampered_candidate["q50"] = "111"
    expect_failure(
        recording_sql(execution, tampered_candidate),
        "Execution receipt signature was not produced by the independent executor key",
    )

    wrong_key_execution, _ = sign_execution_receipt(
        bytes.fromhex("cd" * 32),
        challenge,
        [candidate],
        execution_started_at=datetime.now(timezone.utc),
        execution_completed_at=datetime.now(timezone.utc),
    )
    expect_failure(
        recording_sql(wrong_key_execution, candidate),
        "Execution receipt signature was not produced by the independent executor key",
    )
    if challenged_run_state() != clean_state:
        raise RuntimeTestFailure("rejected HMAC attempts changed challenged-run state")


def assert_expired_challenge_rejection(
    challenge: dict[str, object], candidate: dict[str, object]
) -> None:
    clean_state = challenged_run_state()
    execution, _ = sign(challenge, candidate)
    # The disposable database owner temporarily backdates the immutable row in
    # an uncommitted transaction so the five-minute expiry branch is executable
    # without making the test sleep. The expected RPC error aborts the session,
    # rolling the timestamp change and trigger DDL back together.
    expect_failure(f"""
begin;
alter table public.forecast_execution_challenges
  disable trigger forecast_execution_challenges_append_only;
update public.forecast_execution_challenges
set issued_at = expired.issued_at,
    expires_at = expired.issued_at + interval '5 minutes',
    created_at = expired.issued_at
from (select clock_timestamp() - interval '6 minutes' as issued_at) expired
where id = {sql_literal(str(challenge['challengeId']))}::uuid;
alter table public.forecast_execution_challenges
  enable trigger forecast_execution_challenges_append_only;
{recording_sql(execution, candidate)}
""", "Execution challenge is absent, expired, or already consumed")
    if challenged_run_state() != clean_state:
        raise RuntimeTestFailure("expired receipt attempt changed challenged-run state")


def assert_late_receipt_rollback(
    challenge: dict[str, object], candidate: dict[str, object]
) -> None:
    clean_state = challenged_run_state()
    late_failure = deepcopy(candidate)
    late_failure["baselinePrices"]["no_change"] = "101"
    execution, _ = sign(challenge, late_failure)
    expect_failure(
        recording_sql(execution, late_failure),
        "No-change baseline must equal the immutable origin price",
    )
    if challenged_run_state() != clean_state:
        raise RuntimeTestFailure("late receipt failure left partial rows or run state")


def assert_lock_guard() -> None:
    lock_sql = f"""
begin;
select id from public.analytics_runs
where id = '{FORECAST_RUN_ID}'::uuid
for update;
select pg_advisory_lock({LOCK_SENTINEL});
select pg_sleep(1.25);
select pg_advisory_unlock({LOCK_SENTINEL});
commit;
"""
    lock_process = subprocess.Popen(
        PSQL_ARGS,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=os.environ,
    )
    assert lock_process.stdin is not None
    lock_process.stdin.write(lock_sql)
    lock_process.stdin.close()
    lock_process.stdin = None
    ready = False
    for _ in range(60):
        state = scalar(f"""
select case
  when pg_try_advisory_lock({LOCK_SENTINEL}) then
    pg_advisory_unlock({LOCK_SENTINEL}) and false
  else true
end;
""")
        if state == "t":
            ready = True
            break
        time.sleep(0.05)
    if not ready:
        lock_process.kill()
        raise RuntimeTestFailure("lock-holder session never became ready")

    started = time.monotonic()
    result = run_psql(f"""
set role service_role;
insert into public.card_forecast_predictions (id, analytics_run_id)
values (
  '00000000-0000-0000-0000-000000000199',
  '{FORECAST_RUN_ID}'
);
""", check=False)
    elapsed = time.monotonic() - started
    stdout, stderr = lock_process.communicate(timeout=5)
    if lock_process.returncode:
        raise RuntimeTestFailure(f"lock-holder failed:\n{stdout}\n{stderr}")
    if result.returncode == 0:
        raise RuntimeTestFailure("outside prediction insert unexpectedly succeeded")
    if "only inside its signed receipt transaction" not in result.stderr:
        raise RuntimeTestFailure(f"unexpected prediction guard error:\n{result.stderr}")
    if elapsed < 0.9:
        raise RuntimeTestFailure(
            f"prediction guard did not wait for the analytics-run lock ({elapsed:.3f}s)"
        )


def assert_successful_receipt(
    challenge: dict[str, object], candidate: dict[str, object]
) -> None:
    execution, output_hash = sign(challenge, candidate)
    receipt = json.loads(scalar(recording_sql(execution, candidate)))
    if receipt["canonicalOutputHash"] != output_hash:
        raise RuntimeTestFailure("RPC receipt hash differs from Python canonical hash")
    evidence = json.loads(scalar("""
select jsonb_build_object(
  'receiptCount', (select count(*) from public.forecast_execution_receipts),
  'predictionCount', (select count(*) from public.card_forecast_predictions),
  'runStatus', (
    select status from public.analytics_runs
    where id = '00000000-0000-0000-0000-000000000113'::uuid
  ),
  'storedHashMatches', (
    select receipt.canonical_output_hash =
      public.canonical_stored_prospective_output_hash(receipt.id)
    from public.forecast_execution_receipts receipt
  ),
  'mandatoryReasonsStored', (
    select reason_codes @> array[
      'operator_model_review_required',
      'private_prospective_shadow',
      'public_forecast_disabled'
    ]::text[]
    from public.card_forecast_predictions
  ),
  'artifactExecutionVerified', (
    select artifact_execution_verified
    from public.forecast_execution_receipts
  ),
  'completeCostStored', (
    select quote_status = 'complete'
      and quote_semantics = 'provider_listing'
      and liquidity_status = 'source_backed'
      and liquidity_adjusted_break_even_reference is not null
    from public.prospective_acquisition_cost_quotes
  ),
  'publicFlag', (
    select enabled from public.product_feature_flags
    where key = 'public_price_intelligence'
  )
)::text;
"""))
    expected = {
        "receiptCount": 1,
        "predictionCount": 1,
        "runStatus": "succeeded",
        "storedHashMatches": True,
        "mandatoryReasonsStored": True,
        "artifactExecutionVerified": False,
        "completeCostStored": True,
        "publicFlag": False,
    }
    if evidence != expected:
        raise RuntimeTestFailure(
            f"stored receipt evidence differs:\n{json.dumps(evidence, indent=2)}"
        )
    state_before_replay = challenged_run_state()
    expect_failure(
        recording_sql(execution, candidate),
        "Execution challenge is absent, expired, or already consumed",
    )
    if challenged_run_state() != state_before_replay:
        raise RuntimeTestFailure("replayed receipt changed stored challenged-run state")
    expect_failure(
        "set role service_role; update public.forecast_execution_receipts "
        "set receipt_hash = receipt_hash;",
        "permission denied",
    )


def synthetic_scorecard_ids() -> dict[str, str]:
    return json.loads(scalar("""
select jsonb_build_object(
  'planId', plan.id,
  'evaluationRunId', evaluation_run.id,
  'predictionId', (
    select prediction.id
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    join public.card_forecast_predictions prediction
      on prediction.prospective_run_id = receipt.prospective_run_id
    where challenge.scorecard_plan_id = plan.id
    order by prediction.origin
    limit 1
  )
)::text
from public.prospective_scorecard_plans plan
join public.model_versions model on model.id = plan.model_version_id
join public.analytics_runs evaluation_run
  on evaluation_run.config->>'prospectiveScorecardPlanId' = plan.id::text
where model.model_key = 'runtime-quantile-scorecard';
"""))


def scorecard_sql(ids: dict[str, str]) -> str:
    return f"""
set role service_role;
select public.create_prospective_model_scorecard(jsonb_build_object(
  'scorecardPlanId', {sql_literal(ids['planId'])}::uuid,
  'evaluationAnalyticsRunId', {sql_literal(ids['evaluationRunId'])}::uuid
));
reset role;
"""


def assert_scorecard_receipt_tamper_rejection(ids: dict[str, str]) -> None:
    if scalar(
        "select count(*) from public.model_scorecards "
        f"where prospective_scorecard_plan_id = {sql_literal(ids['planId'])}::uuid;"
    ) != "0":
        raise RuntimeTestFailure("synthetic plan was consumed before its tamper test")
    expect_failure(f"""
begin;
alter table public.forecast_execution_receipts
  disable trigger forecast_execution_receipts_append_only;
update public.forecast_execution_receipts receipt
set canonical_output_hash = repeat('f', 64),
    forecast_dataset_hash = repeat('f', 64)
from public.forecast_execution_challenges challenge
where challenge.id = receipt.challenge_id
  and challenge.scorecard_plan_id = {sql_literal(ids['planId'])}::uuid
  and challenge.origin_slot_index = 1;
alter table public.forecast_execution_receipts
  enable trigger forecast_execution_receipts_append_only;
{scorecard_sql(ids)}
""", "Prospective scorecard receipt hashes, counts, or attestation semantics are inconsistent")
    evidence = json.loads(scalar(f"""
select jsonb_build_object(
  'scorecards', (
    select count(*) from public.model_scorecards
    where prospective_scorecard_plan_id = {sql_literal(ids['planId'])}::uuid
  ),
  'storedHashesMatch', not exists (
    select 1
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    where challenge.scorecard_plan_id = {sql_literal(ids['planId'])}::uuid
      and receipt.canonical_output_hash is distinct from
          public.canonical_stored_prospective_output_hash(receipt.id)
  )
)::text;
"""))
    if evidence != {"scorecards": 0, "storedHashesMatch": True}:
        raise RuntimeTestFailure(
            f"receipt tamper rollback differed:\n{json.dumps(evidence, indent=2)}"
        )


def assert_scorecard_evaluation_race(ids: dict[str, str]) -> None:
    state_before = scalar(f"""
select jsonb_build_object(
  'count', count(*),
  'hashes', coalesce(jsonb_agg(evaluation_hash order by id), '[]'::jsonb)
)::text
from public.forecast_evaluations
where analytics_run_id = {sql_literal(ids['evaluationRunId'])}::uuid;
""")
    lock_sql = f"""
begin;
{scorecard_sql(ids)}
select pg_advisory_lock({SCORECARD_LOCK_SENTINEL});
select pg_sleep(1.25);
select pg_advisory_unlock({SCORECARD_LOCK_SENTINEL});
commit;
"""
    lock_process = subprocess.Popen(
        PSQL_ARGS,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=os.environ,
    )
    assert lock_process.stdin is not None
    lock_process.stdin.write(lock_sql)
    lock_process.stdin.close()
    lock_process.stdin = None
    ready = False
    for _ in range(100):
        state = scalar(f"""
select case
  when pg_try_advisory_lock({SCORECARD_LOCK_SENTINEL}) then
    pg_advisory_unlock({SCORECARD_LOCK_SENTINEL}) and false
  else true
end;
""")
        if state == "t":
            ready = True
            break
        if lock_process.poll() is not None:
            break
        time.sleep(0.05)
    if not ready:
        lock_process.kill()
        stdout, stderr = lock_process.communicate(timeout=5)
        raise RuntimeTestFailure(
            f"scorecard lock-holder never became ready:\n{stdout}\n{stderr}"
        )

    started = time.monotonic()
    late_result = run_psql(f"""
set role service_role;
select public.record_scored_forecast_evaluation(jsonb_build_object(
  'id', '00000000-0000-0000-0000-000000000398'::uuid,
  'analytics_run_id', {sql_literal(ids['evaluationRunId'])}::uuid,
  'prediction_id', {sql_literal(ids['predictionId'])}::uuid,
  'evaluated_at', (
    select completed_at from public.analytics_runs
    where id = {sql_literal(ids['evaluationRunId'])}::uuid
  )
));
""", check=False)
    elapsed = time.monotonic() - started
    stdout, stderr = lock_process.communicate(timeout=5)
    if lock_process.returncode:
        raise RuntimeTestFailure(f"scorecard lock-holder failed:\n{stdout}\n{stderr}")
    if late_result.returncode == 0:
        raise RuntimeTestFailure("late forecast evaluation unexpectedly succeeded")
    if "Prospective evaluation run is frozen after scorecard creation" not in late_result.stderr:
        raise RuntimeTestFailure(
            f"unexpected late-evaluation guard error:\n{late_result.stderr}"
        )
    if elapsed < 0.9:
        raise RuntimeTestFailure(
            f"late evaluation did not wait for scorecard serialization ({elapsed:.3f}s)"
        )
    state_after = scalar(f"""
select jsonb_build_object(
  'count', count(*),
  'hashes', coalesce(jsonb_agg(evaluation_hash order by id), '[]'::jsonb)
)::text
from public.forecast_evaluations
where analytics_run_id = {sql_literal(ids['evaluationRunId'])}::uuid;
""")
    if state_after != state_before:
        raise RuntimeTestFailure("late evaluation changed the frozen evaluation ledger")


def assert_synthetic_scorecard(ids: dict[str, str]) -> None:
    evidence = json.loads(scalar(f"""
with scorecard as (
  select * from public.model_scorecards
  where prospective_scorecard_plan_id = {sql_literal(ids['planId'])}::uuid
), recomputed_membership as (
  select encode(digest(string_agg(concat_ws('|',
    member.market_series_id::text, member.id::text, prediction.id::text,
    prediction.prediction_hash, evaluation.id::text,
    evaluation.evaluation_hash, receipt.id::text, receipt.receipt_hash,
    evaluation.evaluation_status,
    (
      prediction.prediction_status = 'research_only'
      and evaluation.evaluation_status = 'scored'
    )::text,
    case
      when prediction.prediction_status = 'quarantined'
        then 'quarantined_prediction_excluded'
      when evaluation.evaluation_status = 'unscorable'
        then 'unscorable_target_excluded'
      else ''
    end
  ), '||' order by prediction.origin, member.market_series_id, prediction.id),
  'sha256'), 'hex') as membership_hash
  from public.forecast_execution_challenges challenge
  join public.forecast_execution_receipts receipt
    on receipt.challenge_id = challenge.id
  join public.prospective_candidate_universe_members member
    on member.prospective_run_id = receipt.prospective_run_id
  join public.card_forecast_predictions prediction
    on prediction.prospective_candidate_member_id = member.id
  join public.forecast_evaluations evaluation
    on evaluation.prediction_id = prediction.id
   and evaluation.analytics_run_id = {sql_literal(ids['evaluationRunId'])}::uuid
  where challenge.scorecard_plan_id = {sql_literal(ids['planId'])}::uuid
)
select jsonb_build_object(
  'challengeCount', (
    select count(*) from public.forecast_execution_challenges
    where scorecard_plan_id = {sql_literal(ids['planId'])}::uuid
  ),
  'receiptCount', (
    select count(*)
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    where challenge.scorecard_plan_id = {sql_literal(ids['planId'])}::uuid
  ),
  'evaluationCount', (
    select count(*) from public.forecast_evaluations
    where analytics_run_id = {sql_literal(ids['evaluationRunId'])}::uuid
  ),
  'scorecardEvaluationCount', (
    select count(*) from public.model_scorecard_evaluations membership
    join scorecard on scorecard.id = membership.scorecard_id
  ),
  'runMembershipCount', (
    select count(*) from public.prospective_scorecard_run_memberships
    where scorecard_plan_id = {sql_literal(ids['planId'])}::uuid
  ),
  'originCount', (select (metrics->>'originCount')::integer from scorecard),
  'spacedOriginCount', (
    select (metrics->>'spacedOriginCount')::integer from scorecard
  ),
  'afterCostCaseCount', (
    select (metrics#>>'{{afterCostProbability,caseCount}}')::integer from scorecard
  ),
  'selectedCandidateCount', (
    select (metrics#>>'{{selectedPockets,candidateCount}}')::integer from scorecard
  ),
  'recommendation', (select promotion_recommendation from scorecard),
  'membershipHashesMatch', (
    select scorecard.evaluation_membership_hash = recomputed.membership_hash
      and scorecard.metrics->>'evaluationMembershipHash'
            = scorecard.evaluation_membership_hash
    from scorecard cross join recomputed_membership recomputed
  ),
  'receiptHashesMatch', not exists (
    select 1
    from public.forecast_execution_challenges challenge
    join public.forecast_execution_receipts receipt
      on receipt.challenge_id = challenge.id
    where challenge.scorecard_plan_id = {sql_literal(ids['planId'])}::uuid
      and receipt.canonical_output_hash is distinct from
          public.canonical_stored_prospective_output_hash(receipt.id)
  ),
  'artifactExecutionVerified', (
    select (metrics#>>'{{executionAttestation,artifactExecutionVerified}}')::boolean
    from scorecard
  ),
  'publicFlag', (
    select enabled from public.product_feature_flags
    where key = 'public_price_intelligence'
  )
)::text;
"""))
    expected = {
        "challengeCount": 6,
        "receiptCount": 6,
        "evaluationCount": 6,
        "scorecardEvaluationCount": 6,
        "runMembershipCount": 6,
        "originCount": 6,
        "spacedOriginCount": 6,
        "afterCostCaseCount": 6,
        "selectedCandidateCount": 0,
        "recommendation": "insufficient",
        "membershipHashesMatch": True,
        "receiptHashesMatch": True,
        "artifactExecutionVerified": False,
        "publicFlag": False,
    }
    if evidence != expected:
        raise RuntimeTestFailure(
            f"synthetic scorecard evidence differs:\n{json.dumps(evidence, indent=2)}"
        )
    expect_failure(scorecard_sql(ids), "Prospective scorecard plan has already been consumed")


def main() -> int:
    try:
        manual_pgcrypto = bootstrap_database()
        apply_migrations(manual_pgcrypto)
        run_psql(file=FIXTURE)
        assert_terminal_trend_run_guard()
        assert_acl_guards()
        challenge = create_challenge()
        expect_failure(
            "set role service_role; select count(*) "
            "from public.forecast_executor_keys;",
            "permission denied",
        )
        candidate = candidate_payload(challenge)
        assert_candidate_rejections(challenge, candidate)
        assert_hmac_rejections(challenge, candidate)
        assert_expired_challenge_rejection(challenge, candidate)
        assert_late_receipt_rollback(challenge, candidate)
        assert_lock_guard()
        assert_successful_receipt(challenge, candidate)
        run_psql(file=SCORECARD_FIXTURE)
        scorecard_ids = synthetic_scorecard_ids()
        assert_scorecard_receipt_tamper_rejection(scorecard_ids)
        assert_scorecard_evaluation_race(scorecard_ids)
        assert_synthetic_scorecard(scorecard_ids)
    except (RuntimeTestFailure, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Forecast PostgreSQL runtime test failed: {error}", file=sys.stderr)
        return 1
    print(
        "Forecast PostgreSQL runtime test passed: migrations, ACLs, terminal-run and "
        "row-lock guards, HMAC tamper/replay rejection, rollback atomicity, complete "
        "costs, stored receipt hashes, and the synthetic six-origin scorecard lifecycle"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
