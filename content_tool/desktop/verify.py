"""Credential verification for the desktop setup flow.

Checks that the supplied Postgres URL and Gemini API key actually work before
the setup endpoint persists them. Failures are logged by exception *type* only —
never the connection string or key.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text

from content_tool.db.connection import make_engine
from content_tool.gemini.client import RealGeminiClient

logger = logging.getLogger(__name__)

_PG_TIMEOUT_S = 5.0
_GEMINI_TIMEOUT_S = 20.0


async def verify_postgres(postgres_url: str, *, timeout: float = _PG_TIMEOUT_S) -> bool:  # noqa: ASYNC109 — timeout is applied via asyncio.timeout below; param kept for tests
    """Return True if a ``SELECT 1`` succeeds against the given URL."""
    engine = make_engine(postgres_url)
    try:
        async with asyncio.timeout(timeout), engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception as exc:
        logger.warning("postgres verification failed: %s", type(exc).__name__)
        return False
    finally:
        await engine.dispose()


async def verify_gemini(
    api_key: str, model: str, *, timeout: float = _GEMINI_TIMEOUT_S  # noqa: ASYNC109 — applied via asyncio.timeout; param kept for tests
) -> bool:
    """Return True if a minimal Gemini call succeeds with the given key."""
    client = RealGeminiClient(api_key=api_key, model=model, thinking_level="low")
    try:
        async with asyncio.timeout(timeout):
            await client.generate(
                agent="setup_verify",
                system_prompt="",
                user_prompt="ping",
                response_schema=None,
                tools=[],
            )
        return True
    except Exception as exc:
        logger.warning("gemini verification failed: %s", type(exc).__name__)
        return False


async def verify_credentials(
    *, postgres_url: str, gemini_api_key: str, gemini_model: str
) -> dict[str, bool]:
    """Run both checks concurrently and report per-check results."""
    postgres_ok, gemini_ok = await asyncio.gather(
        verify_postgres(postgres_url),
        verify_gemini(gemini_api_key, gemini_model),
    )
    return {"postgres": postgres_ok, "gemini": gemini_ok}
