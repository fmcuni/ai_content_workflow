"""Lazy Langfuse singleton — safe, optional observability client.

All callers MUST use ``get_langfuse()`` to access the client.  When
``LANGFUSE_ENABLED`` is ``False`` (the default) every public function in this
module is a no-op and the ``langfuse`` package is never imported, so the app
boots even if the package is absent from the environment.

Design invariant: **Langfuse failures must never propagate to callers**.
Every public helper catches and logs exceptions rather than raising.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # Imported only for type-checking so pyright can validate call sites.
    # At runtime the import is guarded inside _init_client().
    from langfuse import Langfuse  # pyright: ignore[reportMissingTypeStubs]

logger = logging.getLogger(__name__)

# Module-level singleton. ``None`` means either disabled or not yet
# initialised; ``_initialised`` tracks whether we have already attempted
# initialisation so we don't retry on every get_langfuse() call.
_client: Langfuse | None = None
_initialised: bool = False


def init_langfuse() -> None:
    """Initialise the Langfuse client from settings.

    Idempotent — safe to call more than once (e.g. from lifespan and tests).
    A disabled flag or missing keys leave ``_client`` as ``None`` silently.
    All exceptions are caught so a misconfiguration never crashes startup.
    """
    global _client, _initialised

    if _initialised:
        return

    _initialised = True

    from content_tool.config import get_settings

    settings = get_settings()
    if not settings.langfuse_enabled:
        return

    if not settings.langfuse_public_key or not settings.langfuse_secret_key:
        logger.warning(
            "LANGFUSE_ENABLED=true but LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY "
            "are not set — Langfuse integration disabled"
        )
        return

    try:
        from langfuse import Langfuse  # pyright: ignore[reportMissingTypeStubs]

        _client = Langfuse(
            public_key=settings.langfuse_public_key,
            secret_key=settings.langfuse_secret_key,
            host=settings.langfuse_host,
        )
        logger.info("Langfuse client initialised", extra={"host": settings.langfuse_host})
    except Exception:
        logger.exception("Failed to initialise Langfuse client — observability disabled")
        _client = None


def get_langfuse() -> Langfuse | None:
    """Return the active Langfuse client, or ``None`` when disabled/uninitialised."""
    return _client


async def flush_langfuse() -> None:
    """Flush any queued Langfuse events.  No-op when disabled.

    Called at application shutdown to ensure in-flight spans are flushed
    before the process exits.  Swallows all exceptions.
    """
    if _client is None:
        return
    try:
        _client.flush()
    except Exception:
        logger.exception("Langfuse flush failed — some traces may be lost")


def reset_for_testing(client: Any = None) -> None:  # noqa: ANN401
    """Replace the singleton with a test double and reset the init guard.

    Only for use in tests — never call from production code.
    """
    global _client, _initialised
    _client = client
    _initialised = client is not None
