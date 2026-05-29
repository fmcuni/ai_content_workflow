# ruff: noqa: RUF001
"""Topic-generation agent.

One Gemini call: take a research brief and produce a list of pillar-topic
candidates with focus keywords. No DB writes — the caller (topic-expansion
subgraph in Task 3) persists the rows.
"""

from content_tool import prompts_store
from content_tool.gemini.client import GeminiClient
from content_tool.models.topic_batch import TopicGenInput, TopicGenOutput


def _format_list_block(items: list[str]) -> str:
    if not items:
        return "（無）"
    return "\n".join(f"- {item}" for item in items)


async def build_system_prompt() -> str:
    return await prompts_store.get_assembled_standalone("topic_gen")


def build_user_prompt(input_: TopicGenInput) -> str:
    return (
        "請根據以下研究設定產出結果。\n\n"
        f"研究主題：{input_.research_theme}\n"
        f"目標受眾：{input_.target_audience}\n"
        f"主題數量：{input_.topic_count}\n"
        f"每個主題關鍵字數量：{input_.keywords_per_topic}\n\n"
        f"必須涵蓋範疇：\n{_format_list_block(input_.must_cover)}\n\n"
        f"避免主題：\n{_format_list_block(input_.must_avoid)}\n\n"
        f"額外偏重方向：\n{input_.priority_focus or '（無）'}\n\n"
        f"補充要求：\n{input_.notes or '（無）'}\n"
    )


async def run_topic_gen(
    *,
    gemini: GeminiClient,
    input: TopicGenInput,
) -> TopicGenOutput:
    """Single Gemini call. Returns validated topic candidates."""
    system_prompt = await build_system_prompt()
    user_prompt = build_user_prompt(input)
    result = await gemini.generate(
        agent="topic_gen",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=TopicGenOutput.model_json_schema(),
        tools=["googleSearch", "urlContext"],
    )
    return TopicGenOutput.model_validate(result.parsed)
