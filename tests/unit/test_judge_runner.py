import pytest

from content_tool.gemini.fake import FakeGeminiClient
from evals.judge_runner import run_judge


@pytest.mark.asyncio
async def test_judge_runner_returns_parsed():
    canned = {
        "judge.brand_voice": {
            "score": 5,
            "issues": [],
            "matched_required_phrasings": ["自願醫保"],
            "found_banned_terms": [],
        }
    }
    gemini = FakeGeminiClient(canned_responses=canned)
    res = await run_judge(gemini=gemini, metric="brand_voice", user_payload="hi")
    assert res.parsed["score"] == 5
