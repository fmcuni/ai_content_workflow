"""Integration tests for /wp-options/* routes (Postgres-backed)."""

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.api.routes.wp_options import router
from content_tool.db.models import WpCategoryCache, WpUserCache


def _make_app(session_factory) -> FastAPI:
    app = FastAPI()
    app.state.session_factory = session_factory
    app.include_router(router)
    return app


async def _seed(session_factory, *, users=None, categories=None) -> None:
    async with session_factory() as session:
        for u in users or []:
            session.add(WpUserCache(id=u["id"], name=u["name"], slug=u["slug"]))
        for c in categories or []:
            session.add(WpCategoryCache(id=c["id"], name=c["name"], slug=c["slug"]))
        await session.commit()


@pytest.mark.asyncio
async def test_users_returns_sorted_list(pg_session_factory) -> None:
    await _seed(
        pg_session_factory,
        users=[
            {"id": 9, "name": "Bowtie Team", "slug": "bowtie-team"},
            {"id": 5, "name": "Alex Chan", "slug": "alex-chan"},
        ],
    )
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/users")
    assert r.status_code == 200
    # Sorted by name ascending.
    assert r.json() == [
        {"id": 5, "name": "Alex Chan", "slug": "alex-chan"},
        {"id": 9, "name": "Bowtie Team", "slug": "bowtie-team"},
    ]


@pytest.mark.asyncio
async def test_users_filters_by_name_substring(pg_session_factory) -> None:
    await _seed(
        pg_session_factory,
        users=[
            {"id": 1, "name": "Alex Chan", "slug": "alex"},
            {"id": 2, "name": "Bowtie Team", "slug": "bowtie"},
            {"id": 3, "name": "Cathy Wong", "slug": "cathy"},
        ],
    )
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/users", params={"q": "ow"})
    assert r.status_code == 200
    names = [row["name"] for row in r.json()]
    # Only "Bowtie Team" contains the substring "ow".
    assert names == ["Bowtie Team"]


@pytest.mark.asyncio
async def test_users_filters_by_id_when_query_is_numeric(pg_session_factory) -> None:
    await _seed(
        pg_session_factory,
        users=[
            {"id": 42, "name": "Alex Chan", "slug": "alex"},
            {"id": 99, "name": "Bowtie Team", "slug": "bowtie"},
        ],
    )
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/users", params={"q": "42"})
    assert r.status_code == 200
    assert [row["id"] for row in r.json()] == [42]


@pytest.mark.asyncio
async def test_users_empty_when_cache_empty(pg_session_factory) -> None:
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/users")
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_categories_returns_sorted_list(pg_session_factory) -> None:
    await _seed(
        pg_session_factory,
        categories=[
            {"id": 2, "name": "News", "slug": "news"},
            {"id": 1, "name": "Cancer", "slug": "cancer"},
        ],
    )
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/categories")
    assert r.status_code == 200
    assert [row["name"] for row in r.json()] == ["Cancer", "News"]


@pytest.mark.asyncio
async def test_categories_filters_by_query(pg_session_factory) -> None:
    await _seed(
        pg_session_factory,
        categories=[
            {"id": 1, "name": "Cancer", "slug": "cancer"},
            {"id": 2, "name": "Diabetes", "slug": "diabetes"},
        ],
    )
    app = _make_app(pg_session_factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/categories", params={"q": "cer"})
    assert r.status_code == 200
    assert [row["id"] for row in r.json()] == [1]
