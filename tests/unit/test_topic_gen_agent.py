# ruff: noqa: RUF001, RUF003
import pytest
from pydantic import ValidationError

from content_tool.agents.topic_gen import run_topic_gen
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.models.topic_batch import TopicGenInput


@pytest.mark.asyncio
async def test_topic_gen_returns_parsed_candidates():
    canned = {
        "topics": [
            {"topic": "退保須知", "keywords": ["退保", "cash value"]},
            {"topic": "VHIS 自願醫保比較", "keywords": ["VHIS", "標準計劃", "靈活計劃"]},
        ]
    }
    client = FakeGeminiClient(canned_responses={"topic_gen": canned})

    out = await run_topic_gen(
        gemini=client,
        input=TopicGenInput(
            research_theme="香港新手保險入門",
            target_audience="25-35 香港首次投保人士",
            topic_count=2,
            keywords_per_topic=3,
            must_cover=["VHIS", "醫療保險"],
            must_avoid=["non-HK markets"],
            priority_focus="實用比較",
            notes=None,
        ),
    )

    assert len(out.topics) == 2
    assert out.topics[0].topic == "退保須知"
    assert out.topics[0].keywords == ["退保", "cash value"]
    assert out.topics[1].topic == "VHIS 自願醫保比較"


@pytest.mark.asyncio
async def test_topic_gen_passes_grounding_tools():
    canned = {"topics": [{"topic": "t", "keywords": ["k"]}]}
    client = FakeGeminiClient(canned_responses={"topic_gen": canned})

    await run_topic_gen(
        gemini=client,
        input=TopicGenInput(
            research_theme="x",
            target_audience="y",
            topic_count=1,
            keywords_per_topic=1,
        ),
    )

    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["agent"] == "topic_gen"
    assert call["tools"] == ["googleSearch", "urlContext"]
    # User prompt should carry the formatted brief.
    assert "研究主題：x" in call["user_prompt"]
    assert "目標受眾：y" in call["user_prompt"]
    # Empty list fields should render as 「（無）」.
    assert "必須涵蓋範疇：\n（無）" in call["user_prompt"]


@pytest.mark.asyncio
async def test_topic_gen_validates_output_schema():
    # Missing required field "keywords" — model_validate should raise.
    client = FakeGeminiClient(
        canned_responses={"topic_gen": {"topics": [{"topic": "only-topic"}]}}
    )
    with pytest.raises(ValidationError):
        await run_topic_gen(
            gemini=client,
            input=TopicGenInput(
                research_theme="x",
                target_audience="y",
                topic_count=1,
                keywords_per_topic=1,
            ),
        )
