"""ObservedGeminiClient — a transparent wrapper that records Langfuse generations.

Wraps any ``GeminiClient`` implementation and, when Langfuse is enabled, opens
a ``langfuse.generation`` span around every ``generate()`` call capturing:

- ``name``         : the ``agent`` argument (e.g. ``"writer"``, ``"judge.brand_voice"``)
- ``model``        : the Gemini model name — lets Langfuse run model analytics
                     and compute cost automatically from ``usage_details``
- ``input``        : ``{system_prompt, user_prompt}``
- ``output``       : ``{raw_text, parsed}``
- ``usage_details``: prompt / completion / thinking token counts
- ``metadata``     : prompt-meta contextvar (template_id, voice_slug, sha256)
                     + run contextvar (run_id) when set
                     + latency_ms, finish_reason
- ``trace_context``: deterministic trace_id derived from run_id via
                     ``Langfuse.create_trace_id(seed=run_id)`` (v4 requires a
                     32-hex OTEL id) so all generations of one run group together

Design invariants
-----------------
1. When Langfuse is disabled or the client is ``None``, ``generate()`` is a
   pure pass-through with **zero** overhead — no try/except, no branch cost
   beyond the ``None`` check.
2. Langfuse errors **never** propagate — they are logged and swallowed so a
   tracing failure cannot break a run.
3. The inner client is never mutated (immutable wrap).
"""

from __future__ import annotations

import logging
from typing import Any

from content_tool.gemini.client import GeminiClient, GeminiResult
from content_tool.gemini.prompt_context import get_prompt_meta, get_run_context

logger = logging.getLogger(__name__)


class ObservedGeminiClient:
    """``GeminiClient`` decorator that emits Langfuse generation spans."""

    def __init__(self, inner: GeminiClient, *, enabled: bool, model: str | None = None) -> None:
        self._inner = inner
        self._enabled = enabled
        self._model = model

    async def generate(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any] | None,
        tools: list[str],
    ) -> GeminiResult:
        result = await self._inner.generate(
            agent=agent,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response_schema=response_schema,
            tools=tools,
        )

        if self._enabled:
            self._record(
                agent=agent,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                result=result,
            )

        return result

    def _record(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        result: GeminiResult,
    ) -> None:
        """Fire-and-forget Langfuse generation record.  Never raises."""
        try:
            from content_tool.observability.langfuse_client import get_langfuse

            lf = get_langfuse()
            if lf is None:
                return

            prompt_meta = get_prompt_meta()
            run_ctx = get_run_context()

            metadata: dict[str, Any] = {
                "latency_ms": result.latency_ms,
                "finish_reason": result.finish_reason,
            }
            if prompt_meta is not None:
                metadata["template_id"] = prompt_meta.template_id
                metadata["voice_slug"] = prompt_meta.voice_slug
                metadata["prompt_sha256"] = prompt_meta.sha256
            if run_ctx is not None:
                metadata["run_id"] = run_ctx.run_id

            usage_details: dict[str, int] = {
                "input": result.tokens_in,
                "output": result.tokens_out,
                "total": result.tokens_in + result.tokens_out + result.thinking_tokens,
            }

            # trace_context groups all generations from one run under the same
            # Langfuse trace. Langfuse v4 is OTEL-based and requires a 32-char
            # lowercase-hex trace id, so we deterministically derive one from
            # run_id (same run_id -> same trace id -> same trace). Passing run_id
            # raw makes the SDK reject it and fall back to a random id, which
            # silently breaks per-run grouping.
            trace_context: dict[str, str] | None = None
            if run_ctx is not None:
                from langfuse import Langfuse  # pyright: ignore[reportMissingTypeStubs]

                trace_id = Langfuse.create_trace_id(seed=run_ctx.run_id)  # type: ignore[reportUnknownMemberType]
                trace_context = {"trace_id": trace_id}

            generation = lf.start_observation(  # type: ignore[reportUnknownVariableType]
                name=agent,
                as_type="generation",
                model=self._model,
                input={"system_prompt": system_prompt, "user_prompt": user_prompt},
                output={"raw_text": result.raw_text, "parsed": result.parsed},
                usage_details=usage_details,
                metadata=metadata,
                trace_context=trace_context,  # type: ignore[arg-type]
            )
            generation.end()  # type: ignore[reportUnknownMemberType]
        except Exception:
            logger.debug("Langfuse generation recording failed", exc_info=True)
