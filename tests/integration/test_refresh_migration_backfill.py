"""Integration test for migration 0006 backfill.

Architecture: Option B — uses the existing session-scoped PostgresContainer
(already at HEAD after apply_migrations autouse fixture), downgrades to 0005,
seeds test data, runs upgrade to 0006, asserts backfill correctness, then
restores DB to HEAD so other tests are unaffected.

This approach avoids spinning up a second testcontainer and is safe because
the downgrade/upgrade is isolated within this module's scope and fully
restored before any other test can observe the intermediate state.
"""

import os
import subprocess
import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker

from content_tool.db.connection import make_engine, make_session_factory


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _alembic(args: list[str], postgres_url: str) -> None:
    """Run an alembic subcommand with the given DB URL."""
    env = {**os.environ, "POSTGRES_URL": postgres_url}
    subprocess.run(["alembic", *args], check=True, env=env)  # noqa: S607


async def _fetchall(postgres_url: str, sql: str) -> list[tuple]:
    """Execute a raw SELECT and return all rows as tuples."""
    engine = create_async_engine(postgres_url)
    try:
        from sqlalchemy import text
        async with engine.connect() as conn:
            result = await conn.execute(text(sql))
            return result.fetchall()
    finally:
        await engine.dispose()


async def _execute(postgres_url: str, sql: str) -> None:
    """Execute a raw DML statement."""
    engine = create_async_engine(postgres_url)
    try:
        from sqlalchemy import text
        async with engine.begin() as conn:
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_backfill_articles_from_runs(postgres_url: str) -> None:
    """Migration 0006 must create one Article per distinct article_url in runs
    and link all runs back via article_id."""

    # ------------------------------------------------------------------
    # 1. Downgrade to 0005 (removes articles, refresh_evaluations, run cols)
    # ------------------------------------------------------------------
    _alembic(["downgrade", "0005"], postgres_url)

    try:
        # ------------------------------------------------------------------
        # 2. Seed 3 runs across 2 distinct article_urls
        # ------------------------------------------------------------------
        run_ids = [str(uuid.uuid4()) for _ in range(3)]
        url_a = "https://bowtie.com/blog/article-alpha"
        url_b = "https://bowtie.com/blog/article-beta"

        insert_sql = f"""
            INSERT INTO content_tool.runs
                (run_id, created_at, updated_at, created_by, status,
                 article_url, topic, keywords, mode, acf_adv_id,
                 acf_widget_id, persona, today_date, iteration_count)
            VALUES
                ('{run_ids[0]}'::uuid, now(), now(), 'test', 'completed',
                 '{url_a}', 'Health Insurance', '[]'::jsonb, 'write',
                 1, 2, 'broker', current_date, 0),
                ('{run_ids[1]}'::uuid, now(), now(), 'test', 'completed',
                 '{url_a}', 'Health Insurance', '[]'::jsonb, 'write',
                 1, 2, 'broker', current_date, 0),
                ('{run_ids[2]}'::uuid, now(), now(), 'test', 'completed',
                 '{url_b}', 'Life Insurance', '[]'::jsonb, 'write',
                 1, 2, 'broker', current_date, 0)
        """
        await _execute(postgres_url, insert_sql)

        # ------------------------------------------------------------------
        # 3. Upgrade to 0006 — runs backfill
        # ------------------------------------------------------------------
        _alembic(["upgrade", "0006"], postgres_url)

        # ------------------------------------------------------------------
        # 4. Assert articles table has exactly 2 rows
        # ------------------------------------------------------------------
        articles_rows = await _fetchall(
            postgres_url,
            "SELECT article_url FROM content_tool.articles ORDER BY article_url",
        )
        assert len(articles_rows) == 2, (
            f"Expected 2 articles, got {len(articles_rows)}: {articles_rows}"
        )
        article_urls = {row[0] for row in articles_rows}
        assert url_a in article_urls
        assert url_b in article_urls

        # ------------------------------------------------------------------
        # 5. Assert all 3 runs have non-null article_id
        # ------------------------------------------------------------------
        runs_without_article = await _fetchall(
            postgres_url,
            f"""
            SELECT run_id FROM content_tool.runs
            WHERE run_id IN (
                '{run_ids[0]}'::uuid,
                '{run_ids[1]}'::uuid,
                '{run_ids[2]}'::uuid
            )
            AND article_id IS NULL
            """,
        )
        assert len(runs_without_article) == 0, (
            f"Runs missing article_id: {runs_without_article}"
        )

        # ------------------------------------------------------------------
        # 6. Assert runs[0] and runs[1] share the same article_id (url_a)
        # ------------------------------------------------------------------
        url_a_article_ids = await _fetchall(
            postgres_url,
            f"""
            SELECT DISTINCT article_id FROM content_tool.runs
            WHERE run_id IN ('{run_ids[0]}'::uuid, '{run_ids[1]}'::uuid)
            """,
        )
        assert len(url_a_article_ids) == 1, (
            f"Runs for url_a should share one article_id, got: {url_a_article_ids}"
        )

    finally:
        # ------------------------------------------------------------------
        # Restore: bring DB back to HEAD so other integration tests are unaffected
        # ------------------------------------------------------------------
        _alembic(["upgrade", "head"], postgres_url)
