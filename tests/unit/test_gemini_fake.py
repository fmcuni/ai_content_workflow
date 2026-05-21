import json
from pathlib import Path

import pytest

from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_fake_returns_canned_response():
    fixture = Path("tests/fixtures/gemini_responses/gap_analysis_ok.json")
    canned = json.loads(fixture.read_text(encoding="utf-8"))  # noqa: ASYNC240
    client = FakeGeminiClient(canned_responses={"gap_analysis": canned})
    result = await client.generate(
        agent="gap_analysis",
        system_prompt="...",
        user_prompt="...",
        response_schema={"type": "object"},
        tools=["googleSearch"],
    )
    assert result.parsed == canned
    assert result.tokens_in > 0
    assert result.tokens_out > 0


@pytest.mark.asyncio
async def test_fake_raises_when_no_canned():
    client = FakeGeminiClient(canned_responses={})
    with pytest.raises(KeyError, match="gap_analysis"):
        await client.generate(
            agent="gap_analysis",
            system_prompt="...",
            user_prompt="...",
            response_schema={"type": "object"},
            tools=[],
        )
