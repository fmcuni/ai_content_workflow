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

Per-voice scoping
-----------------
Each row is keyed by ``(voice_slug, template_id)``. Agent and partial prompts
are scoped to a voice (persona slug); the reserved sentinel ``__shared__`` holds
the global judges and the canonical seed-of-record that every voice falls back
to. Resolution follows a strict fallback chain for both the top-level template
and every ``{{include:NAME}}`` partial it pulls in::

    voice_slug  ->  '__shared__'  ->  bundled prompts/<id>.md file

Includes resolve *within the requested voice first* — a voice's agent prompt
includes that voice's own partials — falling back to the shared partial (then
the bundled file) only when the voice has not customised it. This keeps a voice
created before a template was added (and any judge, which is shared) resolvable,
and keeps assembled prompts byte-identical to the pre-per-voice behaviour for a
voice whose rows match ``__shared__`` (e.g. the seeded ``bowtie-editor``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.db.models import PromptTemplate

_INCLUDE_RE = re.compile(r"\{\{include:([A-Za-z0-9_./-]+)\}\}")

# Reserved sentinel voice for global / seed-of-record rows (judges + canonical
# agent/partial set). Mirrors the migration default and the Workers ``SHARED_VOICE``.
SHARED_VOICE = "__shared__"

# Bundled agent/partial prompt sources. The last-resort fallback when neither
# the requested voice nor ``__shared__`` has a DB row (e.g. the migration has
# not been pushed yet) so the app still boots. ``template_id`` is the file stem
# for every agent/partial under ``prompts/``.
_PROMPT_DIR = Path(__file__).resolve().parents[1] / "prompts"


class PromptTemplateNotFound(LookupError):
    """Raised when a template_id (top-level or referenced via include) is absent."""

    def __init__(self, template_id: str) -> None:
        super().__init__(template_id)
        self.template_id = template_id


@dataclass(frozen=True)
class TemplateRow:
    """Immutable snapshot of one ``prompt_templates`` row."""

    voice_slug: str
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
_cache: dict[tuple[str, str], TemplateRow] | None = None


def configure(session_factory: async_sessionmaker[AsyncSession] | None) -> None:
    """Register the session factory used by the ``*_standalone`` helpers.

    Pass ``None`` to de-register (e.g. test teardown after the engine is
    disposed) so a stale/disposed factory is never reused.
    """
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


async def _load_all(session: AsyncSession) -> dict[tuple[str, str], TemplateRow]:
    rows = (await session.execute(select(PromptTemplate))).scalars().all()
    return {
        (r.voice_slug, r.template_id): TemplateRow(
            voice_slug=r.voice_slug,
            template_id=r.template_id,
            category=r.category,
            filename=r.filename,
            body=r.body,
            sha256=r.sha256,
            bytes=r.bytes,
        )
        for r in rows
    }


async def snapshot(session: AsyncSession) -> dict[tuple[str, str], TemplateRow]:
    """Return all templates keyed by ``(voice_slug, template_id)``, loading +
    caching on first use.

    The returned dict is the cached instance — treat it as read-only.
    """
    global _cache
    if _cache is None:
        _cache = await _load_all(session)
    return _cache


async def _snapshot_standalone() -> dict[tuple[str, str], TemplateRow]:
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


def _bundled_file_body(template_id: str) -> str | None:
    """Raw body of the bundled ``prompts/<template_id>.md`` file, or ``None``.

    The last link in the fallback chain. Read verbatim (no rstrip) so a
    top-level file resolves byte-identically to a DB-stored body.
    """
    try:
        return (_PROMPT_DIR / f"{template_id}.md").read_text(encoding="utf-8")
    except OSError:
        return None


def _lookup_row(
    snap: dict[tuple[str, str], TemplateRow], voice_slug: str, template_id: str
) -> TemplateRow | None:
    """Resolve a row following ``voice_slug -> '__shared__'`` (snapshot only)."""
    row = snap.get((voice_slug, template_id))
    if row is not None:
        return row
    if voice_slug != SHARED_VOICE:
        return snap.get((SHARED_VOICE, template_id))
    return None


def _raw_body(
    snap: dict[tuple[str, str], TemplateRow], voice_slug: str, template_id: str
) -> str:
    """Raw body via the full ``voice -> __shared__ -> bundled file`` chain."""
    row = _lookup_row(snap, voice_slug, template_id)
    if row is not None:
        return row.body
    body = _bundled_file_body(template_id)
    if body is None:
        raise PromptTemplateNotFound(template_id)
    return body


def resolve_body(
    body: str,
    snap: dict[tuple[str, str], TemplateRow],
    *,
    voice_slug: str = SHARED_VOICE,
    _seen: frozenset[str] = frozenset(),
) -> str:
    """Inline ``{{include:NAME}}`` directives in ``body`` from ``snap``.

    Mirrors ``writer.resolve_includes``: included partials are ``rstrip("\\n")``
    before inlining; cycles raise ``ValueError``; an unknown include (in the
    voice, in ``__shared__``, and on disk) raises :class:`PromptTemplateNotFound`.
    Each partial follows the same ``voice -> __shared__ -> file`` chain, with the
    originally-requested ``voice_slug`` threaded through nested includes so a
    voice's own partials keep priority all the way down.
    """

    def _sub(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in _seen:
            raise ValueError(f"include cycle detected at {{{{include:{name}}}}}")
        inner = _raw_body(snap, voice_slug, name)
        return resolve_body(
            inner.rstrip("\n"), snap, voice_slug=voice_slug, _seen=_seen | {name}
        )

    return _INCLUDE_RE.sub(_sub, body)


def assemble_from_snapshot(
    template_id: str,
    snap: dict[tuple[str, str], TemplateRow],
    *,
    voice_slug: str = SHARED_VOICE,
) -> str:
    """Resolve ``template_id``'s full body (with includes) for ``voice_slug``."""
    body = _raw_body(snap, voice_slug, template_id)
    return resolve_body(body, snap, voice_slug=voice_slug)


def assemble_with_override(
    route_id: str,
    snap: dict[tuple[str, str], TemplateRow],
    *,
    override_name: str,
    override_body: str,
    voice_slug: str = SHARED_VOICE,
) -> str:
    """Assemble ``route_id`` but resolve ``override_name`` to ``override_body``.

    Used by the editor preview so an unsaved partial draft is slotted into its
    consumer while the rest resolve from the DB (within ``voice_slug``, with the
    usual shared/file fallback).
    """
    body = _raw_body(snap, voice_slug, route_id)
    return _resolve_with_override(
        body,
        snap,
        override_name=override_name,
        override_body=override_body,
        voice_slug=voice_slug,
    )


def _resolve_with_override(
    body: str,
    snap: dict[tuple[str, str], TemplateRow],
    *,
    override_name: str,
    override_body: str,
    voice_slug: str = SHARED_VOICE,
    _seen: frozenset[str] = frozenset(),
) -> str:
    def _sub(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in _seen:
            raise ValueError(f"include cycle detected at {{{{include:{name}}}}}")
        if name == override_name:
            inner = override_body.rstrip("\n")
        else:
            inner = _raw_body(snap, voice_slug, name).rstrip("\n")
        return _resolve_with_override(
            inner,
            snap,
            override_name=override_name,
            override_body=override_body,
            voice_slug=voice_slug,
            _seen=_seen | {name},
        )

    return _INCLUDE_RE.sub(_sub, body)


async def get_assembled(
    template_id: str, *, voice_slug: str = SHARED_VOICE, session: AsyncSession
) -> str:
    """Fully-resolved system prompt for ``(voice_slug, template_id)``.

    The caller holds a session. Resolves includes within ``voice_slug`` and
    falls back ``voice -> __shared__ -> bundled file`` per missing row.
    """
    return assemble_from_snapshot(
        template_id, await snapshot(session), voice_slug=voice_slug
    )


async def get_assembled_standalone(
    template_id: str, *, voice_slug: str = SHARED_VOICE
) -> str:
    """Fully-resolved system prompt for ``(voice_slug, template_id)`` (no caller
    session). Opens a session from the configured factory on cache miss.
    """
    return assemble_from_snapshot(
        template_id, await _snapshot_standalone(), voice_slug=voice_slug
    )


async def get_body(
    template_id: str, *, voice_slug: str = SHARED_VOICE, session: AsyncSession
) -> str:
    """Raw, unresolved body for ``(voice_slug, template_id)`` (no include
    expansion). Follows the ``voice -> __shared__`` snapshot fallback.
    """
    row = _lookup_row(await snapshot(session), voice_slug, template_id)
    if row is None:
        raise PromptTemplateNotFound(template_id)
    return row.body


async def get_template_row(
    template_id: str, *, voice_slug: str = SHARED_VOICE, session: AsyncSession
) -> TemplateRow | None:
    """Return the resolved ``TemplateRow`` for ``(voice_slug, template_id)``.

    Follows the ``voice -> __shared__`` fallback chain. Returns ``None`` when
    no row exists and no bundled file is available (i.e. the template is
    genuinely missing). Bundled-file rows do not have a DB sha256 — callers
    that need the sha256 should treat a ``None`` return as "no metadata".

    Used by ``ObservedGeminiClient`` / prompt-meta injection to obtain the
    ``sha256``, ``template_id``, and ``voice_slug`` WITHOUT re-running prompt
    assembly.
    """
    return _lookup_row(await snapshot(session), voice_slug, template_id)


async def get_template_row_standalone(
    template_id: str, *, voice_slug: str = SHARED_VOICE
) -> TemplateRow | None:
    """Same as ``get_template_row`` but opens its own session (no caller session).

    Used by judge runners and other standalone code paths.
    """
    return _lookup_row(await _snapshot_standalone(), voice_slug, template_id)
