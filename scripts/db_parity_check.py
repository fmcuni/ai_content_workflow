#!/usr/bin/env python3
"""E6 acceptance gate: row-count parity between old prod DB and Supabase.

Usage:
    OLD_PG_URL=postgresql://... SUPABASE_DIRECT_URL=postgresql://... \\
        python scripts/db_parity_check.py

Both URLs may use the postgresql+asyncpg:// dialect prefix (stripped
automatically) and may include ?sslmode=require.
"""
import asyncio
import os
import sys

import asyncpg

SCHEMA = "content_tool"

# Ordered by FK dependency so any logged mismatch is easy to reason about.
TABLES = [
    "articles",
    "personas",
    "topic_batches",
    "topic_candidates",
    "runs",
    "gap_analyses",
    "fetched_articles",
    "outlines",
    "drafts",
    "hitl2_snapshots",
    "citations",
    "url_resolution_cache",
    "renders",
    "audit_runs",
    "compliance_log",
    "evals",
    "refresh_evaluations",
    "wp_users",
    "wp_categories",
    "prompt_versions",
]


def _normalise_url(url: str) -> str:
    """Strip SQLAlchemy dialect prefix so asyncpg can parse the URL."""
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def _count(conn: asyncpg.Connection, table: str) -> int:
    row = await conn.fetchrow(  # noqa: S608
        f'SELECT count(*) FROM {SCHEMA}."{table}"'
    )
    return int(row[0])


async def main() -> None:
    old_url = os.environ.get("OLD_PG_URL")
    new_url = os.environ.get("SUPABASE_DIRECT_URL")
    if not old_url or not new_url:
        sys.exit(
            "error: set OLD_PG_URL and SUPABASE_DIRECT_URL before running.\n"
            "  OLD_PG_URL             — current production database\n"
            "  SUPABASE_DIRECT_URL    — new Supabase direct connection (port 5432)"
        )

    old_conn = await asyncpg.connect(_normalise_url(old_url))
    new_conn = await asyncpg.connect(_normalise_url(new_url))

    col = 32
    header = f"{'table':<{col}}  {'old':>10}  {'new':>10}  status"
    print(header)
    print("-" * len(header))

    mismatches: list[str] = []
    errors: list[str] = []

    for table in TABLES:
        try:
            old_n = await _count(old_conn, table)
            new_n = await _count(new_conn, table)
        except Exception as exc:  # noqa: BLE001
            print(f"{table:<{col}}  {'?':>10}  {'?':>10}  ERROR: {exc}")
            errors.append(table)
            continue

        ok = old_n == new_n
        status = "OK" if ok else f"MISMATCH (delta={new_n - old_n:+d})"
        print(f"{table:<{col}}  {old_n:>10}  {new_n:>10}  {status}")
        if not ok:
            mismatches.append(table)

    await old_conn.close()
    await new_conn.close()

    print()
    if errors:
        print(f"ERRORS querying: {', '.join(errors)}")
    if mismatches:
        print(f"FAIL — row-count mismatch in: {', '.join(mismatches)}")
        sys.exit(1)

    if not errors:
        print("PASS — all 20 tables match")


if __name__ == "__main__":
    asyncio.run(main())
