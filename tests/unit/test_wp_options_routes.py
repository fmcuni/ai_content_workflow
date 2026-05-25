"""Integration tests for /wp-options/* routes."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.api.routes.wp_options import router
from content_tool.api.wp_options_cache import TtlCache
from content_tool.wordpress.client import WordPressError, WpCategory, WpUser


def _make_app(wp_client) -> FastAPI:
    app = FastAPI()
    app.state.wp_client = wp_client
    app.state.wp_options_cache = TtlCache(ttl_seconds=60)
    app.include_router(router)
    return app


@pytest.mark.asyncio
async def test_users_returns_serialized_list() -> None:
    wp = AsyncMock()
    wp.list_users.return_value = [
        WpUser(id=5, name="Editor", slug="editor"),
        WpUser(id=9, name="Author", slug="author"),
    ]
    app = _make_app(wp)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/users")
    assert r.status_code == 200
    assert r.json() == [
        {"id": 5, "name": "Editor", "slug": "editor"},
        {"id": 9, "name": "Author", "slug": "author"},
    ]
    assert wp.list_users.await_count == 1


@pytest.mark.asyncio
async def test_categories_uses_cache_for_second_call() -> None:
    wp = AsyncMock()
    wp.list_categories.return_value = [WpCategory(id=1, name="News", slug="news")]
    app = _make_app(wp)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r1 = await c.get("/wp-options/categories")
        r2 = await c.get("/wp-options/categories")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json() == r2.json()
    assert wp.list_categories.await_count == 1


@pytest.mark.asyncio
async def test_users_surfaces_wp_error_as_502() -> None:
    wp = AsyncMock()
    wp.list_users.side_effect = WordPressError("403: forbidden")
    app = _make_app(wp)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/wp-options/users")
    assert r.status_code == 502
    assert "forbidden" in r.json()["detail"]
