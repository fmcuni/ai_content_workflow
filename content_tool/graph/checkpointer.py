from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool


@asynccontextmanager
async def make_checkpointer(postgres_url: str) -> AsyncIterator[AsyncPostgresSaver]:
    # LangGraph's checkpointer uses psycopg async, not SQLAlchemy.
    # postgres_url should be a libpq URL (postgres://...); strip SQLAlchemy's "+asyncpg" if present.
    libpq_url = postgres_url.replace("+asyncpg", "")
    async with AsyncConnectionPool(libpq_url, max_size=4, open=False) as pool:
        await pool.open()
        saver = AsyncPostgresSaver(pool)
        await saver.setup()
        yield saver
