"""Tests for /runs/{run_id}/existing-post GET."""

from datetime import date
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.api.routes.runs import router
from content_tool.api.wp_options_cache import TtlCache
from content_tool.db.models import FetchedArticle, Run
from content_tool.wordpress.client import WordPressError


def _make_app(session_factory, wp_client=None) -> FastAPI:
    app = FastAPI()
    app.state.session_factory = session_factory
    # /existing-post resolves author/category display names via the WP client
    # (cached). Default to a stub that raises WordPressError so names resolve
    # to None and tests assert against ID-only payloads.
    if wp_client is None:
        wp_client = AsyncMock()
        wp_client.get_user.side_effect = WordPressError("test-stub")
        wp_client.get_category.side_effect = WordPressError("test-stub")
    app.state.wp_client = wp_client
    app.state.wp_options_cache = TtlCache(ttl_seconds=60)
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
        "wp_author_name": None,
        "wp_category_id": 42,
        "wp_category_name": None,
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


from unittest.mock import AsyncMock

from content_tool.wordpress.client import FetchedPost, WordPressError
from sqlalchemy import select


@pytest.mark.asyncio
async def test_existing_post_refresh_updates_row(pg_session_factory):
    run_id = await _seed(
        pg_session_factory,
        wp_author_id=5, wp_slug="old-slug", wp_link="https://wp.example.com/old/",
    )

    wp = AsyncMock()
    wp.fetch_post_by_url.return_value = FetchedPost(
        id=98785, slug="new-slug", link="https://wp.example.com/new/",
        title="t", content_html="<p>new</p>", modified_gmt="2026-05-26T00:00:00",
        status="publish", author=7, categories=[42],
    )
    # Name-resolution probes are unrelated to this test; force them to fail
    # so the response carries IDs only.
    wp.get_user.side_effect = WordPressError("test-stub")
    wp.get_category.side_effect = WordPressError("test-stub")

    app = _make_app(pg_session_factory, wp_client=wp)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/existing-post/refresh")

    assert r.status_code == 200
    body = r.json()
    # The mock wp client only stubs fetch_post_by_url; get_user/get_category
    # aren't configured here, so name resolution yields None via the default
    # AsyncMock-returns-AsyncMock path being short-circuited by our resolver.
    # We only assert the ID-bearing fields so this test stays focused.
    assert body["wp_post_id"] == 98785
    assert body["link"] == "https://wp.example.com/new/"
    assert body["wp_author_id"] == 7
    assert body["wp_category_id"] == 42
    assert body["wp_slug"] == "new-slug"

    # Row was updated
    async with pg_session_factory() as session:
        row = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run_id)
        )).scalar_one()
    assert row.wp_author_id == 7
    assert row.wp_slug == "new-slug"
    assert row.wp_link == "https://wp.example.com/new/"
    assert row.wp_categories[0]["id"] == 42


@pytest.mark.asyncio
async def test_existing_post_refresh_404_when_wp_returns_none(pg_session_factory):
    run_id = await _seed(pg_session_factory)
    wp = AsyncMock()
    wp.fetch_post_by_url.return_value = None

    app = _make_app(pg_session_factory)
    app.state.wp_client = wp

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/existing-post/refresh")

    assert r.status_code == 404
    assert "not found" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_existing_post_refresh_502_on_wp_error_with_redacted_detail(pg_session_factory):
    run_id = await _seed(pg_session_factory)
    wp = AsyncMock()
    wp.fetch_post_by_url.side_effect = WordPressError("403: sensitive internal text")

    app = _make_app(pg_session_factory)
    app.state.wp_client = wp

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/existing-post/refresh")

    assert r.status_code == 502
    assert r.json()["detail"] == "WordPress upstream error"
    # Raw upstream text must NOT leak to clients.
    assert "sensitive internal text" not in r.text
    assert "403" not in r.text
