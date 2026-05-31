from dataclasses import dataclass
from typing import Any

from content_tool import prompts_store
from content_tool.gemini.client import GeminiClient


@dataclass
class JudgeResult:
    metric: str
    parsed: dict[str, Any]


# Response schemas per judge metric. Gemini structured-output (responseJsonSchema)
# returns an empty object when handed a bare {"type": "object"}, ignoring the
# rubric prompt's requested shape — so each judge must declare the exact fields it
# expects for the model to populate them. Shapes mirror the rubrics in
# evals/judge/<metric>.md.
JUDGE_SCHEMAS: dict[str, dict[str, Any]] = {
    "brand_voice": {
        "type": "object",
        "properties": {
            "score": {"type": "integer"},
            "issues": {"type": "array", "items": {"type": "string"}},
            "matched_required_phrasings": {"type": "array", "items": {"type": "string"}},
            "found_banned_terms": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["score", "issues"],
    },
    "hk_localisation": {
        "type": "object",
        "properties": {
            "localisation_score": {"type": "integer"},
            "mainland_terms_found": {"type": "array", "items": {"type": "string"}},
            "non_hk_phrasings": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["localisation_score"],
    },
    "coverage": {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "plan_item": {"type": "string"},
                        "category": {"type": "string"},
                        "addressed": {"type": "boolean"},
                        "evidence": {"type": "string"},
                    },
                    "required": ["plan_item", "addressed"],
                },
            },
            "coverage_rate": {"type": "number"},
        },
        "required": ["coverage_rate"],
    },
    "citation_alignment": {
        "type": "object",
        "properties": {
            "alignments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim": {"type": "string"},
                        "url": {"type": "string"},
                        "supported": {"type": "boolean"},
                        "evidence_excerpt": {"type": "string"},
                    },
                    "required": ["claim", "supported"],
                },
            },
            "support_rate": {"type": "number"},
        },
        "required": ["support_rate"],
    },
}

_DEFAULT_SCHEMA: dict[str, Any] = {"type": "object"}


async def run_judge(
    *,
    gemini: GeminiClient,
    metric: str,
    user_payload: str,
    use_url_context: bool = False,
    response_schema: dict[str, Any] | None = None,
) -> JudgeResult:
    prompt = await prompts_store.get_assembled_standalone(f"judge_{metric}")
    schema = response_schema or JUDGE_SCHEMAS.get(metric, _DEFAULT_SCHEMA)
    result = await gemini.generate(
        agent=f"judge.{metric}",
        system_prompt=prompt,
        user_prompt=user_payload,
        response_schema=schema,
        tools=["urlContext"] if use_url_context else [],
    )
    return JudgeResult(metric=metric, parsed=result.parsed)
