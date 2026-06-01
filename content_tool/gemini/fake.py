import json
from typing import Any

from content_tool.gemini.client import GeminiResult


class FakeGeminiClient:
    def __init__(
        self,
        canned_responses: dict[str, dict[str, Any]],
        canned_grounding: dict[str, list[dict[str, Any]]] | None = None,
    ) -> None:
        self._canned = canned_responses
        # Optional per-agent grounding chunks (e.g. for topic_existing_search,
        # which harvests result.grounding_chunks rather than the parsed JSON).
        self._canned_grounding = canned_grounding or {}
        self.calls: list[dict[str, Any]] = []

    def set_audit_response(self, canned: dict[str, Any]) -> None:
        """Set/replace the canned response returned for agent="audit".

        Fills in `severity_summary` if the caller omits it so the returned
        payload validates against AuditOutput.
        """
        payload = dict(canned)
        findings = payload.get("findings", [])
        if "severity_summary" not in payload:
            payload["severity_summary"] = {
                "high": sum(1 for f in findings if f.get("severity") == "high"),
                "medium": sum(1 for f in findings if f.get("severity") == "medium"),
                "low": sum(1 for f in findings if f.get("severity") == "low"),
            }
        if "overall_pass" not in payload:
            payload["overall_pass"] = payload["severity_summary"]["high"] == 0
        self._canned["audit"] = payload

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
        # A plain-text call (no schema) need not have a canned JSON body — e.g.
        # topic_existing_search, where only the grounding chunks matter.
        if agent not in self._canned and response_schema is not None:
            raise KeyError(f"No canned response for agent={agent}")
        parsed = self._canned.get(agent, {})
        return GeminiResult(
            parsed=parsed,
            raw_text=json.dumps(parsed, ensure_ascii=False),
            tokens_in=1000,
            tokens_out=500,
            thinking_tokens=100,
            latency_ms=10,
            grounding_chunks=self._canned_grounding.get(agent),
        )
