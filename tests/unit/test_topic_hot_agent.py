import pytest

from content_tool.agents.topic_hot import build_user_prompt, run_topic_hot
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


def test_build_user_prompt_defaults_to_hk_market():
    """HK-ZH default market keeps the prompt byte-identical."""
    prompt = build_user_prompt(TopicHotInput(topic="T", keywords=[]))
    assert prompt == (
        "請分析以下單一 topic 在 Google 香港繁中 SERP 是否屬於熱門話題。"
        "只輸出符合 schema 的 JSON。\n\n"
        "topic:\nT\n\n"
        "focus_keywords:\n（無）\n"  # noqa: RUF001
    )


def test_build_user_prompt_interpolates_non_hk_market():
    """A non-HK voice asks about ITS market, not Google 香港繁中."""
    prompt = build_user_prompt(
        TopicHotInput(topic="T", keywords=[]),
        market="Google Malaysia (gobowtie.com/my)",
    )
    assert "Google Malaysia (gobowtie.com/my) SERP" in prompt
    assert "Google 香港繁中" not in prompt


@pytest.mark.asyncio
async def test_run_topic_hot_uses_voice_locale_market(monkeypatch: pytest.MonkeyPatch):
    """With a session, the voice's locale market lands in the user prompt."""
    from typing import cast

    from sqlalchemy.ext.asyncio import AsyncSession

    from content_tool.agents import topic_hot as topic_hot_mod
    from content_tool.models.persona import PersonaPack, VoiceLocale

    async def _fake_load_persona(slug: str, *, session: object) -> PersonaPack:
        return PersonaPack(
            name="Bowtie MY EN",
            voice_rules=[],
            banned_terms=[],
            required_phrasings=[],
            disclaimer_templates={},
            tone_examples={},
            locale=VoiceLocale(market="Google Malaysia (gobowtie.com/my)"),
        )

    monkeypatch.setattr(topic_hot_mod, "load_persona", _fake_load_persona)

    canned = {"hot_topic": "no", "hot_topic_note": "x"}
    client = FakeGeminiClient(canned_responses={"topic_hot": canned})

    await run_topic_hot(
        gemini=client,
        input=TopicHotInput(topic="T", keywords=["a"]),
        voice_slug="bowtie-en-my",
        session=cast(AsyncSession, object()),  # sentinel; load_persona is stubbed
    )

    call = client.calls[0]
    assert "Google Malaysia (gobowtie.com/my) SERP" in call["user_prompt"]
    assert "Google 香港繁中" not in call["user_prompt"]


@pytest.mark.asyncio
async def test_run_topic_hot_defaults_to_hk_market_without_session():
    """No session (current caller) → HK-ZH market, byte-identical."""
    canned = {"hot_topic": "no", "hot_topic_note": "x"}
    client = FakeGeminiClient(canned_responses={"topic_hot": canned})

    await run_topic_hot(
        gemini=client,
        input=TopicHotInput(topic="T", keywords=["a"]),
    )

    call = client.calls[0]
    assert "Google 香港繁中 SERP" in call["user_prompt"]
