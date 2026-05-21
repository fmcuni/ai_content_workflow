import asyncio  # noqa: F401
import os
import subprocess
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession
from testcontainers.postgres import PostgresContainer

from content_tool.db.connection import make_engine, make_session_factory


@pytest.fixture(scope="session")
def postgres_container():
    with PostgresContainer("postgres:16", driver="asyncpg") as pg:
        yield pg


@pytest.fixture(scope="session")
def postgres_url(postgres_container) -> str:
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
