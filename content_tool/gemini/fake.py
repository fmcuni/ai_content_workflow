import json
from typing import Any

from content_tool.gemini.client import GeminiResult


class FakeGeminiClient:
    def __init__(self, canned_responses: dict[str, dict[str, Any]]) -> None:
        self._canned = canned_responses
        self.calls: list[dict[str, Any]] = []

    async def generate(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any] | None,
        tools: list[str],
    ) -> GeminiResult:
        self.calls.append({
            "agent": agent,
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "tools": tools,
        })
        if agent not in self._canned:
            raise KeyError(f"No canned response for agent={agent}")
        parsed = self._canned[agent]
        return GeminiResult(
            parsed=parsed,
            raw_text=json.dumps(parsed, ensure_ascii=False),
            tokens_in=1000,
            tokens_out=500,
            thinking_tokens=100,
            latency_ms=10,
        )
