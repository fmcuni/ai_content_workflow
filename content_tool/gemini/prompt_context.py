"""ContextVar plumbing for Langfuse prompt-meta and run/session context.

Mirrors the pattern used in ``content_tool.gemini.streaming`` (ThoughtEmitter)
and ``content_tool.observability.event_log`` (EventEmitter): callers bind a
value before driving the LangGraph (or calling Gemini directly), and the
``ObservedGeminiClient`` reads it without any parameter threading.

PromptMeta
----------
Set at the call site that assembles the system prompt, immediately before
calling ``gemini.generate``.  Carries the prompt-template metadata so the
Langfuse generation record links back to the exact prompt row.

RunContext
----------
Set once at the start of a run (in ``RunExecutor._run``) so every generation
produced during that run is grouped under one Langfuse trace / session.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True)
class PromptMeta:
    """Immutable snapshot of prompt-template metadata for one Gemini call."""

    template_id: str
    voice_slug: str
    sha256: str


@dataclass(frozen=True)
class RunContext:
    """Identifies the run that owns a generation."""

    run_id: str


_prompt_meta: ContextVar[PromptMeta | None] = ContextVar(
    "content_tool_prompt_meta", default=None
)

_run_context: ContextVar[RunContext | None] = ContextVar(
    "content_tool_run_context", default=None
)


# --- PromptMeta accessors -------------------------------------------------

def set_prompt_meta(meta: PromptMeta | None) -> None:
    """Bind prompt metadata for the current async context."""
    _prompt_meta.set(meta)


def get_prompt_meta() -> PromptMeta | None:
    """Return the prompt metadata bound to the current async context."""
    return _prompt_meta.get()


# --- RunContext accessors --------------------------------------------------

def set_run_context(ctx: RunContext | None) -> None:
    """Bind run context for the current async context."""
    _run_context.set(ctx)


def get_run_context() -> RunContext | None:
    """Return the run context bound to the current async context."""
    return _run_context.get()
