"""Integration-test-only fixtures for the /refresh API routes."""
from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.api.main import create_app
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.wordpress.client import WordPressClient


@pytest_asyncio.fixture
async def api_client_refresh(
    pg_session_factory: async_sessionmaker[AsyncSession],
    wp_client_mocked_ok: WordPressClient,
    fake_gemini: FakeGeminiClient,
) -> AsyncGenerator[AsyncClient]:
    """AsyncClient with session_factory, wp_client and gemini_client all wired to test doubles."""
    app = create_app()
    app.state.session_factory = pg_session_factory
    app.state.wp_client = wp_client_mocked_ok
    app.state.gemini_client = fake_gemini
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
