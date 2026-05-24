from dataclasses import dataclass
from typing import Any, Protocol

from google import genai
from google.genai import types as genai_types


@dataclass
class GeminiResult:
    parsed: dict[str, Any]
    raw_text: str
    tokens_in: int
    tokens_out: int
    thinking_tokens: int
    latency_ms: int
    grounding_chunks: list[dict[str, Any]] | None = None
    finish_reason: str | None = None
    safety_ratings: list[dict[str, Any]] | None = None
    raw_response: dict[str, Any] | None = None


class GeminiClient(Protocol):
    async def generate(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any] | None,
        tools: list[str],
    ) -> GeminiResult: ...


def strip_property_ordering(schema: Any) -> Any:  # noqa: ANN401
    """Recursively strip `propertyOrdering` (triggers INVALID_ARGUMENT on responseJsonSchema)."""
    if isinstance(schema, list):
        return [strip_property_ordering(s) for s in schema]
    if isinstance(schema, dict):
        return {k: strip_property_ordering(v) for k, v in schema.items() if k != "propertyOrdering"}
    return schema


def parse_gemini_json(text: str) -> dict[str, Any]:
    # Gemini occasionally returns the JSON wrapped in ```json fences or with
    # leading/trailing commentary, especially when grounding tools are enabled.
    # Tolerate those shapes before falling back to first-balanced-object extraction.
    import json

    if not text:
        return {}
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = candidate.split("\n", 1)[1] if "\n" in candidate else candidate[3:]
        if candidate.endswith("```"):
            candidate = candidate[: -3]
        candidate = candidate.strip()
        if candidate.lower().startswith("json\n"):
            candidate = candidate[5:].lstrip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass

    start = candidate.find("{")
    if start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(candidate)):
            ch = candidate[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    block = candidate[start : i + 1]
                    try:
                        return json.loads(block)
                    except json.JSONDecodeError:
                        break

    snippet = text[:200].replace("\n", " ")
    raise ValueError(
        f"Gemini response is not valid JSON (len={len(text)}). "
        f"First 200 chars: {snippet!r}"
    )


class RealGeminiClient:
    def __init__(self, api_key: str, model: str, thinking_level: str) -> None:
        self._client = genai.Client(api_key=api_key)
        self._model = model
        self._thinking_level = thinking_level

    async def generate(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any] | None,
        tools: list[str],
    ) -> GeminiResult:
        import time

        config_tools: list[genai_types.Tool] = []
        if "googleSearch" in tools:
            config_tools.append(genai_types.Tool(google_search=genai_types.GoogleSearch()))
        if "urlContext" in tools:
            config_tools.append(genai_types.Tool(url_context=genai_types.UrlContext()))

        config = genai_types.GenerateContentConfig(
            system_instruction=system_prompt,
            temperature=1.0,
            thinking_config=genai_types.ThinkingConfig(thinking_level=self._thinking_level),
            response_mime_type="application/json" if response_schema else None,
            response_json_schema=strip_property_ordering(response_schema) if response_schema else None,  # noqa: E501
            tools=config_tools or None,
        )

        t0 = time.perf_counter()
        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=user_prompt,
            config=config,
        )
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        text = response.text or ""
        parsed = parse_gemini_json(text)
        usage = response.usage_metadata
        candidate = response.candidates[0] if response.candidates else None
        grounding = None
        if candidate and candidate.grounding_metadata:
            grounding = [c.model_dump() for c in (candidate.grounding_metadata.grounding_chunks or [])]  # noqa: E501

        return GeminiResult(
            parsed=parsed,
            raw_text=text,
            tokens_in=usage.prompt_token_count if usage else 0,
            tokens_out=usage.candidates_token_count if usage else 0,
            thinking_tokens=usage.thoughts_token_count if usage and hasattr(usage, "thoughts_token_count") else 0,  # noqa: E501
            latency_ms=elapsed_ms,
            grounding_chunks=grounding,
            finish_reason=candidate.finish_reason.name if candidate and candidate.finish_reason else None,  # noqa: E501
        )
