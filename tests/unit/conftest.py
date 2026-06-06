"""Unit-test fixtures.

Several agent/eval entrypoints (topic_gen, topic_dedup, topic_hot, judge_runner)
load their system prompt from the DB-backed ``prompts_store`` via
``get_assembled_standalone()``. The unit tests exercise the parsing/contract of
those functions against a ``FakeGeminiClient`` and must not require a database,
so we stub the prompt lookup with a deterministic placeholder. These tests
assert on the parsed model output, never on prompt text, so the placeholder is
sufficient. Tests that never call the lookup are unaffected.
"""

import pytest

from content_tool import prompts_store


@pytest.fixture(autouse=True)
def stub_assembled_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _stub(template_id: str, *, voice_slug: str = "__shared__") -> str:
        return f"[unit-test stub prompt for {template_id}]"

    monkeypatch.setattr(prompts_store, "get_assembled_standalone", _stub)
