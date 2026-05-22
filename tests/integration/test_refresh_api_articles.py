from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from content_tool.db.models import Article, RefreshEvaluation


@pytest.mark.asyncio
async def test_list_articles_default_filter_needs_refresh(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a1 = Article(article_url="https://b/a1", next_scan_due_at=datetime.now(timezone.utc))
        a2 = Article(article_url="https://b/a2", next_scan_due_at=datetime.now(timezone.utc))
        s.add_all([a1, a2])
        await s.commit()
        s.add(RefreshEvaluation(
            article_id=a1.article_id, scanner_version="t", trigger_source="cron",
            age_days=120, deterministic_findings={}, staleness_score=Decimal("7.50"),
            recommended_action="refresh", outcome="open",
        ))
        s.add(RefreshEvaluation(
            article_id=a2.article_id, scanner_version="t", trigger_source="cron",
            age_days=10, deterministic_findings={}, staleness_score=Decimal("0.50"),
            recommended_action="ok", outcome="open",
        ))
        await s.commit()

    resp = await api_client.get("/articles?needs_refresh=true")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["article_url"] == "https://b/a1"


@pytest.mark.asyncio
async def test_dismiss_sets_until_and_flips_open_eval(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a = Article(article_url="https://b/a", next_scan_due_at=datetime.now(timezone.utc))
        s.add(a)
        await s.commit()
        ev = RefreshEvaluation(
            article_id=a.article_id, scanner_version="t", trigger_source="cron",
            age_days=120, deterministic_findings={}, staleness_score=Decimal("7.50"),
            recommended_action="refresh", outcome="open",
        )
        s.add(ev)
        await s.commit()
        aid = a.article_id

    until = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    resp = await api_client.post(
        f"/articles/{aid}/dismiss",
        json={"until": until, "reason": "wait for v2 product launch", "dismissed_by": "editor@bowtie"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dismissed_until"] is not None

    async with sf() as s:
        ev2 = (await s.execute(
            text("SELECT outcome FROM content_tool.refresh_evaluations LIMIT 1")
        )).scalar_one()
        assert ev2 == "dismissed"


@pytest.mark.asyncio
async def test_dismiss_until_in_past_returns_422(api_client: AsyncClient, pg_session_factory):
    sf = pg_session_factory
    async with sf() as s:
        a = Article(article_url="https://b/a3", next_scan_due_at=datetime.now(timezone.utc))
        s.add(a)
        await s.commit()
        aid = a.article_id

    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    resp = await api_client.post(
        f"/articles/{aid}/dismiss",
        json={"until": past, "dismissed_by": "editor@bowtie"},
    )
    assert resp.status_code == 422
