"""Tests for the thought-emitter plumbing wired into RealGeminiClient.

The Gemini SDK is mocked so these tests don't reach the network. We only
verify that:
  1. With an emitter bound on the ContextVar, the client calls
     ``generate_content_stream`` with ``include_thoughts=True`` and forwards
     each ``thought=True`` part to the emitter.
  2. Without an emitter, the client uses the one-shot ``generate_content``
     path and never enables ``include_thoughts``.
  3. The emitter raising does NOT abort the surrounding generate call.
"""

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from content_tool.gemini.client import RealGeminiClient
from content_tool.gemini.streaming import (
    get_thought_emitter,
    set_thought_emitter,
)


class _Part:
    def __init__(self, text: str, thought: bool = False) -> None:
        self.text = text
        self.thought = thought


class _Content:
    def __init__(self, parts: list[_Part]) -> None:
        self.parts = parts


class _Candidate:
    def __init__(self, parts: list[_Part]) -> None:
        self.content = _Content(parts)
        self.grounding_metadata = None
        self.finish_reason = None


class _Usage:
    prompt_token_count = 17
    candidates_token_count = 42
    thoughts_token_count = 9


class _Chunk:
    def __init__(self, parts: list[_Part], *, with_usage: bool = False) -> None:
        self.candidates = [_Candidate(parts)] if parts else []
        self.usage_metadata = _Usage() if with_usage else None


async def _fake_stream(chunks: list[_Chunk]):
    for c in chunks:
        yield c


def _build_client(stream_chunks: list[_Chunk] | None) -> tuple[RealGeminiClient, Any]:
    """Build a RealGeminiClient with the SDK client swapped for a mock.

    ``stream_chunks`` is what the fake ``generate_content_stream`` yields;
    pass ``None`` if the test expects the streaming path NOT to be taken.
    """
    client = RealGeminiClient.__new__(RealGeminiClient)
    client._model = "gemini-3.5-pro"
    client._thinking_level = "high"
    aio = MagicMock()
    aio.models = MagicMock()
    if stream_chunks is not None:
        aio.models.generate_content_stream = AsyncMock(
            return_value=_fake_stream(stream_chunks)
        )
    else:
        aio.models.generate_content_stream = AsyncMock(
            side_effect=AssertionError("stream path must not be taken")
        )

    one_shot_response = MagicMock()
    one_shot_response.text = '{"ok": true}'
    one_shot_response.usage_metadata = _Usage()
    one_shot_response.candidates = [_Candidate([_Part('{"ok": true}')])]
    aio.models.generate_content = AsyncMock(return_value=one_shot_response)

    sdk = MagicMock()
    sdk.aio = aio
    client._client = sdk
    return client, aio


@pytest.fixture(autouse=True)
def _reset_emitter():
    set_thought_emitter(None)
    yield
    set_thought_emitter(None)


@pytest.mark.asyncio
async def test_stream_forwards_thoughts_to_emitter():
    chunks = [
        _Chunk([_Part("Considering the rewrite scope…", thought=True)]),
        _Chunk([_Part('{"diagnose":')]),
        _Chunk([_Part("Now drafting H1…", thought=True)]),
        _Chunk([_Part('"ok","markup":"# H1"}')], with_usage=True),
    ]
    client, aio = _build_client(stream_chunks=chunks)

    captured: list[tuple[str, str]] = []

    async def emit(agent: str, text: str) -> None:
        captured.append((agent, text))

    set_thought_emitter(emit)

    result = await client.generate(
        agent="writer",
        system_prompt="sys",
        user_prompt="usr",
        response_schema={"type": "object"},
        tools=[],
    )

    assert captured == [
        ("writer", "Considering the rewrite scope…"),
        ("writer", "Now drafting H1…"),
    ]
    assert result.raw_text == '{"diagnose":"ok","markup":"# H1"}'
    assert result.tokens_in == 17
    assert result.tokens_out == 42
    assert result.thinking_tokens == 9
    aio.models.generate_content_stream.assert_awaited_once()
    call = aio.models.generate_content_stream.await_args
    assert call.kwargs["config"].thinking_config.include_thoughts is True


@pytest.mark.asyncio
async def test_no_emitter_uses_one_shot_path():
    client, aio = _build_client(stream_chunks=None)
    assert get_thought_emitter() is None

    result = await client.generate(
        agent="writer",
        system_prompt="sys",
        user_prompt="usr",
        response_schema={"type": "object"},
        tools=[],
    )

    aio.models.generate_content.assert_awaited_once()
    call = aio.models.generate_content.await_args
    # include_thoughts must remain unset so we don't bill thought tokens for
    # the CLI / refresh / batch callers that never read them.
    assert call.kwargs["config"].thinking_config.include_thoughts is None
    assert result.parsed == {"ok": True}


@pytest.mark.asyncio
async def test_emitter_error_does_not_abort_stream():
    chunks = [
        _Chunk([_Part("thought one", thought=True)]),
        _Chunk([_Part('{"ok": true}')], with_usage=True),
    ]
    client, _ = _build_client(stream_chunks=chunks)

    async def boom(agent: str, text: str) -> None:
        raise RuntimeError("subscriber dropped")

    set_thought_emitter(boom)

    result = await client.generate(
        agent="writer",
        system_prompt="sys",
        user_prompt="usr",
        response_schema={"type": "object"},
        tools=[],
    )
    assert result.parsed == {"ok": True}
    assert result.tokens_out == 42
