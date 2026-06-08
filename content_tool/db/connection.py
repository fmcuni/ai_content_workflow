from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Server-side ceiling (ms) on any single query, mirroring the Workers backend's
# db/client.ts. A stalled socket would otherwise hang an `await session.execute`
# indefinitely (the resolve_citations stall behind run a6e897e1); Postgres aborts
# the query instead. 30s is far above any real OLTP query here — it only catches
# hangs. Applied as an asyncpg `server_settings` GUC on every new connection.
_STATEMENT_TIMEOUT_MS = 30_000


def _build_connect_args(postgres_url: str) -> tuple[str, dict[str, object]]:
    """Return (clean_url, connect_args) for asyncpg.

    asyncpg doesn't accept sslmode as a URL query param (libpq-only), so it is
    stripped and ssl is passed via connect_args. Every connection also gets the
    `statement_timeout` GUC so a hung query aborts instead of blocking forever.
    """
    parsed = urlparse(postgres_url)
    params = parse_qs(parsed.query, keep_blank_values=True)
    sslmode = params.pop("sslmode", [None])[0]
    clean_url = urlunparse(parsed._replace(query=urlencode(params, doseq=True)))

    connect_args: dict[str, object] = {
        "server_settings": {"statement_timeout": str(_STATEMENT_TIMEOUT_MS)},
    }
    if sslmode and sslmode != "disable":
        connect_args["ssl"] = "require"

    return clean_url, connect_args


def make_engine(postgres_url: str) -> AsyncEngine:
    clean_url, connect_args = _build_connect_args(postgres_url)

    return create_async_engine(
        clean_url,
        pool_pre_ping=True,
        echo=False,
        pool_size=5,
        max_overflow=10,
        pool_recycle=1800,
        connect_args=connect_args,
    )


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)
