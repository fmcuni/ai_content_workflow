# ruff: noqa: RUF001
"""Topic hot-topic agent.

One Gemini call per candidate. Inspects the HK SERP for the topic and decides
whether it qualifies as a "hot topic." No retry/backoff here — that is the
topic-expansion subgraph's concern (Task 3).
"""

from sqlalchemy.ext.asyncio import AsyncSession

from content_tool import prompts_store
from content_tool.gemini.client import GeminiClient
from content_tool.models.topic_batch import TopicHotInput, TopicHotOutput
from content_tool.policy.personas import load_persona

# HK-ZH default market (mirrors VoiceLocale.market). Keeps the assembled prompt
# byte-identical for bowtie-editor when no voice locale override is present.
_DEFAULT_MARKET = "Google 香港繁中"


async def build_system_prompt(voice_slug: str = "bowtie-editor") -> str:
    return await prompts_store.get_assembled_standalone("topic_hot", voice_slug=voice_slug)


def build_user_prompt(input_: TopicHotInput, market: str = _DEFAULT_MARKET) -> str:
    keywords = ", ".join(input_.keywords) if input_.keywords else "（無）"
    return (
        f"請分析以下單一 topic 在 {market} SERP 是否屬於熱門話題。"
        "只輸出符合 schema 的 JSON。\n\n"
        f"topic:\n{input_.topic}\n\n"
        f"focus_keywords:\n{keywords}\n"
    )


async def run_topic_hot(
    *,
    gemini: GeminiClient,
    input: TopicHotInput,
    voice_slug: str = "bowtie-editor",
    session: AsyncSession | None = None,
) -> TopicHotOutput:
    """Single Gemini call. Returns the hot-topic verdict for one candidate.

    When ``session`` is supplied, the voice's :class:`VoiceLocale.market` is
    threaded into the user prompt (spec §4.4 item 7) so a non-HK voice asks about
    its own market. Without a session the HK-ZH default keeps the prompt
    byte-identical.
    """
    system_prompt = await build_system_prompt(voice_slug)
    market = _DEFAULT_MARKET
    if session is not None:
        pack = await load_persona(voice_slug, session=session)
        market = pack.locale.market
    user_prompt = build_user_prompt(input, market)
    result = await gemini.generate(
        agent="topic_hot",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=TopicHotOutput.model_json_schema(),
        tools=["googleSearch", "urlContext"],
    )
    return TopicHotOutput.model_validate(result.parsed)
