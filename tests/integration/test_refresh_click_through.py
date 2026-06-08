"""Integration tests: POST /runs with triggered_by_evaluation_id."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from content_tool.api.main import create_app
from content_tool.db.models import Article, RefreshEvaluation


# ---------------------------------------------------------------------------
# Minimal stub executor so POST /runs doesn't crash on runner.start()
# ---------------------------------------------------------------------------


class _StubRunner:
    async def start(self, run_id: UUID) -> None:
        pass  # no-op


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _make_article(url: str) -> Article:
    return Article(
        article_url=url,
        next_scan_due_at=_now(),
        topic="test topic",
        persona="bowtie-editor",
    )


def _make_eval(article_id: UUID) -> RefreshEvaluation:
    return RefreshEvaluation(
        article_id=article_id,
        scanner_version="test",
        trigger_source="cron",
        age_days=120,
        deterministic_findings={},
        staleness_score=Decimal("7.50"),
        recommended_action="refresh",
        outcome="open",
    )


_BASE_PAYLOAD = {
    "article_url": "",  # overridden per test
    "topic": "test topic",
    "keywords": ["kw1"],
    "mode": "auto",
    "acf_adv_id": 1,
    "acf_widget_id": 2,
    "persona": "bowtie-editor",
    "editor_email": "editor@bowtie",
}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_runs_with_evaluation_id_flips_outcome(pg_session_factory):
    """Seeding an open eval and POSTing /runs with its ID should flip outcome to 'triggered'."""
    sf = pg_session_factory

    # Seed Article + open RefreshEvaluation
    async with sf() as s:
        article = _make_article("https://www.bowtie.com.hk/blog/zh/cancer/")
        s.add(article)
        await s.commit()
        ev = _make_eval(article.article_id)
        s.add(ev)
        await s.commit()
        article_id = article.article_id
        eval_id = ev.evaluation_id

    # Wire app with stub runner
    app = create_app()
    app.state.session_factory = sf
    app.state.run_executor = _StubRunner()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            **_BASE_PAYLOAD,
            "article_url": "https://www.bowtie.com.hk/blog/zh/cancer/",
            "triggered_by_evaluation_id": str(eval_id),
        }
        resp = await ac.post("/runs", json=payload)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert UUID(body["run_id"])
    assert body["article_id"] == str(article_id)

    # Verify eval was flipped
    async with sf() as s:
        ev2 = (
            await s.execute(
                select(RefreshEvaluation).where(RefreshEvaluation.evaluation_id == eval_id)
            )
        ).scalar_one()
        assert ev2.outcome == "triggered"
        assert ev2.resulting_run_id == UUID(body["run_id"])
        assert ev2.outcome_set_by == "editor@bowtie"
        assert ev2.outcome_set_at is not None


@pytest.mark.asyncio
async def test_post_runs_already_resolved_evaluation_returns_409(pg_session_factory):
    """Seeding an eval already marked 'triggered' and POSTing /runs with its ID must return 409."""
    sf = pg_session_factory

    async with sf() as s:
        article = _make_article("https://www.bowtie.com.hk/blog/zh/already-resolved/")
        s.add(article)
        await s.commit()
        # Seed an evaluation already marked "triggered" (not "open")
        ev = RefreshEvaluation(
            article_id=article.article_id,
            scanner_version="test",
            trigger_source="cron",
            age_days=120,
            deterministic_findings={},
            staleness_score=Decimal("7.50"),
            recommended_action="refresh",
            outcome="triggered",
        )
        s.add(ev)
        await s.commit()
        eval_id = ev.evaluation_id

    app = create_app()
    app.state.session_factory = sf
    app.state.run_executor = _StubRunner()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        payload = {
            **_BASE_PAYLOAD,
            "article_url": "https://www.bowtie.com.hk/blog/zh/already-resolved/",
            "triggered_by_evaluation_id": str(eval_id),
        }
        resp = await ac.post("/runs", json=payload)

    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert "already" in detail.lower() or "resolved" in detail.lower()


@pytest.mark.asyncio
async def test_post_runs_evaluation_mismatch_returns_422(pg_session_factory):
    """Posting /runs for article B with an eval that belongs to article A must return 422."""
    sf = pg_session_factory

    # Seed two separate articles; eval is attached to article_a
    async with sf() as s:
        article_a = _make_article("https://www.bowtie.com.hk/blog/zh/article-a/")
        article_b = _make_article("https://www.bowtie.com.hk/blog/zh/article-b/")
        s.add_all([article_a, article_b])
        await s.commit()
        ev = _make_eval(article_a.article_id)
        s.add(ev)
        await s.commit()
        eval_id = ev.evaluation_id

    # Wire app with stub runner
    app = create_app()
    app.state.session_factory = sf
    app.state.run_executor = _StubRunner()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # POST for article_b URL but supply eval that belongs to article_a
        payload = {
            **_BASE_PAYLOAD,
            "article_url": "https://www.bowtie.com.hk/blog/zh/article-b/",
            "triggered_by_evaluation_id": str(eval_id),
        }
        resp = await ac.post("/runs", json=payload)

    assert resp.status_code == 422, resp.text
    assert "mismatch" in resp.json()["detail"]
