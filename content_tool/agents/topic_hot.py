# ruff: noqa: RUF001
"""Topic hot-topic agent.

One Gemini call per candidate. Inspects the HK SERP for the topic and decides
whether it qualifies as a "hot topic." No retry/backoff here — that is the
topic-expansion subgraph's concern (Task 3).
"""

from content_tool import prompts_store
from content_tool.gemini.client import GeminiClient
from content_tool.models.topic_batch import TopicHotInput, TopicHotOutput


async def build_system_prompt() -> str:
    return await prompts_store.get_assembled_standalone("topic_hot")


def build_user_prompt(input_: TopicHotInput) -> str:
    keywords = ", ".join(input_.keywords) if input_.keywords else "（無）"
    return (
        "請分析以下單一 topic 在 Google 香港繁中 SERP 是否屬於熱門話題。"
        "只輸出符合 schema 的 JSON。\n\n"
        f"topic:\n{input_.topic}\n\n"
        f"focus_keywords:\n{keywords}\n"
    )


async def run_topic_hot(
    *,
    gemini: GeminiClient,
    input: TopicHotInput,
) -> TopicHotOutput:
    """Single Gemini call. Returns the hot-topic verdict for one candidate."""
    system_prompt = await build_system_prompt()
    user_prompt = build_user_prompt(input)
    result = await gemini.generate(
        agent="topic_hot",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=TopicHotOutput.model_json_schema(),
        tools=["googleSearch", "urlContext"],
    )
    return TopicHotOutput.model_validate(result.parsed)
