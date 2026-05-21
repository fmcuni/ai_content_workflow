from dataclasses import dataclass
from pathlib import Path
from typing import Any

from content_tool.gemini.client import GeminiClient

JUDGE_PROMPTS: dict[str, Path] = {
    "brand_voice": Path("evals/judge/brand_voice.md"),
    "coverage": Path("evals/judge/coverage.md"),
    "citation_alignment": Path("evals/judge/citation_alignment.md"),
    "hk_localisation": Path("evals/judge/hk_localisation.md"),
}


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
    prompt = JUDGE_PROMPTS[metric].read_text(encoding="utf-8")
    result = await gemini.generate(
        agent=f"judge.{metric}",
        system_prompt=prompt,
        user_prompt=user_payload,
        response_schema={"type": "object"},
        tools=["urlContext"] if use_url_context else [],
    )
    return JudgeResult(metric=metric, parsed=result.parsed)
