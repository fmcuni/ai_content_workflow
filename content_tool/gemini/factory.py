"""Factory for building a ``GeminiClient`` instance.

Single construction point used by all four call sites:
- ``content_tool/api/main.py``
- ``content_tool/cli.py``
- ``evals/runner.py``
- ``evals/run_judges_adhoc.py``

When ``LANGFUSE_ENABLED=true`` the returned client is an ``ObservedGeminiClient``
wrapping the real client.  When disabled (the default) it returns the
``RealGeminiClient`` unchanged — zero overhead, byte-identical behaviour.
"""

from __future__ import annotations

from content_tool.config import get_settings
from content_tool.gemini.client import GeminiClient, RealGeminiClient
from content_tool.gemini.observed import ObservedGeminiClient


def make_gemini_client(
    *,
    api_key: str,
    model: str,
    thinking_level: str,
) -> GeminiClient:
    """Build a ``GeminiClient``, wrapping it for Langfuse observation when enabled.

    Args:
        api_key: Gemini API key.
        model: Model name (e.g. ``"gemini-3.1-pro-preview"``).
        thinking_level: Thinking level token (``"low"``, ``"high"``, …).

    Returns:
        A ``GeminiClient`` — either ``RealGeminiClient`` directly (disabled) or
        ``ObservedGeminiClient(RealGeminiClient(...))`` (enabled).
    """
    inner: GeminiClient = RealGeminiClient(
        api_key=api_key,
        model=model,
        thinking_level=thinking_level,
    )

    settings = get_settings()
    if not settings.langfuse_enabled:
        return inner

    # Pass the model so each Langfuse generation carries it — this is what lets
    # Langfuse run model analytics and compute cost automatically from usage.
    return ObservedGeminiClient(inner, enabled=True, model=model)
