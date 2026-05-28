import asyncio  # noqa: F401
import json
import os
import subprocess
from collections.abc import AsyncGenerator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
import respx
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from testcontainers.postgres import PostgresContainer

from content_tool.api.main import create_app
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.wordpress.client import WordPressClient


@pytest.fixture(scope="session")
def postgres_container():
    # Opt-in: skip testcontainer when an external DB URL is provided
    # (e.g. local Supabase during the Phase A rehearsal).
    if os.environ.get("EXTERNAL_POSTGRES_URL"):
        yield None
        return
    with PostgresContainer("postgres:16", driver="asyncpg") as pg:
        yield pg


@pytest.fixture(scope="session")
def postgres_url(postgres_container) -> str:
    external = os.environ.get("EXTERNAL_POSTGRES_URL")
    if external:
        return external
    assert postgres_container is not None
    return postgres_container.get_connection_url()


@pytest.fixture(scope="session", autouse=True)
def apply_migrations(postgres_url):
    env = {**os.environ, "POSTGRES_URL": postgres_url}
    subprocess.run(["alembic", "upgrade", "head"], check=True, env=env)  # noqa: S607


# get_settings() reads env; set dummies so tests using FakeGeminiClient can construct Settings.
@pytest.fixture(scope="session", autouse=True)
def set_test_env(postgres_url):
    os.environ["GEMINI_API_KEY"] = "test-dummy"
    os.environ["POSTGRES_URL"] = postgres_url


@pytest_asyncio.fixture
async def db_session(postgres_url) -> AsyncGenerator[AsyncSession]:
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    async with sf() as session:
        yield session
        await session.rollback()
    await engine.dispose()


@pytest_asyncio.fixture
async def pg_session_factory(
    postgres_url,
) -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    """Yields a per-test async_sessionmaker bound to the running postgres container.

    Unlike `db_session` (which yields a single session for the test), the scanner
    code under test takes a session_factory and opens its own session(s) inside.
    """
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    try:
        yield sf
    finally:
        # Per-test cleanup: truncate refresh + runs tables so subsequent tests
        # see an empty world. We use a fresh session because the test's sessions
        # may already be closed.
        from sqlalchemy import text

        async with sf() as cleanup:
            await cleanup.execute(
                text(
                    "TRUNCATE TABLE content_tool.refresh_evaluations, "
                    "content_tool.runs, content_tool.articles, "
                    "content_tool.wp_users, content_tool.wp_categories "
                    "RESTART IDENTITY CASCADE"
                )
            )
            await cleanup.commit()
        await engine.dispose()


@pytest_asyncio.fixture
async def api_client(
    pg_session_factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[AsyncClient]:
    """Yields an AsyncClient bound to the FastAPI app with the test session factory wired in."""
    app = create_app()
    app.state.session_factory = pg_session_factory
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


@pytest.fixture
def fake_gemini() -> FakeGeminiClient:
    """A FakeGeminiClient pre-seeded with a passing audit response.

    Tests may call `fake_gemini.set_audit_response({...})` to override.
    """
    default_audit = {
        "overall_pass": True,
        "severity_summary": {"high": 0, "medium": 0, "low": 0},
        "findings": [],
    }
    return FakeGeminiClient(canned_responses={"audit": default_audit})


@pytest.fixture
def wp_client_mocked_ok():
    """Yield a WordPressClient whose HTTP calls return article_ok.html and
    OK responses for any outbound HEAD/GET used by deterministic checks.
    """
    fixture = json.loads(
        Path("tests/fixtures/wp_responses/post_by_slug.json").read_text()
    )
    fixture[0]["content"]["rendered"] = Path(
        "tests/fixtures/html/article_ok.html"
    ).read_text()
    with respx.mock(assert_all_called=False) as m:
        m.get(url__regex=r"https://wp\.test/wp-json/wp/v2/posts.*").mock(
            return_value=httpx.Response(200, json=fixture)
        )
        m.head(url__regex=r"https?://.*").mock(
            return_value=httpx.Response(200)
        )
        m.get(url__regex=r"https?://.*").mock(
            return_value=httpx.Response(200)
        )
        yield WordPressClient(
            base_url="https://wp.test",
            username="u",
            app_password="p",  # noqa: S106
            timeout=5.0,
        )
