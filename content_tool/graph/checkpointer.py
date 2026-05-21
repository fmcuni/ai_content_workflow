from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


@asynccontextmanager
async def make_checkpointer(postgres_url: str) -> AsyncIterator[AsyncPostgresSaver]:
    # LangGraph's checkpointer uses psycopg async, not SQLAlchemy.
    # postgres_url should be a libpq URL (postgres://...); strip SQLAlchemy's "+asyncpg" if present.
    libpq_url = postgres_url.replace("+asyncpg", "")
    # autocommit=True is required because saver.setup() runs CREATE INDEX CONCURRENTLY,
    # which cannot run inside a transaction block. dict_row + prepare_threshold=0 match
    # AsyncPostgresSaver.from_conn_string defaults.
    pool_kwargs = {"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row}
    async with AsyncConnectionPool(libpq_url, max_size=4, open=False, kwargs=pool_kwargs) as pool:
        await pool.open()
        saver = AsyncPostgresSaver(pool)
        await saver.setup()
        yield saver
