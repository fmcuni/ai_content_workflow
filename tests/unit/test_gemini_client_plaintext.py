"""Regression tests for the ``response_schema=None`` path of RealGeminiClient.

When ``generate`` is called with ``response_schema=None`` and a plain prompt,
Gemini replies with prose (e.g. "Pong! ..."), which is NOT JSON. The client must
treat that as success — the raw text is preserved and ``parsed`` is left empty —
instead of raising while trying to parse the prose as JSON.
"""

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from content_tool.gemini.client import RealGeminiClient
from content_tool.gemini.streaming import set_thought_emitter


class _Usage:
    prompt_token_count = 5
    candidates_token_count = 7
    thoughts_token_count = 0


def _build_one_shot_client(reply_text: str) -> RealGeminiClient:
    """RealGeminiClient whose one-shot ``generate_content`` returns ``reply_text``."""
    client = RealGeminiClient.__new__(RealGeminiClient)
    client._model = "gemini-3.1-pro-preview"
    client._thinking_level = "low"

    response = MagicMock()
    response.text = reply_text
    response.usage_metadata = _Usage()
    response.candidates = []

    aio = MagicMock()
    aio.models = MagicMock()
    aio.models.generate_content = AsyncMock(return_value=response)

    sdk = MagicMock()
    sdk.aio = aio
    client._client = sdk
    return client


@pytest.fixture(autouse=True)
def _reset_emitter():
    set_thought_emitter(None)
    yield
    set_thought_emitter(None)


@pytest.mark.asyncio
async def test_plaintext_reply_with_no_schema_does_not_raise():
    # Arrange: no schema requested; model returns prose like the setup ping does.
    client = _build_one_shot_client("Pong! How can I help you today?")

    # Act
    result = await client.generate(
        agent="setup_verify",
        system_prompt="",
        user_prompt="ping",
        response_schema=None,
        tools=[],
    )

    # Assert: success, raw text preserved, parsed left empty (no JSON expected).
    assert result.parsed == {}
    assert result.raw_text == "Pong! How can I help you today?"


@pytest.mark.asyncio
async def test_json_reply_with_schema_still_parses():
    # Arrange: a schema IS requested, so JSON must still be parsed as before.
    client = _build_one_shot_client('{"ok": true}')
    schema: dict[str, Any] = {"type": "object", "properties": {"ok": {"type": "boolean"}}}

    # Act
    result = await client.generate(
        agent="audit",
        system_prompt="",
        user_prompt="go",
        response_schema=schema,
        tools=[],
    )

    # Assert
    assert result.parsed == {"ok": True}
