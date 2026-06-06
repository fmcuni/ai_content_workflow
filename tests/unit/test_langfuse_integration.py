"""Unit tests for the Langfuse integration.

All tests use an in-process fake/spy — no network calls, no real Langfuse
server.  Tests verify:

1. ``ObservedGeminiClient`` is a pure passthrough when disabled.
2. ``ObservedGeminiClient`` records a generation when enabled (spy capture).
3. ``make_gemini_client`` returns ``RealGeminiClient`` when disabled and
   ``ObservedGeminiClient`` when enabled.
4. ``set_prompt_meta`` / ``get_prompt_meta`` and ``set_run_context`` /
   ``get_run_context`` work as independent contextvars.
"""

from __future__ import annotations

import pytest

from content_tool.gemini.client import GeminiResult
from content_tool.gemini.observed import ObservedGeminiClient
from content_tool.gemini.prompt_context import (
    PromptMeta,
    RunContext,
    get_prompt_meta,
    get_run_context,
    set_prompt_meta,
    set_run_context,
)

# ---------------------------------------------------------------------------
# Helpers / fakes
# ---------------------------------------------------------------------------


class _FakeInnerClient:
    """Minimal GeminiClient fake that records calls and returns a fixed result."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def generate(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: object,
        tools: list[str],
    ) -> GeminiResult:
        self.calls.append(
            {
                "agent": agent,
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
                "response_schema": response_schema,
                "tools": tools,
            }
        )
        return GeminiResult(
            parsed={"ok": True},
            raw_text='{"ok": true}',
            tokens_in=10,
            tokens_out=5,
            thinking_tokens=0,
            latency_ms=42,
        )


class _FakeLangfuseGeneration:
    """Spy for lf.start_observation(as_type='generation', ...)."""

    def __init__(self, *, name: str, **kwargs: object) -> None:
        self.name = name
        self.init_kwargs = kwargs
        self.end_called: bool = False

    def end(self) -> None:
        self.end_called = True


class _FakeLangfuse:
    """Spy replacing the real Langfuse client singleton."""

    def __init__(self) -> None:
        self.generations: list[_FakeLangfuseGeneration] = []

    def start_observation(self, *, name: str, **kwargs: object) -> _FakeLangfuseGeneration:
        gen = _FakeLangfuseGeneration(name=name, **kwargs)
        self.generations.append(gen)
        return gen

    def flush(self) -> None:
        pass


# ---------------------------------------------------------------------------
# 1. Passthrough when disabled
# ---------------------------------------------------------------------------


async def test_observed_passthrough_when_disabled() -> None:
    inner = _FakeInnerClient()
    client = ObservedGeminiClient(inner, enabled=False)

    result = await client.generate(
        agent="writer",
        system_prompt="sys",
        user_prompt="user",
        response_schema=None,
        tools=[],
    )

    assert result.parsed == {"ok": True}
    assert len(inner.calls) == 1
    # _record is never called when disabled — no Langfuse import attempted


# ---------------------------------------------------------------------------
# 2. Records a generation when enabled
# ---------------------------------------------------------------------------


async def test_observed_records_generation_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.observability import langfuse_client

    fake_lf = _FakeLangfuse()
    langfuse_client.reset_for_testing(fake_lf)

    inner = _FakeInnerClient()
    client = ObservedGeminiClient(inner, enabled=True, model="gemini-3.1-pro-preview")

    set_prompt_meta(
        PromptMeta(template_id="writer_full_rewrite", voice_slug="bowtie-editor", sha256="abc123")
    )
    set_run_context(RunContext(run_id="run-42"))

    result = await client.generate(
        agent="writer",
        system_prompt="sys",
        user_prompt="user",
        response_schema={"type": "object"},
        tools=[],
    )

    assert result.parsed == {"ok": True}

    # Exactly one generation recorded
    assert len(fake_lf.generations) == 1
    gen = fake_lf.generations[0]
    assert gen.name == "writer"
    # model drives Langfuse model analytics + automatic cost calculation
    assert gen.init_kwargs["model"] == "gemini-3.1-pro-preview"
    # trace_context groups all generations from one run under a deterministic,
    # 32-hex OTEL trace id derived from run_id (v4 rejects raw run_id strings).
    from langfuse import Langfuse

    expected_trace_id = Langfuse.create_trace_id(seed="run-42")
    assert gen.init_kwargs["trace_context"] == {"trace_id": expected_trace_id}
    assert len(expected_trace_id) == 32 and expected_trace_id == expected_trace_id.lower()
    assert gen.init_kwargs["metadata"]["template_id"] == "writer_full_rewrite"
    assert gen.init_kwargs["metadata"]["prompt_sha256"] == "abc123"
    assert gen.init_kwargs["metadata"]["voice_slug"] == "bowtie-editor"
    assert gen.init_kwargs["metadata"]["latency_ms"] == 42
    assert gen.init_kwargs["usage_details"]["input"] == 10
    assert gen.init_kwargs["usage_details"]["output"] == 5
    # end() was called
    assert gen.end_called is True

    # Cleanup singleton
    langfuse_client.reset_for_testing(None)


# ---------------------------------------------------------------------------
# 3. Factory wiring
# ---------------------------------------------------------------------------


def test_factory_returns_real_client_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LANGFUSE_ENABLED", "false")
    # Clear lru_cache so the new env var is picked up
    from content_tool.config import Settings
    from content_tool.gemini import factory
    from content_tool.gemini.client import RealGeminiClient

    # Patch get_settings to return fresh Settings
    monkeypatch.setattr(factory, "get_settings", lambda: Settings(
        langfuse_enabled=False,
        gemini_api_key="fake",
        postgres_url="postgresql+asyncpg://x:x@localhost/x",
    ))

    client = factory.make_gemini_client(api_key="fake", model="gemini-x", thinking_level="low")
    assert isinstance(client, RealGeminiClient)


def test_factory_returns_observed_client_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.config import Settings
    from content_tool.gemini import factory

    monkeypatch.setattr(factory, "get_settings", lambda: Settings(
        langfuse_enabled=True,
        gemini_api_key="fake",
        postgres_url="postgresql+asyncpg://x:x@localhost/x",
    ))

    client = factory.make_gemini_client(api_key="fake", model="gemini-x", thinking_level="low")
    assert isinstance(client, ObservedGeminiClient)


# ---------------------------------------------------------------------------
# 4. ContextVar set/get
# ---------------------------------------------------------------------------


def test_prompt_meta_contextvar_round_trip() -> None:
    meta = PromptMeta(template_id="gap_analysis", voice_slug="bowtie-editor", sha256="deadbeef")
    set_prompt_meta(meta)
    assert get_prompt_meta() == meta


def test_run_context_contextvar_round_trip() -> None:
    ctx = RunContext(run_id="run-99")
    set_run_context(ctx)
    assert get_run_context() == ctx


def test_prompt_meta_default_is_none() -> None:
    set_prompt_meta(None)
    assert get_prompt_meta() is None


def test_run_context_default_is_none() -> None:
    set_run_context(None)
    assert get_run_context() is None


# ---------------------------------------------------------------------------
# 5. Langfuse errors do not propagate
# ---------------------------------------------------------------------------


async def test_observed_swallows_langfuse_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A broken Langfuse client must never break a generate() call."""
    from content_tool.observability import langfuse_client

    class _BrokenLangfuse:
        def start_observation(self, **kwargs: object) -> object:
            raise RuntimeError("Langfuse is down")

        def flush(self) -> None:
            pass

    langfuse_client.reset_for_testing(_BrokenLangfuse())

    inner = _FakeInnerClient()
    client = ObservedGeminiClient(inner, enabled=True)

    # Should NOT raise — error is swallowed by _record
    result = await client.generate(
        agent="writer",
        system_prompt="sys",
        user_prompt="user",
        response_schema=None,
        tools=[],
    )
    assert result.parsed == {"ok": True}

    langfuse_client.reset_for_testing(None)
