import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from opentelemetry.instrumentation.fastapi import (
    FastAPIInstrumentor,  # pyright: ignore[reportMissingTypeStubs]
)

from content_tool.api.routes.articles import router as articles_router
from content_tool.api.routes.compliance import router as compliance_router
from content_tool.api.routes.costs import router as costs_router
from content_tool.api.routes.refresh import router as refresh_router
from content_tool.api.routes.runs import router as runs_router
from content_tool.api.routes.wp_options import router as wp_options_router
from content_tool.api.sse import RunExecutor
from content_tool.api.wp_options_cache import TtlCache
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.client import RealGeminiClient
from content_tool.observability.logging import configure_logging
from content_tool.observability.tracing import configure_tracing
from content_tool.wordpress.client import WordPressClient
from content_tool.wordpress.seo_plugin import detect_seo_plugin

logger = logging.getLogger(__name__)


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
            seo_plugin = await detect_seo_plugin(
                settings.wp_base_url,
                username=settings.wp_username,
                app_password=settings.wp_app_password,
            )
        except Exception:
            logger.warning(
                "SEO plugin detection failed; SEO meta will be skipped on publish",
                exc_info=True,
            )
            seo_plugin = None
    wp_client = WordPressClient(
        settings.wp_base_url,
        username=settings.wp_username,
        app_password=settings.wp_app_password,
        timeout=settings.wp_timeout,
    )
    wp_options_cache = TtlCache(ttl_seconds=600)
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
    app.state.wp_options_cache = wp_options_cache
    app.state.gemini_client = gemini
    app.state.seo_plugin = seo_plugin
    app.state.wp_target = settings.wp_target
    try:
        yield
    finally:
        await engine.dispose()


def create_app() -> FastAPI:
    configure_logging(os.getenv("LOG_LEVEL", "info"))
    configure_tracing()
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
    app.include_router(articles_router)
    app.include_router(compliance_router)
    app.include_router(costs_router)
    app.include_router(refresh_router)
    app.include_router(wp_options_router)
    FastAPIInstrumentor().instrument_app(app)
    return app


app = create_app()
