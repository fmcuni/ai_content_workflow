import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from opentelemetry.instrumentation.fastapi import (
    FastAPIInstrumentor,  # pyright: ignore[reportMissingTypeStubs]
)

from content_tool import prompts_store, source_policy_store
from content_tool.api.routes.articles import router as articles_router
from content_tool.api.routes.compliance import router as compliance_router
from content_tool.api.routes.costs import router as costs_router
from content_tool.api.routes.personas import router as personas_router
from content_tool.api.routes.prompts import router as prompts_router
from content_tool.api.routes.refresh import router as refresh_router
from content_tool.api.routes.runs import router as runs_router
from content_tool.api.routes.setup import router as setup_router
from content_tool.api.routes.source_policy import router as source_policy_router
from content_tool.api.routes.topic_batches import router as topic_batches_router
from content_tool.api.routes.wp_options import router as wp_options_router
from content_tool.api.sse import RunExecutor
from content_tool.api.wp_options_cache import TtlCache
from content_tool.config import Settings, get_settings, is_configured
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.client import RealGeminiClient
from content_tool.observability.logging import configure_logging
from content_tool.observability.tracing import configure_tracing
from content_tool.wordpress.client import WordPressClient
from content_tool.wordpress.seo_plugin import SeoPlugin, SeoPluginResolver

logger = logging.getLogger(__name__)


def _build_seo_resolver(settings: Settings) -> SeoPluginResolver:
    """Build the per-publish SEO plugin resolver from settings.

    An explicit ``WP_SEO_PLUGIN`` becomes a no-network override; otherwise the
    resolver detects against the live WP target on demand (cached briefly).
    """
    configured = settings.wp_seo_plugin.strip().lower()
    override: SeoPlugin | None = None
    if configured == "yoast":
        override = "yoast"
    elif configured == "rankmath":
        override = "rankmath"
    return SeoPluginResolver(
        settings.wp_base_url,
        username=settings.wp_username,
        app_password=settings.wp_app_password,
        override=override,
    )


async def init_runtime(app: FastAPI, settings: Settings) -> None:
    """Wire the credentialed runtime (DB, Gemini, WP, executor) onto ``app.state``.

    Idempotent: disposes a prior engine so it can run again after first-run setup
    without a process restart. Caller must ensure credentials are present.
    """
    assert settings.postgres_url and settings.gemini_api_key, "init_runtime requires credentials"

    prior_engine = getattr(app.state, "engine", None)
    if prior_engine is not None:
        await prior_engine.dispose()

    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    gemini = RealGeminiClient(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
        thinking_level=settings.gemini_thinking_level,
    )
    seo_resolver = _build_seo_resolver(settings)
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
        seo_resolver=seo_resolver,
    )
    try:
        await executor.recover_orphaned()
    except Exception:
        logger.exception("orphaned run recovery failed at startup")

    app.state.engine = engine
    app.state.session_factory = sf
    prompts_store.configure(sf)
    source_policy_store.configure(sf)
    app.state.run_executor = executor
    app.state.wp_client = wp_client
    app.state.wp_options_cache = wp_options_cache
    app.state.gemini_client = gemini
    app.state.seo_plugin_resolver = seo_resolver
    app.state.wp_target = settings.wp_target
    app.state.configured = True


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Default to an unconfigured runtime so routes can detect "needs setup".
    app.state.engine = None
    app.state.session_factory = None
    app.state.run_executor = None
    app.state.wp_client = None
    app.state.gemini_client = None
    app.state.configured = False

    settings = get_settings()
    if is_configured(settings):
        # Never let a transient dependency hiccup (WordPress/DB unreachable at
        # launch) crash the lifespan: that would exit uvicorn and leave the
        # desktop shell pointing at a vanished backend with no recourse. Bind
        # the port regardless and surface the failure via logs + a degraded
        # state, so the frontend gate's polling can recover once deps return.
        try:
            await init_runtime(app, settings)
        except Exception:
            logger.exception("runtime init failed at startup; serving in degraded state")
            app.state.configured = False
    else:
        logger.info("awaiting setup: credentials not configured")

    try:
        yield
    finally:
        engine = getattr(app.state, "engine", None)
        if engine is not None:
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

    app.include_router(setup_router)
    app.include_router(runs_router)
    app.include_router(articles_router)
    app.include_router(compliance_router)
    app.include_router(costs_router)
    app.include_router(personas_router)
    app.include_router(prompts_router)
    app.include_router(source_policy_router)
    app.include_router(refresh_router)
    app.include_router(topic_batches_router)
    app.include_router(wp_options_router)
    FastAPIInstrumentor().instrument_app(app)
    return app


app = create_app()
