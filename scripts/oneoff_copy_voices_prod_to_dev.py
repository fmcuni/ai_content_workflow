"""One-off: copy runtime VOICE config from prod Supabase → dev Supabase.

Runtime voice data (personas, per-voice prompt templates, source policy,
publish targets) is intentionally NOT synced by migrations (see project
CLAUDE.md). This script makes the dev stack testable with the real prod voices
by copying those rows verbatim (PK-preserving, idempotent upsert), so cross-row
FK references (e.g. personas.publish_target_id) stay intact.

Scope: PUBLIC editorial/brand config only — no customer/PII/PHI data lives in
these tables. Reads prod, writes dev. Never the other direction.

Usage:
    # read-only: show what WOULD be copied (row counts per table)
    python -m scripts.oneoff_copy_voices_prod_to_dev --dry-run
    # perform the upsert
    python -m scripts.oneoff_copy_voices_prod_to_dev

Env (loaded from repo-root dotenvs, values never printed):
    POSTGRES_URL       prod DB  (.env.local)
    DEV_POSTGRES_URL   dev  DB  (.env.dev.local)

Delete this script (and do not commit it) once dev is seeded.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import asyncpg

_ROOT = Path(__file__).resolve().parents[1]
_SCHEMA = "content_tool"

# Copy order respects FK direction: publish_targets is referenced by personas.
# `source_policy` / `prompt_templates` are voice-keyed and self-contained.
# History tables (*_versions) are intentionally skipped — dev only needs the
# current rows to exercise the pipeline.
_TABLES = ["publish_targets", "personas", "source_policy", "prompt_templates"]

# Tables whose stable identity differs from the PK (e.g. personas keys rows by a
# uuid PK but carries a separate UNIQUE(slug)). Upsert on the natural key so the
# copy is idempotent against dev rows that share the slug but not the uuid.
_CONFLICT_KEYS = {"personas": ["slug"]}


def _load_env_value(dotenv: Path, key: str) -> str | None:
    """Minimal dotenv reader — returns the raw value for ``key`` or None.

    Avoids a hard dependency on python-dotenv and never echoes the value.
    """
    if not dotenv.exists():
        return None
    for line in dotenv.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip().strip('"').strip("'")
    return None


async def _pk_columns(conn: asyncpg.Connection, table: str) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary
        ORDER BY a.attnum
        """,
        _SCHEMA,
        table,
    )
    return [r["attname"] for r in rows]


async def _columns(conn: asyncpg.Connection, table: str) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
        """,
        _SCHEMA,
        table,
    )
    return [r["column_name"] for r in rows]


async def _copy_table(
    *, prod: asyncpg.Connection, dev: asyncpg.Connection, table: str, dry_run: bool
) -> tuple[int, int]:
    """Returns (rows_in_prod, rows_upserted)."""
    prod_cols = await _columns(prod, table)
    dev_cols = set(await _columns(dev, table))
    cols = [c for c in prod_cols if c in dev_cols]  # intersection, tolerate drift
    pk = await _pk_columns(dev, table)
    if not pk:
        raise RuntimeError(f"{table}: no primary key found in dev")
    conflict_keys = _CONFLICT_KEYS.get(table, pk)

    select_cols = ", ".join(f'"{c}"' for c in cols)
    rows = await prod.fetch(f"SELECT {select_cols} FROM {_SCHEMA}.{table}")
    if dry_run or not rows:
        return len(rows), 0

    # Never overwrite the true PK or the key we matched on.
    immutable = set(pk) | set(conflict_keys)
    non_pk = [c for c in cols if c not in immutable]
    placeholders = ", ".join(f"${i + 1}" for i in range(len(cols)))
    col_list = ", ".join(f'"{c}"' for c in cols)
    conflict = ", ".join(f'"{c}"' for c in conflict_keys)
    if non_pk:
        update = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in non_pk)
        action = f"DO UPDATE SET {update}"
    else:
        action = "DO NOTHING"
    stmt = (
        f"INSERT INTO {_SCHEMA}.{table} ({col_list}) VALUES ({placeholders}) "
        f"ON CONFLICT ({conflict}) {action}"
    )

    upserted = 0
    async with dev.transaction():
        for row in rows:
            await dev.execute(stmt, *[row[c] for c in cols])
            upserted += 1
    return len(rows), upserted


async def _main(dry_run: bool) -> int:
    prod_url = _load_env_value(_ROOT / ".env.local", "POSTGRES_URL")
    dev_url = _load_env_value(_ROOT / ".env.dev.local", "DEV_POSTGRES_URL")
    if not prod_url:
        print("ERROR: POSTGRES_URL missing in .env.local", file=sys.stderr)
        return 2
    if not dev_url:
        print("ERROR: DEV_POSTGRES_URL missing in .env.dev.local", file=sys.stderr)
        return 2

    # Normalise the SQLAlchemy DSN scheme (postgresql+asyncpg://) for raw asyncpg.
    def _dsn(url: str) -> str:
        return url.replace("postgresql+asyncpg://", "postgresql://").replace(
            "postgres+asyncpg://", "postgresql://"
        )

    # statement_cache_size=0 keeps us safe even if a URL points at a pooler.
    prod = await asyncpg.connect(_dsn(prod_url), statement_cache_size=0)
    dev = await asyncpg.connect(_dsn(dev_url), statement_cache_size=0)
    try:
        mode = "DRY-RUN (no writes)" if dry_run else "COPY prod → dev"
        print(f"== {mode} ==")
        print(f"{'table':<20} {'prod_rows':>10} {'upserted':>10}")
        for table in _TABLES:
            n_prod, n_up = await _copy_table(
                prod=prod, dev=dev, table=table, dry_run=dry_run
            )
            print(f"{table:<20} {n_prod:>10} {n_up:>10}")
    finally:
        await prod.close()
        await dev.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_main("--dry-run" in sys.argv)))
