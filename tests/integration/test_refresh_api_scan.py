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


@pytest.mark.asyncio
async def test_post_refresh_scan_id_410_when_dismissed(
    api_client_refresh: AsyncClient,
    pg_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """POST /refresh/scan/{article_id} must return 410 when article is dismissed and force=False."""
    sf = pg_session_factory
    async with sf() as s:
        a = Article(
            article_url="https://wp.test/dismissed/",
            next_scan_due_at=datetime.now(UTC),
            dismissed_until=datetime.now(UTC) + timedelta(days=30),
            dismissed_by="editor@bowtie",
        )
        s.add(a)
        await s.commit()
        aid = a.article_id

    resp = await api_client_refresh.post(f"/refresh/scan/{aid}")
    assert resp.status_code == 410, resp.text
    detail = resp.json()["detail"]
    assert detail["reason"] == "dismissed"


@pytest.mark.asyncio
async def test_post_refresh_scan_409_when_lock_contended(
    api_client_refresh: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """POST /refresh/scan must return 409 when a scan tick is already in progress."""
    from content_tool.refresh.scanner import TickResult
    import content_tool.api.routes.refresh as refresh_route
    from uuid import uuid4

    fake = TickResult(
        tick_id=uuid4(),
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
        skipped=[{"reason": "scan_in_progress"}],
    )

    async def fake_scan_tick(*args, **kwargs):  # type: ignore[no-untyped-def]
        return fake

    monkeypatch.setattr(refresh_route, "scan_tick", fake_scan_tick)

    resp = await api_client_refresh.post("/refresh/scan", json={})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["reason"] == "scan_in_progress"
