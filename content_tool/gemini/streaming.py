"""Cross-cutting plumbing for streaming Gemini thought-summaries out of agent
nodes and into whichever transport the caller wants (SSE for the live run page,
no-op for batch jobs and tests).

The Gemini client is shared across runs, so we route thoughts through a
ContextVar that the executor binds before driving the LangGraph. Any
``RealGeminiClient.generate`` call that runs under that bound context will pick
up the emitter and stream; calls outside the executor (CLI, batch refresh) just
see ``None`` and use the non-streaming path.
"""

from collections.abc import Awaitable, Callable
from contextvars import ContextVar

# (agent, chunk_text) -> awaitable. Chunks are the raw text from a
# `thought=True` Part, which Gemini emits as short summary paragraphs.
ThoughtEmitter = Callable[[str, str], Awaitable[None]]

_thought_emitter: ContextVar[ThoughtEmitter | None] = ContextVar(
    "content_tool_thought_emitter", default=None
)


def set_thought_emitter(emitter: ThoughtEmitter | None) -> None:
    _thought_emitter.set(emitter)


def get_thought_emitter() -> ThoughtEmitter | None:
    return _thought_emitter.get()
