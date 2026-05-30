import asyncio
import json
import os
import re
from collections.abc import AsyncGenerator
from pathlib import Path

import asyncpg
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


@pytest.fixture(scope="session")
def apply_migrations(postgres_url):
    # Not autouse: only DB-consuming fixtures depend on this, so pure unit tests
    # never spin a container or apply schema. Set POSTGRES_URL here so code under
    # test that reads it sees the same database the tests actually use.
    os.environ["POSTGRES_URL"] = postgres_url
    # When pointed at an EXTERNAL_POSTGRES_URL (e.g. local Supabase), the
    # operator is responsible for applying schema via `supabase db reset`
    # before the test run. The Alembic baseline has been retired (see
    # supabase/migrations/<ts>_baseline.sql).
    if os.environ.get("EXTERNAL_POSTGRES_URL"):
        return
    # Apply baseline migration + seed directly for the testcontainers path.
    # Strip psql meta-commands (\restrict / \unrestrict) and Supabase-only
    # extensions that don't exist in a plain postgres:16 image.
    _STRIP = re.compile(
        r"^\\.+$\n?|CREATE EXTENSION IF NOT EXISTS[^;]+;",
        re.MULTILINE,
    )

    baseline = _STRIP.sub(
        "",
        Path("supabase/migrations/20260528131043_baseline.sql").read_text(),
    )
    seed = Path("supabase/seed.sql").read_text()

    async def _bootstrap() -> None:
        url = postgres_url.replace("postgresql+asyncpg://", "postgresql://")
        conn = await asyncpg.connect(url)
        try:
            await conn.execute(baseline)
            await conn.execute(seed)
        finally:
            await conn.close()

    asyncio.run(_bootstrap())


# get_settings() reads env; set a dummy Gemini key so tests using FakeGeminiClient
# can construct Settings without a real key. POSTGRES_URL is set lazily by
# `apply_migrations` only when a database is actually needed, keeping pure unit
# tests free of any container/DB requirement.
@pytest.fixture(scope="session", autouse=True)
def set_test_env():
    os.environ["GEMINI_API_KEY"] = "test-dummy"


@pytest_asyncio.fixture
async def db_session(postgres_url, apply_migrations) -> AsyncGenerator[AsyncSession]:
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    async with sf() as session:
        yield session
        await session.rollback()
    await engine.dispose()


@pytest_asyncio.fixture
async def pg_session_factory(
    postgres_url,
    apply_migrations,
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
