# ruff: noqa: RUF001
"""Topic-dedup agent.

One Gemini call per candidate. Looks up ``site:bowtie.com.hk/blog`` to decide
whether the input topic is already covered. No retry/backoff here — that is
the topic-expansion subgraph's concern (Task 3).
"""

from pathlib import Path

from content_tool.gemini.client import GeminiClient
from content_tool.models.topic_batch import TopicDedupInput, TopicDedupOutput

_PROMPT_DIR = Path(__file__).resolve().parents[2] / "prompts"
_PROMPT_PATH = _PROMPT_DIR / "topic_dedup.md"


def build_system_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def build_user_prompt(input_: TopicDedupInput) -> str:
    keywords = ", ".join(input_.keywords) if input_.keywords else "（無）"
    return (
        "請判斷以下單一 topic 在 site:bowtie.com.hk/blog 是否已有相同 topic 的文章。"
        "只輸出符合 schema 的 JSON。\n\n"
        f"topic:\n{input_.topic}\n\n"
        f"focus_keywords:\n{keywords}\n"
    )


async def run_topic_dedup(
    *,
    gemini: GeminiClient,
    input: TopicDedupInput,
) -> TopicDedupOutput:
    """Single Gemini call. Returns the dedup verdict for one candidate."""
    system_prompt = build_system_prompt()
    user_prompt = build_user_prompt(input)
    result = await gemini.generate(
        agent="topic_dedup",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=TopicDedupOutput.model_json_schema(),
        tools=["googleSearch", "urlContext"],
    )
    return TopicDedupOutput.model_validate(result.parsed)
