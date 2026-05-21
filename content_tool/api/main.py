from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from content_tool.api.routes.runs import router as runs_router
from content_tool.api.sse import RunExecutor
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.client import RealGeminiClient


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    gemini = RealGeminiClient(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
        thinking_level=settings.gemini_thinking_level,
    )
    executor = RunExecutor(postgres_url=settings.postgres_url, session_factory=sf, gemini=gemini)
    app.state.session_factory = sf
    app.state.run_executor = executor
    try:
        yield
    finally:
        await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="Bowtie AI Content Tool", version="0.1.0", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(runs_router)
    return app


app = create_app()
