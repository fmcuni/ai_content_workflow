"""Tests for /runs/{run_id}/existing-post GET."""

from datetime import date
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.api.routes.runs import router
from content_tool.db.models import FetchedArticle, Run


def _make_app(session_factory) -> FastAPI:
    app = FastAPI()
    app.state.session_factory = session_factory
    app.include_router(router)
    return app


async def _seed(
    session_factory,
    *,
    with_fetched: bool = True,
    wp_post_id: int | None = 98785,
    wp_author_id: int | None = 5,
    wp_slug: str | None = "cancer-screening",
    wp_link: str | None = "https://wp.example.com/p/cancer-screening/",
    wp_categories: list | None = None,
):
    run_id = uuid4()
    async with session_factory() as session:
        session.add(Run(
            run_id=run_id, created_by="x", status="hitl_2",
            article_url="https://wp.example.com/p/cancer-screening/",
            topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 26),
        ))
        await session.commit()  # commit Run before adding child row to satisfy FK
        if with_fetched:
            session.add(FetchedArticle(
                run_id=run_id, wp_post_id=wp_post_id,
                wp_categories=wp_categories if wp_categories is not None
                              else [{"id": 42, "name": "Cancer", "slug": "cancer"}],
                wp_author_id=wp_author_id,
                wp_slug=wp_slug,
                wp_link=wp_link,
                raw_html="<p>x</p>", markdown="x",
            ))
            await session.commit()
    return run_id


@pytest.mark.asyncio
async def test_existing_post_returns_cached_row(pg_session_factory):
    run_id = await _seed(pg_session_factory)
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get(f"/runs/{run_id}/existing-post")
    assert r.status_code == 200
    assert r.json() == {
        "wp_post_id": 98785,
        "link": "https://wp.example.com/p/cancer-screening/",
        "wp_author_id": 5,
        "wp_category_id": 42,
        "wp_slug": "cancer-screening",
    }


@pytest.mark.asyncio
async def test_existing_post_404_when_no_fetched_article(pg_session_factory):
    run_id = await _seed(pg_session_factory, with_fetched=False)
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get(f"/runs/{run_id}/existing-post")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_existing_post_404_when_wp_post_id_null(pg_session_factory):
    run_id = await _seed(pg_session_factory, wp_post_id=None)
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get(f"/runs/{run_id}/existing-post")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_existing_post_category_id_null_when_no_categories(pg_session_factory):
    run_id = await _seed(pg_session_factory, wp_categories=[])
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get(f"/runs/{run_id}/existing-post")
    assert r.status_code == 200
    assert r.json()["wp_category_id"] is None
