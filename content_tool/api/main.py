from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from content_tool.api.routes.runs import router as runs_router
from content_tool.api.sse import RunExecutor
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.client import RealGeminiClient
from content_tool.wordpress.client import WordPressClient
from content_tool.wordpress.seo_plugin import detect_seo_plugin


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
    seo_plugin = None
    if settings.wp_base_url:
        try:
            seo_plugin = await detect_seo_plugin(settings.wp_base_url)
        except Exception:
            seo_plugin = None
    wp_client = WordPressClient(
        settings.wp_base_url,
        username=settings.wp_username,
        app_password=settings.wp_app_password,
        timeout=settings.wp_timeout,
    )
    executor = RunExecutor(
        postgres_url=settings.postgres_url,
        session_factory=sf,
        gemini=gemini,
        wp_client=wp_client,
        seo_plugin=seo_plugin,
    )
    app.state.session_factory = sf
    app.state.run_executor = executor
    app.state.wp_client = wp_client
    app.state.seo_plugin = seo_plugin
    app.state.wp_target = settings.wp_target
    try:
        yield
    finally:
        await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="Bowtie AI Content Tool", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(runs_router)
    return app


app = create_app()
