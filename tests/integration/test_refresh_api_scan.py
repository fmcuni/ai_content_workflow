"""Integration tests for POST /refresh/scan and POST /refresh/scan/{article_id}."""
from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.db.models import Article, Run


@pytest.mark.asyncio
async def test_post_refresh_scan_returns_tick_summary(
    api_client_refresh: AsyncClient,
    pg_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """POST /refresh/scan with an article due in the past should return scanned=1, evaluations_created=1."""
    sf = pg_session_factory
    async with sf() as s:
        a = Article(
            article_url="https://wp.test/x/",
            next_scan_due_at=datetime.now(UTC) - timedelta(days=1),
        )
        s.add(a)
        await s.commit()

    resp = await api_client_refresh.post("/refresh/scan", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["scanned"] == 1
    assert body["evaluations_created"] == 1


@pytest.mark.asyncio
async def test_post_refresh_scan_id_409_when_inflight_run(
    api_client_refresh: AsyncClient,
    pg_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """POST /refresh/scan/{article_id} must return 409 when the article has an in-flight run."""
    sf = pg_session_factory
    async with sf() as s:
        a = Article(
            article_url="https://wp.test/y/",
            next_scan_due_at=datetime.now(UTC) - timedelta(days=1),
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        run = Run(
            created_by="test",
            status="pending",
            article_url=a.article_url,
            topic="test topic",
            keywords=[],
            mode="small_refresh",
            persona="bowtie",
            acf_adv_id=0,
            acf_widget_id=0,
            today_date=date.today(),
            article_id=a.article_id,
        )
        s.add(run)
        await s.commit()
        aid = a.article_id

    resp = await api_client_refresh.post(f"/refresh/scan/{aid}")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["reason"] == "in_progress_run"
