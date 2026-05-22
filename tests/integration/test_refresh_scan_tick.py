"""Integration tests for refresh.scanner.scan_tick."""
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from content_tool.db.models import Article, Run
from content_tool.refresh.scanner import scan_tick


@pytest.mark.asyncio
async def test_scan_tick_skips_in_progress_articles(
    pg_session_factory, wp_client_mocked_ok, fake_gemini
):
    sf = pg_session_factory
    async with sf() as s:
        a1 = Article(
            article_url="https://bowtie/a1/",
            next_scan_due_at=datetime.now(UTC) - timedelta(days=1),
        )
        a2 = Article(
            article_url="https://bowtie/a2/",
            next_scan_due_at=datetime.now(UTC) - timedelta(days=1),
        )
        s.add_all([a1, a2])
        await s.commit()
        await s.refresh(a2)
        # a2 has an in-progress run
        s.add(
            Run(
                created_by="e",
                status="strategy",
                article_url=a2.article_url,
                topic="x",
                keywords=[],
                mode="small_refresh",
                acf_adv_id=0,
                acf_widget_id=0,
                persona="x",
                today_date=datetime.now(UTC).date(),
                article_id=a2.article_id,
            )
        )
        await s.commit()

    result = await scan_tick(
        sf, wp_client=wp_client_mocked_ok, gemini_client=fake_gemini
    )
    assert result.scanned == 1
    assert result.evaluations_created == 1


@pytest.mark.asyncio
async def test_scan_tick_supersedes_previous_open(
    pg_session_factory, wp_client_mocked_ok, fake_gemini
):
    sf = pg_session_factory
    async with sf() as s:
        a = Article(
            article_url="https://bowtie/a/",
            next_scan_due_at=datetime.now(UTC) - timedelta(days=1),
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        aid = a.article_id

    # First scan
    await scan_tick(sf, wp_client=wp_client_mocked_ok, gemini_client=fake_gemini)

    # Bump due to force re-scan
    async with sf() as s2:
        a2 = await s2.get(Article, aid)
        a2.next_scan_due_at = datetime.now(UTC) - timedelta(minutes=1)
        await s2.commit()

    # Second scan
    await scan_tick(sf, wp_client=wp_client_mocked_ok, gemini_client=fake_gemini)

    async with sf() as s3:
        rows = (
            await s3.execute(
                text(
                    "SELECT outcome FROM content_tool.refresh_evaluations "
                    "ORDER BY evaluated_at ASC"
                )
            )
        ).all()
        statuses = [r[0] for r in rows]
        assert len(statuses) == 2
        assert statuses[0] == "superseded"
        assert statuses[-1] == "open"
