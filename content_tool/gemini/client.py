import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types

from content_tool.gemini.streaming import ThoughtEmitter, get_thought_emitter

# Gemini occasionally returns an empty / non-JSON HTTP body (safety block,
# truncated stream, 5xx, dropped connection); the SDK then raises a JSON decode
# error or transient API error that used to fail the whole run with a cryptic
# message. Retry transient cases, and on exhaustion rewrap into a GeminiError.
GEMINI_MAX_ATTEMPTS = 3
_GEMINI_BACKOFF_S = (0.5, 1.5)


class GeminiError(Exception):
    """A Gemini generation call that failed after exhausting transient retries."""


def is_transient_gemini_error(err: BaseException) -> bool:
    """Heuristic: is this a transient upstream failure worth retrying?"""
    if isinstance(err, json.JSONDecodeError):
        return True
    server_error = getattr(genai_errors, "ServerError", ())
    if isinstance(err, server_error):
        return True
    code = getattr(err, "code", None) or getattr(err, "status_code", None)
    if code in (429, 500, 502, 503, 504):
        return True
    msg = str(err).lower()
    return any(
        s in msg
        for s in (
            "unexpected end of json",
            "expecting value",
            "timeout",
            "timed out",
            "connection",
            "temporarily",
            "econnreset",
            "fetch failed",
        )
    )


async def with_gemini_retry[T](
    fn: Callable[[], Awaitable[T]],
    backoff_s: tuple[float, ...] = _GEMINI_BACKOFF_S,
) -> T:
    """Run a Gemini SDK call with bounded retries on transient failures.

    Deterministic errors (4xx, schema problems) propagate immediately. ``backoff_s``
    is injectable so tests can run with zero delay.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            return await fn()
        except Exception as err:
            if not is_transient_gemini_error(err):
                raise
            if attempt < GEMINI_MAX_ATTEMPTS:
                delay = backoff_s[attempt - 1] if attempt - 1 < len(backoff_s) else backoff_s[-1]
                if delay:
                    await asyncio.sleep(delay)
                continue
            raise GeminiError(
                f"Gemini returned an empty/non-JSON response after {attempt} attempts "
                f"(likely a transient upstream error). Underlying: "
                f"{type(err).__name__}: {err}"
            ) from err


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

        # ``include_thoughts`` is opt-in per request and only matters when the
        # caller installed a sink that wants to surface thought summaries (the
        # SSE run-page; CLI and batch jobs leave it ``None``). Enabling it
        # unconditionally would charge thought tokens against runs nobody is
        # watching.
        emitter = get_thought_emitter()
        include_thoughts = emitter is not None
        config = genai_types.GenerateContentConfig(
            system_instruction=system_prompt,
            temperature=1.0,
            thinking_config=genai_types.ThinkingConfig(
                thinking_level=self._thinking_level,
                include_thoughts=include_thoughts or None,
            ),
            response_mime_type="application/json" if response_schema else None,
            response_json_schema=strip_property_ordering(response_schema) if response_schema else None,  # noqa: E501
            tools=config_tools or None,
        )

        t0 = time.perf_counter()

        async def _call_once() -> tuple[str, Any, Any]:
            if emitter is not None:
                return await self._stream_call(
                    agent=agent,
                    user_prompt=user_prompt,
                    config=config,
                    emitter=emitter,
                )
            response = await self._client.aio.models.generate_content(
                model=self._model,
                contents=user_prompt,
                config=config,
            )
            return (
                response.text or "",
                response.usage_metadata,
                response.candidates[0] if response.candidates else None,
            )

        text, usage, candidate = await with_gemini_retry(_call_once)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)

        # Only parse JSON when the caller actually requested structured output.
        # A None schema means a plain-text reply is expected (e.g. the setup
        # credential check), so forcing JSON parsing there would reject a valid
        # response. ``parsed`` stays ``{}`` in that case.
        parsed = parse_gemini_json(text) if response_schema is not None else {}
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

    async def _stream_call(
        self,
        *,
        agent: str,
        user_prompt: str,
        config: genai_types.GenerateContentConfig,
        emitter: ThoughtEmitter,
    ) -> tuple[str, Any, Any]:
        """Drive ``generate_content_stream``, forwarding thought parts to the
        emitter and accumulating the non-thought text + final usage/candidate
        metadata. The Gemini SDK guarantees ``usage_metadata`` and the resolved
        ``candidate`` show up on the *last* chunk, so we keep overwriting as
        each chunk lands.
        """
        text_parts: list[str] = []
        usage: Any = None
        last_candidate: Any = None
        stream = await self._client.aio.models.generate_content_stream(
            model=self._model,
            contents=user_prompt,
            config=config,
        )
        async for chunk in stream:
            if chunk.usage_metadata is not None:
                usage = chunk.usage_metadata
            if chunk.candidates:
                last_candidate = chunk.candidates[0]
                content = last_candidate.content
                if content and content.parts:
                    for part in content.parts:
                        if not isinstance(part.text, str) or not part.text:
                            continue
                        if part.thought is True:
                            # Swallow emitter errors — a broken SSE pipe must
                            # not abort the writer LLM call mid-flight.
                            try:
                                await emitter(agent, part.text)
                            except Exception:  # noqa: S110
                                pass
                        else:
                            text_parts.append(part.text)
        return "".join(text_parts), usage, last_candidate
