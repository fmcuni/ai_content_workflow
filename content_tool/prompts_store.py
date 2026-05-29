"""DB-backed prompt-template store — the runtime source of truth for prompts.

The ``.md`` files under ``prompts/`` and ``evals/judge/`` seed
``content_tool.prompt_templates`` (see ``scripts/gen_prompt_seed.py`` and the
``*_prompt_templates*`` migrations); at runtime every agent reads its system
prompt from this table so that edits made in the prompt editor reach Gemini
without a redeploy.

Include resolution mirrors ``content_tool.agents.writer.resolve_includes``
byte-for-byte: the top-level body is used verbatim (trailing newline intact),
each ``{{include:NAME}}`` partial is inlined with its trailing newlines
stripped, and include cycles raise ``ValueError``. This keeps DB-assembled
prompts identical to the golden fixtures built from the seed files.

Agents that already hold an ``AsyncSession`` (writer, audit, outline,
gap_analysis) call the ``*_session`` helpers; agents without one (topic_*,
judges, the refresh evaluator) call the ``*_standalone`` helpers, which open a
session from the factory registered via :func:`configure` at app startup.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.db.models import PromptTemplate

_INCLUDE_RE = re.compile(r"\{\{include:([A-Za-z0-9_./-]+)\}\}")


class PromptTemplateNotFound(LookupError):
    """Raised when a template_id (top-level or referenced via include) is absent."""

    def __init__(self, template_id: str) -> None:
        super().__init__(template_id)
        self.template_id = template_id


@dataclass(frozen=True)
class TemplateRow:
    """Immutable snapshot of one ``prompt_templates`` row."""

    template_id: str
    category: str
    filename: str
    body: str
    sha256: str
    bytes: int


# Module-level state. The session factory is registered once at app/test startup
# via configure(); the snapshot caches all templates in-process so a runtime
# assembly is at most one query. invalidate() drops it after an editor save so
# the same process serves the new body immediately. The cache is per-process —
# acceptable because this tool runs as a single FastAPI process and the editing
# worker busts its own cache; a multi-worker deployment would add LISTEN/NOTIFY.
_session_factory: async_sessionmaker[AsyncSession] | None = None
_cache: dict[str, TemplateRow] | None = None


def configure(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """Register the session factory used by the ``*_standalone`` helpers."""
    global _session_factory
    _session_factory = session_factory


def clear_cache() -> None:
    """Drop the in-process snapshot; the next read reloads from the DB."""
    global _cache
    _cache = None


def invalidate(template_id: str | None = None) -> None:
    """Invalidate cached templates after an edit.

    Includes create cross-template dependencies (editing a partial changes every
    consumer), so we drop the whole snapshot rather than track a dependency
    graph. The ``template_id`` argument documents intent at the call site; edits
    are rare and a full reload on the next read is cheap.
    """
    clear_cache()


async def _load_all(session: AsyncSession) -> dict[str, TemplateRow]:
    rows = (await session.execute(select(PromptTemplate))).scalars().all()
    return {
        r.template_id: TemplateRow(
            template_id=r.template_id,
            category=r.category,
            filename=r.filename,
            body=r.body,
            sha256=r.sha256,
            bytes=r.bytes,
        )
        for r in rows
    }


async def snapshot(session: AsyncSession) -> dict[str, TemplateRow]:
    """Return all templates keyed by template_id, loading + caching on first use.

    The returned dict is the cached instance — treat it as read-only.
    """
    global _cache
    if _cache is None:
        _cache = await _load_all(session)
    return _cache


async def _snapshot_standalone() -> dict[str, TemplateRow]:
    global _cache
    if _cache is not None:
        return _cache
    if _session_factory is None:
        raise RuntimeError(
            "prompts_store is not configured; call configure(session_factory) at startup"
        )
    async with _session_factory() as session:
        _cache = await _load_all(session)
    return _cache


def resolve_body(
    body: str, snap: dict[str, TemplateRow], *, _seen: frozenset[str] = frozenset()
) -> str:
    """Inline ``{{include:NAME}}`` directives in ``body`` from ``snap``.

    Mirrors ``writer.resolve_includes``: included partials are ``rstrip("\\n")``
    before inlining; cycles raise ``ValueError``; an unknown include raises
    :class:`PromptTemplateNotFound`.
    """

    def _sub(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in _seen:
            raise ValueError(f"include cycle detected at {{{{include:{name}}}}}")
        row = snap.get(name)
        if row is None:
            raise PromptTemplateNotFound(name)
        return resolve_body(row.body.rstrip("\n"), snap, _seen=_seen | {name})

    return _INCLUDE_RE.sub(_sub, body)


def assemble_from_snapshot(template_id: str, snap: dict[str, TemplateRow]) -> str:
    """Resolve ``template_id``'s full body (with includes) from a snapshot."""
    row = snap.get(template_id)
    if row is None:
        raise PromptTemplateNotFound(template_id)
    return resolve_body(row.body, snap)


def assemble_with_override(
    route_id: str,
    snap: dict[str, TemplateRow],
    *,
    override_name: str,
    override_body: str,
) -> str:
    """Assemble ``route_id`` but resolve ``override_name`` to ``override_body``.

    Used by the editor preview so an unsaved partial draft is slotted into its
    consumer while the rest resolve from the DB.
    """
    row = snap.get(route_id)
    if row is None:
        raise PromptTemplateNotFound(route_id)
    return _resolve_with_override(
        row.body, snap, override_name=override_name, override_body=override_body
    )


def _resolve_with_override(
    body: str,
    snap: dict[str, TemplateRow],
    *,
    override_name: str,
    override_body: str,
    _seen: frozenset[str] = frozenset(),
) -> str:
    def _sub(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in _seen:
            raise ValueError(f"include cycle detected at {{{{include:{name}}}}}")
        if name == override_name:
            inner = override_body.rstrip("\n")
        else:
            row = snap.get(name)
            if row is None:
                raise PromptTemplateNotFound(name)
            inner = row.body.rstrip("\n")
        return _resolve_with_override(
            inner,
            snap,
            override_name=override_name,
            override_body=override_body,
            _seen=_seen | {name},
        )

    return _INCLUDE_RE.sub(_sub, body)


async def get_assembled(template_id: str, *, session: AsyncSession) -> str:
    """Fully-resolved system prompt for ``template_id`` (caller holds a session)."""
    return assemble_from_snapshot(template_id, await snapshot(session))


async def get_assembled_standalone(template_id: str) -> str:
    """Fully-resolved system prompt for ``template_id`` (no caller session).

    Opens a session from the configured factory on cache miss.
    """
    return assemble_from_snapshot(template_id, await _snapshot_standalone())


async def get_body(template_id: str, *, session: AsyncSession) -> str:
    """Raw, unresolved body for ``template_id`` (no include expansion)."""
    row = (await snapshot(session)).get(template_id)
    if row is None:
        raise PromptTemplateNotFound(template_id)
    return row.body
