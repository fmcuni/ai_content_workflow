import pytest

from content_tool.agents.topic_hot import run_topic_hot
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.models.topic_batch import TopicHotInput


@pytest.mark.asyncio
async def test_topic_hot_returns_hot_verdict():
    canned = {
        "hot_topic": "yes",
        "hot_topic_note": "近期 LIHKG、HK01、政府網站均有大量討論。",
    }
    client = FakeGeminiClient(canned_responses={"topic_hot": canned})

    out = await run_topic_hot(
        gemini=client,
        input=TopicHotInput(topic="VHIS 2026 更新", keywords=["VHIS", "扣稅"]),
    )

    assert out.hot_topic == "yes"
    assert out.hot_topic_note


@pytest.mark.asyncio
async def test_topic_hot_passes_grounding_tools():
    canned = {"hot_topic": "no", "hot_topic_note": "SERP 多為靜態介紹頁。"}
    client = FakeGeminiClient(canned_responses={"topic_hot": canned})

    await run_topic_hot(
        gemini=client,
        input=TopicHotInput(topic="長青概念", keywords=["a"]),
    )

    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["agent"] == "topic_hot"
    assert call["tools"] == ["googleSearch", "urlContext"]
    assert "topic:\n長青概念" in call["user_prompt"]
