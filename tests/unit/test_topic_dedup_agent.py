# ruff: noqa: RUF001, RUF003
import pytest

from content_tool.agents.topic_dedup import run_topic_dedup
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.models.topic_batch import TopicDedupInput


@pytest.mark.asyncio
async def test_topic_dedup_returns_existing_verdict():
    canned = {
        "existing": "yes",
        "existing_note": "Bowtie blog 已有同題文章。",
        "existing_url": "https://www.bowtie.com.hk/blog/zh/foo",
    }
    client = FakeGeminiClient(canned_responses={"topic_dedup": canned})

    out = await run_topic_dedup(
        gemini=client,
        input=TopicDedupInput(topic="退保須知", keywords=["退保", "cash value"]),
    )

    assert out.existing == "yes"
    assert out.existing_url.startswith("https://www.bowtie.com.hk")
    assert out.existing_note


@pytest.mark.asyncio
async def test_topic_dedup_passes_grounding_tools():
    canned = {"existing": "no", "existing_note": "未找到對應文章。", "existing_url": ""}
    client = FakeGeminiClient(canned_responses={"topic_dedup": canned})

    await run_topic_dedup(
        gemini=client,
        input=TopicDedupInput(topic="某新題", keywords=["a", "b"]),
    )

    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["agent"] == "topic_dedup"
    assert call["tools"] == ["googleSearch", "urlContext"]
    assert "topic:\n某新題" in call["user_prompt"]
    assert "a, b" in call["user_prompt"]


@pytest.mark.asyncio
async def test_topic_dedup_accepts_not_sure():
    canned = {
        "existing": "not_sure",
        "existing_note": "找到近似但非完全對應的文章。",
        "existing_url": "https://www.bowtie.com.hk/blog/zh/bar",
    }
    client = FakeGeminiClient(canned_responses={"topic_dedup": canned})
    out = await run_topic_dedup(
        gemini=client,
        input=TopicDedupInput(topic="x", keywords=[]),
    )
    assert out.existing == "not_sure"
    # Empty-keywords path renders 「（無）」 in the user prompt.
    assert "focus_keywords:\n（無）" in client.calls[0]["user_prompt"]
