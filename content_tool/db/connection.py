from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def make_engine(postgres_url: str) -> AsyncEngine:
    return create_async_engine(
        postgres_url,
        pool_pre_ping=True,
        echo=False,
        pool_size=5,
        max_overflow=10,
        pool_recycle=1800,
    )


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)
