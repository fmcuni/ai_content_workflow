from dataclasses import dataclass
from typing import Any

from content_tool import prompts_store
from content_tool.gemini.client import GeminiClient


@dataclass
class JudgeResult:
    metric: str
    parsed: dict[str, Any]


async def run_judge(
    *,
    gemini: GeminiClient,
    metric: str,
    user_payload: str,
    use_url_context: bool = False,
) -> JudgeResult:
    prompt = await prompts_store.get_assembled_standalone(f"judge_{metric}")
    result = await gemini.generate(
        agent=f"judge.{metric}",
        system_prompt=prompt,
        user_prompt=user_payload,
        response_schema={"type": "object"},
        tools=["urlContext"] if use_url_context else [],
    )
    return JudgeResult(metric=metric, parsed=result.parsed)
