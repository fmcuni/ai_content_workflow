# ruff: noqa: RUF001  — the user-prompt reference strings mirror CJK prompts verbatim
import hashlib
import re
from dataclasses import dataclass
from datetime import date
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool import prompts_store, source_policy_store
from content_tool.agents import audit as audit_agent
from content_tool.agents import gap_analysis as gap_agent
from content_tool.agents import outline as outline_agent
from content_tool.agents import writer as writer_agent
from content_tool.api.editor_auth import require_editor as _require_editor
from content_tool.api.prompt_graph import PROMPT_GRAPHS
from content_tool.db.models import (
    AuditRun,
    Citation,
    Draft,
    FetchedArticle,
    GapAnalysisRow,
    OutlineRow,
    PromptTemplate,
    PromptVersion,
    Render,
    Run,
)
from content_tool.models.audit import AuditOutput
from content_tool.models.gap_analysis import GapAnalysis
from content_tool.models.outline import Outline
from content_tool.models.persona import GlossaryEntry, VoiceLocale
from content_tool.models.topic_batch import TopicDedupOutput, TopicGenOutput, TopicHotOutput
from content_tool.models.writer import WriterOutput
from content_tool.policy.personas import load_persona, load_persona_from_yaml
from content_tool.policy.source_policy import SourcePolicy
from content_tool.prompts_store import SHARED_VOICE, TemplateRow

router = APIRouter(prefix="/prompts", tags=["prompts"])

# Default voice for every template endpoint when the caller omits ``?voice=``.
# Mirrors the seeded persona slug; the per-voice rows fall back to ``__shared__``
# (SHARED_VOICE) for any template the voice has not customised.
DEFAULT_VOICE = "bowtie-editor"

# Categories the prompt editor surfaces and manages. Judge templates live in the
# same ``prompt_templates`` table (seeded for the eval harness) but are not
# editable here, so reads/saves for a judge id resolve to 404 as before. Judges
# are always global — they ignore ``voice`` and resolve under ``__shared__``.
_EDITABLE_CATEGORIES = frozenset({"agent", "partial"})

# Required `{placeholder}` set per template — the writer/audit/outline/etc.
# loaders perform these substitutions on the assembled system prompt, so
# removing one would leak a literal `{persona_block}` into the model. The
# editor blocks any save that drops one of these. This validation metadata is
# not stored in the DB; it lives with the route.
_REQUIRED_PLACEHOLDERS: dict[str, set[str]] = {
    "audit": {"persona_block", "today_date"},
    "gap_analysis": {"today_date"},
    "outline_rewrite_mode": {"today_date", "create_mode_block"},
    "outline_create_mode": set(),
    "writer_small_refresh": {"persona_block", "today_date", "source_policy_block"},
    "writer_full_rewrite": {"persona_block", "today_date", "source_policy_block"},
    "writer_create": {"persona_block", "today_date", "source_policy_block"},
    "topic_gen": set(),
    "topic_dedup": set(),
    "topic_hot": set(),
    # Partials are pure text today, but their schema endpoint still returns an
    # entry so the UI can treat them uniformly.
    "_writer_brand_block": set(),
    "_writer_schema": set(),
    "_writer_seo": set(),
    "_writer_refine_notes": set(),
    "_writer_output_format_tail": set(),
}

_MAX_TEMPLATE_BYTES = 64 * 1024
# Preview-endpoint resource caps. The preview handler accepts unsaved drafts as
# untrusted request input; bound each so one request can't carry an arbitrarily
# large payload. Per-body byte caps reuse the save-path _MAX_TEMPLATE_BYTES.
# Kept byte-in-sync with the Workers backend (routes/prompts.ts).
_MAX_PARTIAL_OVERRIDE_ENTRIES = 100
_MAX_GLOSSARY_ENTRIES = 500
_MAX_GLOSSARY_FIELD_CHARS = 500
_INCLUDE_RE = re.compile(r"\{\{include:([A-Za-z0-9_./-]+)\}\}")
_PLACEHOLDER_RE = re.compile(r"\{([a-z][a-z0-9_]*)\}")

# Read-only editor references: the *shape* of the user prompt each agent sends
# alongside its system prompt. Hand-maintained mirrors of the build_user_prompt
# builders — `{placeholders}` mark run-derived values and `← only when …` lines
# mark conditional sections. Keep each entry in sync with its builder, and keep
# the strings byte-identical with the TS mirror in
# deploy/cloudflare-workers/src/prompts/references.ts.

# Shared by writer_create / writer_full_rewrite / writer_small_refresh —
# mirrors content_tool/agents/writer.py build_user_prompt.
_WRITER_USER_PROMPT = """topic: {topic}
focus_keywords: {keywords, comma-separated}
existing_article_URL: {article_url}
acf_adv_id: {acf_adv_id}
acf_widget_id: {acf_widget_id}
topic_category: {topic_category, or "N/A"}

# outline
{outline payload, JSON}

# gap_analysis
{gap_analysis payload, JSON}

# existing_article_markdown
{fetched article markdown — empty in create mode}

# editor_instruction（編輯指示 · 最優先）   ← only when an edit note is set
{edit_note}

# refine_notes（上一輪 audit 必修問題）   ← only on refine iterations
{refine_notes, JSON}"""

_USER_PROMPT_REFERENCES: dict[str, str] = {
    # content_tool/agents/gap_analysis.py
    "gap_analysis": """topic: {topic}
focus_keywords: {keywords, comma-separated}
existing_article: {article_url}
acf_adv_id: {acf_adv_id}
acf_widget_id: {acf_widget_id}
route: {mode — "Auto (follow existing logic)" or "<mode> (override existing logic)"}
article_edit_note: {edit_note, or "N/A"}""",
    # content_tool/agents/outline.py build_user_prompt_create_mode
    "outline_create_mode": """主題：{topic}
關鍵字：{keywords, comma-separated, or "(無)"}
目標讀者：{target_audience, or "(未指定)"}
acf_adv_id: {acf_adv_id}
acf_widget_id: {acf_widget_id}
編輯指示（最優先）：{edit_note}   ← only when an edit note is set""",
    # content_tool/agents/outline.py build_user_prompt
    "outline_rewrite_mode": """chosen_route: {chosen_route}
acf_adv_id: {acf_adv_id}
acf_widget_id: {acf_widget_id}

# gap_analysis
{gap_analysis payload, JSON}

# existing_article_markdown
{fetched article markdown}""",
    "writer_create": _WRITER_USER_PROMPT,
    "writer_full_rewrite": _WRITER_USER_PROMPT,
    "writer_small_refresh": _WRITER_USER_PROMPT,
    # content_tool/agents/audit.py
    "audit": """# final_html
{rendered html_body}

# gap_analysis.update_plan
{gap_analysis.update_plan, JSON}

# citation_intents
{draft citation_intents, JSON}

# citations (resolved)
{resolved citations summary, JSON}

# deterministic_findings
{deterministic findings, JSON}

# edit_note (operator brief)   ← only when an edit note is set
{edit_note}""",
    # content_tool/agents/topic_gen.py
    "topic_gen": """請根據以下研究設定產出結果。

研究主題：{research_theme}
目標受眾：{target_audience}
主題數量：{topic_count}
每個主題關鍵字數量：{keywords_per_topic}

必須涵蓋範疇：
{must_cover, one per line}

避免主題：
{must_avoid, one per line}

額外偏重方向：
{priority_focus, or （無）}

補充要求：
{notes, or （無）}""",
    # content_tool/agents/topic_dedup.py (stage 2 judge)
    "topic_dedup": """請判斷以下單一 topic 在 site:bowtie.com.hk/blog 是否已有相同 topic 的文章。\
只輸出符合 schema 的 JSON。

topic:
{topic}

focus_keywords:
{keywords, comma-separated, or （無）}

{existing_articles — stage-1 grounded search results, title + URL per candidate}""",
    # content_tool/agents/topic_hot.py — {market} is filled from the voice's
    # locale by the /schema endpoint (mirrors topic_hot.build_user_prompt).
    "topic_hot": """請分析以下單一 topic 在 {market} SERP 是否屬於熱門話題。\
只輸出符合 schema 的 JSON。

topic:
{topic}

focus_keywords:
{keywords, comma-separated, or （無）}""",
    # content_tool/agents/topic_existing_search.py (stage 1 — grounded search, plain-text reply)
    "topic_existing_search": """請用 googleSearch 實際搜尋 site:bowtie.com.hk/blog，\
找出與以下 topic 最相關的現有文章，列出標題與完整 URL。

topic:
{topic}

focus_keywords:
{keywords, comma-separated, or （無）}""",
}

# The Pydantic model whose JSON schema each agent passes to Gemini as
# `response_schema`. `topic_existing_search` deliberately has none (plain text —
# grounding chunks are harvested, not the prose).
_RESPONSE_SCHEMA_MODELS: dict[str, type[BaseModel]] = {
    "gap_analysis": GapAnalysis,
    "outline_create_mode": Outline,
    "outline_rewrite_mode": Outline,
    "writer_create": WriterOutput,
    "writer_full_rewrite": WriterOutput,
    "writer_small_refresh": WriterOutput,
    "audit": AuditOutput,
    "topic_gen": TopicGenOutput,
    "topic_dedup": TopicDedupOutput,
    "topic_hot": TopicHotOutput,
}


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _get_session_factory(request: Request) -> async_sessionmaker[Any]:
    return request.app.state.session_factory  # type: ignore[no-any-return]


async def _load_snapshot(sf: async_sessionmaker[Any]) -> dict[tuple[str, str], TemplateRow]:
    """Cached in-process snapshot of every ``prompt_templates`` row.

    Opens one session for the first (cache-miss) read; warm reads are served
    from the process cache that :func:`prompts_store.invalidate` busts on save.
    The dict is keyed by ``(voice_slug, template_id)`` — use :func:`_voice_view`
    to flatten it to one voice's resolvable templates.
    """
    async with sf() as session:
        return await prompts_store.snapshot(session)


def _voice_view(
    snap: dict[tuple[str, str], TemplateRow], voice_slug: str
) -> dict[str, TemplateRow]:
    """Flatten the ``(voice, id)``-keyed snapshot to one voice's ``id -> row`` map.

    Each template_id resolves the same way the runtime loader does — the voice's
    own row wins, otherwise the ``__shared__`` row (judges + canonical seed). The
    resolved row's ``voice_slug`` tells the caller whether it is voice-owned or a
    shared fallback. Downstream helpers operate on this per-voice view exactly as
    they did on the old flat snapshot.
    """
    ids = {tid for (vs, tid) in snap if vs == voice_slug or vs == SHARED_VOICE}
    view: dict[str, TemplateRow] = {}
    for tid in ids:
        row = snap.get((voice_slug, tid)) or snap.get((SHARED_VOICE, tid))
        if row is not None:
            view[tid] = row
    return view


def _editable_or_404(view: dict[str, TemplateRow], template_id: str) -> TemplateRow:
    row = view.get(template_id)
    if row is None or row.category not in _EDITABLE_CATEGORIES:
        raise HTTPException(404, f"unknown template_id '{template_id}'")
    return row


def _agent_ids(view: dict[str, TemplateRow]) -> set[str]:
    return {tid for tid, row in view.items() if row.category == "agent"}


def _partial_ids(view: dict[str, TemplateRow]) -> set[str]:
    return {tid for tid, row in view.items() if row.category == "partial"}


def _consumers_of(template_id: str, view: dict[str, TemplateRow]) -> list[str]:
    """Agent templates whose body contains `{{include:<template_id>}}`.

    For agent templates the answer is just `[template_id]` — the editor
    previews the agent prompt against itself.
    """
    if view[template_id].category == "agent":
        return [template_id]
    hits: list[str] = []
    for agent_id in _agent_ids(view):
        body = view[agent_id].body
        for match in _INCLUDE_RE.finditer(body):
            if match.group(1) == template_id:
                hits.append(agent_id)
                break
    return sorted(hits)


def _partials_referenced_by(route_id: str, view: dict[str, TemplateRow]) -> set[str]:
    return {m.group(1) for m in _INCLUDE_RE.finditer(view[route_id].body)}


@router.get("/graph")
async def graph(mode: str = Query("refresh")) -> dict:
    g = PROMPT_GRAPHS.get(mode)
    if g is None:
        raise HTTPException(404, f"unknown graph mode '{mode}'")
    return g


@router.get("/templates")
async def list_templates(
    voice: str = Query(DEFAULT_VOICE),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """List one voice's editable prompts (agent + partial) plus the shared judges.

    ``templates`` holds the agent prompts + partials resolved for ``voice`` (the
    voice's own row, or the ``__shared__`` fallback — see ``voice_slug`` on each
    entry); ``judges`` is the global, read-only eval set. sha256 lets the editor
    detect server-side changes between load and save (optimistic concurrency).
    """
    snap = await _load_snapshot(sf)
    view = _voice_view(snap, voice)
    items: list[dict[str, Any]] = []
    judges: list[dict[str, Any]] = []
    for template_id, row in view.items():
        entry = {
            "template_id": template_id,
            "filename": row.filename,
            "category": row.category,
            "sha256": row.sha256,
            "bytes": row.bytes,
            "voice_slug": row.voice_slug,
        }
        if row.category in _EDITABLE_CATEGORIES:
            items.append(entry)
        elif row.category == "judge":
            judges.append({**entry, "read_only": True})
    items.sort(key=lambda i: (i["category"] == "partial", i["template_id"]))
    judges.sort(key=lambda i: i["template_id"])
    return {"voice": voice, "templates": items, "judges": judges}


@router.get("/templates/{template_id}")
async def template(
    template_id: str,
    voice: str = Query(DEFAULT_VOICE),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict:
    snap = await _load_snapshot(sf)
    view = _voice_view(snap, voice)
    row = _editable_or_404(view, template_id)
    return {
        "template_id": template_id,
        "voice": voice,
        "voice_slug": row.voice_slug,
        "filename": row.filename,
        "category": row.category,
        "template": row.body,
        "sha256": row.sha256,
    }


@router.get("/templates/{template_id}/schema")
async def template_schema(
    template_id: str,
    voice: str = Query(DEFAULT_VOICE),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """Return required placeholders + the include directives this template
    currently references. The editor uses both: required placeholders drive
    the validation chips; includes drive the preview tabs.
    """
    snap = await _load_snapshot(sf)
    view = _voice_view(snap, voice)
    row = _editable_or_404(view, template_id)
    body = row.body
    required = sorted(_REQUIRED_PLACEHOLDERS.get(template_id, set()))
    found_placeholders = sorted({m.group(1) for m in _PLACEHOLDER_RE.finditer(body)})
    found_includes = sorted({m.group(1) for m in _INCLUDE_RE.finditer(body)})
    partial_ids = _partial_ids(view)
    unknown_includes = sorted(name for name in found_includes if name not in partial_ids)
    schema_model = _RESPONSE_SCHEMA_MODELS.get(template_id)
    # Resolve the voice's stored locale so the user-prompt reference reflects the
    # same {market} the runtime injects, and expose it for the editor's locale
    # panel. Mirrors the preview path (DB-first, default-voice + HK-ZH fallback).
    async with sf() as session:
        locale = await _stored_locale(voice, session=session)
    user_prompt = _USER_PROMPT_REFERENCES.get(template_id)
    if user_prompt is not None:
        user_prompt = user_prompt.replace("{market}", locale.market)
    return {
        "template_id": template_id,
        "voice": voice,
        "required_placeholders": required,
        "found_placeholders": found_placeholders,
        "found_includes": found_includes,
        "unknown_includes": unknown_includes,
        "user_prompt_template": user_prompt,
        "voice_locale": locale.model_dump(),
        "response_json_schema": (
            schema_model.model_json_schema() if schema_model is not None else None
        ),
    }


@router.get("/templates/{template_id}/consumers")
async def template_consumers(
    template_id: str,
    voice: str = Query(DEFAULT_VOICE),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    snap = await _load_snapshot(sf)
    view = _voice_view(snap, voice)
    _editable_or_404(view, template_id)
    return {
        "template_id": template_id,
        "voice": voice,
        "consumers": _consumers_of(template_id, view),
    }


class _SaveTemplateRequest(BaseModel):
    template: str
    expected_sha256: str = Field(..., min_length=64, max_length=64)
    # Optional one-line human change reason, stored on the version row. Not part
    # of the hashed body, so sha/parity are unaffected.
    note: str | None = Field(default=None, max_length=500)


@router.put("/templates/{template_id}")
async def save_template(
    template_id: str,
    body: _SaveTemplateRequest,
    voice: str = Query(DEFAULT_VOICE),
    editor: str = Depends(_require_editor),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """Validate + persist a template edit for ``voice``, stamping a version row.

    HTTP 401 if no ``X-Editor-Email`` (production only).
    HTTP 403 if the editor isn't in the allowlist (production only).
    HTTP 404 if ``(voice, template_id)`` is not an editable agent/partial row —
    judges and any template the voice does not own are not writable here.
    HTTP 409 if expected_sha256 no longer matches the row (another editor saved
    between load and save).
    HTTP 413 if the new body exceeds the 64 KiB cap.
    HTTP 400 if a required placeholder is removed, or if a `{{include:X}}`
    directive references an unknown partial.

    The ``prompt_templates`` UPDATE and the ``prompt_versions`` INSERT commit in
    a single transaction so history can never advertise a save that didn't land
    (or vice versa). The row is locked ``FOR UPDATE`` to serialise concurrent
    saves of the same ``(voice, template)``. After commit the in-process cache is
    invalidated so this worker serves the new body immediately.
    """
    new_bytes = body.template.encode("utf-8")
    new_sha = _sha256(body.template)
    version_id = uuid4()

    async with sf() as session:
        row = (
            await session.execute(
                select(PromptTemplate)
                .where(
                    PromptTemplate.voice_slug == voice,
                    PromptTemplate.template_id == template_id,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if row is None or row.category not in _EDITABLE_CATEGORIES:
            raise HTTPException(404, f"unknown template_id '{template_id}'")

        current_sha = row.sha256
        if current_sha != body.expected_sha256:
            raise HTTPException(
                409,
                {
                    "error": "stale_sha",
                    "message": "template was changed since you loaded it",
                    "current_sha256": current_sha,
                },
            )

        if len(new_bytes) > _MAX_TEMPLATE_BYTES:
            raise HTTPException(
                413,
                f"template exceeds {_MAX_TEMPLATE_BYTES} bytes (got {len(new_bytes)})",
            )

        required = _REQUIRED_PLACEHOLDERS.get(template_id, set())
        present = {m.group(1) for m in _PLACEHOLDER_RE.finditer(body.template)}
        missing = sorted(required - present)
        if missing:
            raise HTTPException(
                400,
                {
                    "error": "missing_placeholders",
                    "message": "template removed required placeholders",
                    "missing": missing,
                },
            )

        partial_ids = set(
            (
                await session.execute(
                    select(PromptTemplate.template_id).where(
                        PromptTemplate.category == "partial",
                        PromptTemplate.voice_slug.in_([voice, SHARED_VOICE]),
                    )
                )
            )
            .scalars()
            .all()
        )
        bad_includes = sorted(
            m.group(1)
            for m in _INCLUDE_RE.finditer(body.template)
            if m.group(1) not in partial_ids
        )
        if bad_includes:
            raise HTTPException(
                400,
                {
                    "error": "unknown_includes",
                    "message": "template references partials that do not exist",
                    "unknown": bad_includes,
                },
            )

        row.body = body.template
        row.sha256 = new_sha
        row.bytes = len(new_bytes)
        row.updated_by = editor
        version = PromptVersion(
            version_id=version_id,
            voice_slug=voice,
            template_id=template_id,
            sha256=new_sha,
            parent_sha256=current_sha,
            body=body.template,
            bytes=len(new_bytes),
            saved_by=editor,
            kind="save",
            note=body.note,
        )
        session.add(version)
        await session.commit()
        await session.refresh(version, attribute_names=["saved_at"])
        saved_at = version.saved_at

    prompts_store.invalidate(template_id)

    return {
        "template_id": template_id,
        "voice": voice,
        "sha256": new_sha,
        "bytes": len(new_bytes),
        "version_id": str(version_id),
        "saved_at": saved_at.isoformat(),
        "saved_by": editor,
    }


@router.get("/templates/{template_id}/history")
async def template_history(
    template_id: str,
    voice: str = Query(DEFAULT_VOICE),
    limit: int = Query(50, ge=1, le=200),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """Newest-first list of saves + reverts for this ``(voice, template)``.

    ``body`` is omitted to keep the payload small — fetch a single version
    via ``GET .../versions/{version_id}`` when the user opens the preview
    dialog.
    """
    async with sf() as session:
        snap = await prompts_store.snapshot(session)
        live = _editable_or_404(_voice_view(snap, voice), template_id)
        # Absolute, stable version numbering (oldest = 1): count the whole
        # lineage, then derive each row's number from its newest-first offset so
        # the displayed `v{n}` does not shift when older rows fall outside `limit`.
        total = (
            await session.execute(
                select(func.count())
                .select_from(PromptVersion)
                .where(
                    PromptVersion.voice_slug == voice,
                    PromptVersion.template_id == template_id,
                )
            )
        ).scalar_one()
        rows = (
            (
                await session.execute(
                    select(PromptVersion)
                    .where(
                        PromptVersion.voice_slug == voice,
                        PromptVersion.template_id == template_id,
                    )
                    .order_by(PromptVersion.saved_at.desc())
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
    return {
        "template_id": template_id,
        "voice": voice,
        # The sha of the body the editor is live-editing; the history row whose
        # sha matches is flagged `is_current` (the "● Live" entry).
        "current_sha256": live.sha256,
        "versions": [
            {
                "version_id": str(r.version_id),
                "version_number": total - i,
                "is_current": r.sha256 == live.sha256,
                "sha256": r.sha256,
                "parent_sha256": r.parent_sha256,
                "bytes": r.bytes,
                "saved_by": r.saved_by,
                "saved_at": r.saved_at.isoformat(),
                "kind": r.kind,
                "note": r.note,
            }
            for i, r in enumerate(rows)
        ],
    }


@router.get("/templates/{template_id}/versions/{version_id}")
async def template_version(
    template_id: str,
    version_id: UUID,
    voice: str = Query(DEFAULT_VOICE),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """Return one version's full body + metadata.

    Used by the revert flow to preview before confirming, and by any future
    diff UI. Scoped to ``(voice, template_id)`` so a stray UUID for a different
    voice/template returns 404 instead of leaking another body.
    """
    async with sf() as session:
        snap = await prompts_store.snapshot(session)
        _editable_or_404(_voice_view(snap, voice), template_id)
        row = (
            await session.execute(
                select(PromptVersion).where(
                    PromptVersion.version_id == version_id,
                    PromptVersion.voice_slug == voice,
                    PromptVersion.template_id == template_id,
                )
            )
        ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, f"unknown version_id '{version_id}'")
    return {
        "version_id": str(row.version_id),
        "template_id": row.template_id,
        "sha256": row.sha256,
        "parent_sha256": row.parent_sha256,
        "body": row.body,
        "bytes": row.bytes,
        "saved_by": row.saved_by,
        "saved_at": row.saved_at.isoformat(),
        "kind": row.kind,
        "note": row.note,
    }


class _RevertRequest(BaseModel):
    target_version_id: UUID
    expected_sha256: str = Field(..., min_length=64, max_length=64)


@router.post("/templates/{template_id}/revert")
async def revert_template(
    template_id: str,
    body: _RevertRequest,
    voice: str = Query(DEFAULT_VOICE),
    editor: str = Depends(_require_editor),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """Replace ``voice``'s live template body with the body of a past version.

    Subject to the same optimistic-concurrency gate as PUT — the row's sha must
    still match ``expected_sha256`` — and stamped as a ``kind='revert'`` row so
    the trail is symmetric. The UPDATE + INSERT commit in one transaction.
    """
    version_id = uuid4()

    async with sf() as session:
        row = (
            await session.execute(
                select(PromptTemplate)
                .where(
                    PromptTemplate.voice_slug == voice,
                    PromptTemplate.template_id == template_id,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if row is None or row.category not in _EDITABLE_CATEGORIES:
            raise HTTPException(404, f"unknown template_id '{template_id}'")

        current_sha = row.sha256
        if current_sha != body.expected_sha256:
            raise HTTPException(
                409,
                {
                    "error": "stale_sha",
                    "message": "template was changed since you loaded it",
                    "current_sha256": current_sha,
                },
            )

        target = (
            await session.execute(
                select(PromptVersion).where(
                    PromptVersion.version_id == body.target_version_id,
                    PromptVersion.voice_slug == voice,
                    PromptVersion.template_id == template_id,
                )
            )
        ).scalar_one_or_none()
        if target is None:
            raise HTTPException(404, f"unknown version_id '{body.target_version_id}'")

        new_text = target.body
        new_bytes = new_text.encode("utf-8")
        if len(new_bytes) > _MAX_TEMPLATE_BYTES:
            # Should be impossible — the row was inserted under the same cap —
            # but guard anyway so a future cap reduction doesn't bypass it.
            raise HTTPException(413, f"target version exceeds {_MAX_TEMPLATE_BYTES} bytes")

        new_sha = _sha256(new_text)
        row.body = new_text
        row.sha256 = new_sha
        row.bytes = len(new_bytes)
        row.updated_by = editor
        version = PromptVersion(
            version_id=version_id,
            voice_slug=voice,
            template_id=template_id,
            sha256=new_sha,
            parent_sha256=current_sha,
            body=new_text,
            bytes=len(new_bytes),
            saved_by=editor,
            kind="revert",
        )
        session.add(version)
        await session.commit()
        await session.refresh(version, attribute_names=["saved_at"])
        saved_at = version.saved_at

    prompts_store.invalidate(template_id)

    return {
        "template_id": template_id,
        "voice": voice,
        "sha256": new_sha,
        "bytes": len(new_bytes),
        "version_id": str(version_id),
        "saved_at": saved_at.isoformat(),
        "saved_by": editor,
        "reverted_from_version_id": str(body.target_version_id),
    }


class _PreviewRequest(BaseModel):
    template: str
    route: str | None = None
    context: dict[str, str] = Field(default_factory=dict)
    # Optional unsaved-locale override for live preview. Snake_case wire contract
    # (matches ``VoiceLocale``); missing fields fall back to HK-ZH defaults.
    # Absent ⇒ ``None`` ⇒ preview uses the voice's stored locale (today's path).
    locale: VoiceLocale | None = None
    # Optional unsaved sibling-partial drafts (partial_id -> body). Threaded into
    # assembly so multiple drafts reflect at once. Absent/empty ⇒ no-op. Pydantic
    # raises 422 for a non-mapping value.
    partial_overrides: dict[str, str] = Field(default_factory=dict)
    # Optional unsaved draft source policy (structured). Rendered server-side via
    # ``SourcePolicy.to_prompt_block`` into ``{source_policy_block}``. Absent ⇒
    # the voice's stored policy (today's path). 422 for a non-object value.
    source_policy: dict[str, Any] | None = None
    # Optional unsaved draft glossary (snake_case ``GlossaryEntry`` list), folded
    # into the persona block. Absent ⇒ the persona's stored glossary. 422 for a
    # non-array value.
    glossary: list[GlossaryEntry] | None = None


@dataclass(frozen=True)
class _PersonaOverride:
    """Unsaved persona-draft overrides for the editor preview.

    Folds the previously-standalone ``locale_override`` together with the new
    ``glossary`` draft into one object threaded through
    :func:`_default_persona_block` / :func:`PersonaPack.to_prompt_block`. Each
    field ``None`` ⇒ the persona's stored value (byte-identical to today).
    """

    locale: VoiceLocale | None = None
    glossary: list[GlossaryEntry] | None = None


def _enforce_preview_caps(body: _PreviewRequest) -> None:
    """Reject oversized unsaved-draft preview input before any DB work.

    Mirrors the Workers backend caps (routes/prompts.ts): per-value byte caps
    reuse the save-path ``_MAX_TEMPLATE_BYTES``; entry counts and per-string
    field lengths are bounded. 413 for byte-size excess, 422 for count/length.
    """
    if len(body.partial_overrides) > _MAX_PARTIAL_OVERRIDE_ENTRIES:
        raise HTTPException(
            422, f"partial_overrides exceeds {_MAX_PARTIAL_OVERRIDE_ENTRIES} entries"
        )
    for key, value in body.partial_overrides.items():
        if len(value.encode("utf-8")) > _MAX_TEMPLATE_BYTES:
            raise HTTPException(
                413, f"partial_overrides['{key}'] exceeds {_MAX_TEMPLATE_BYTES} bytes"
            )
    if body.source_policy is not None:
        prompt_block = body.source_policy.get("prompt_block")
        if (
            isinstance(prompt_block, str)
            and len(prompt_block.encode("utf-8")) > _MAX_TEMPLATE_BYTES
        ):
            raise HTTPException(
                413, f"source_policy.prompt_block exceeds {_MAX_TEMPLATE_BYTES} bytes"
            )
    if body.glossary is not None:
        if len(body.glossary) > _MAX_GLOSSARY_ENTRIES:
            raise HTTPException(422, f"glossary exceeds {_MAX_GLOSSARY_ENTRIES} entries")
        for entry in body.glossary:
            if (
                len(entry.term) > _MAX_GLOSSARY_FIELD_CHARS
                or len(entry.preferred) > _MAX_GLOSSARY_FIELD_CHARS
            ):
                raise HTTPException(
                    422, f"glossary field exceeds {_MAX_GLOSSARY_FIELD_CHARS} chars"
                )


@router.post("/templates/{template_id}/preview")
async def preview_template(
    template_id: str,
    body: _PreviewRequest,
    voice: str = Query(DEFAULT_VOICE),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """Render the fully assembled system prompt this template participates in.

    For an agent prompt, the request `template` IS the prompt body and any
    `route` must match `template_id`; includes resolve from the DB snapshot
    within ``voice`` (with the ``__shared__`` fallback). For a partial, `route`
    picks which consumer to preview against — the agent body is read from the
    voice's snapshot and `{{include:<partial>}}` is replaced with the request
    body before the rest of the partials resolve from the DB.

    Placeholders are substituted with live defaults (today's date, the voice's
    persona, the voice's source_policy) unless the request overrides them via
    `context`.
    """
    _enforce_preview_caps(body)
    snap = await _load_snapshot(sf)
    view = _voice_view(snap, voice)
    row = _editable_or_404(view, template_id)

    if row.category == "partial":
        if body.route is None:
            raise HTTPException(400, "route is required when previewing a partial")
        if body.route not in _agent_ids(view):
            raise HTTPException(400, f"unknown route '{body.route}'")
        if template_id not in _partials_referenced_by(body.route, view):
            raise HTTPException(
                400,
                f"route '{body.route}' does not include partial '{template_id}'",
            )
        route_id = body.route
        # Slot the currently-edited partial draft AND any sibling partial drafts
        # into the consumer at once. The currently-edited template wins over a
        # same-id entry in ``partial_overrides`` (it is the focused buffer).
        overrides = {**body.partial_overrides, template_id: body.template}
        assembled = prompts_store.assemble_with_overrides(
            route_id,
            snap,
            overrides,
            voice_slug=voice,
        )
    else:
        route_id = body.route or template_id
        if route_id != template_id:
            raise HTTPException(400, "route must equal template_id for agent prompts")
        try:
            # Resolve the submitted agent body directly, threading sibling partial
            # drafts through its includes. Empty mapping ⇒ identical to resolve_body.
            assembled = prompts_store.resolve_body_with_overrides(
                body.template, snap, body.partial_overrides, voice_slug=voice
            )
        except prompts_store.PromptTemplateNotFound as e:
            raise HTTPException(
                400,
                {
                    "error": "unknown_includes",
                    "message": "template references partials that do not exist",
                    "detail": str(e),
                },
            ) from e

    async with sf() as session:
        # ``source_policy_block`` source: a structured draft ``source_policy``
        # (rendered server-side via the policy's own ``to_prompt_block`` — never
        # hand-rendered on the client) wins; else the voice's stored policy.
        if body.source_policy is not None:
            source_policy_default = SourcePolicy(body.source_policy).to_prompt_block()
        else:
            source_policy = await source_policy_store.get_policy(
                voice_slug=voice, session=session
            )
            source_policy_default = source_policy.to_prompt_block()
        # Absent an unsaved locale override (the /voices live-edit path), resolve
        # the voice's STORED locale so the assembled prompt shows the same
        # brand/language/market/heading tokens the runtime agents inject —
        # instead of leaking literal {brand_name}/… placeholders.
        effective_locale = (
            body.locale
            if body.locale is not None
            else await _stored_locale(voice, session=session)
        )
    # Fold locale + the draft glossary (if any) into one persona override; an
    # absent glossary ⇒ the persona's stored glossary, byte-identical to today.
    persona_override = _PersonaOverride(locale=effective_locale, glossary=body.glossary)
    resolved = _substitute_placeholders(
        assembled,
        overrides=body.context,
        view=view,
        voice=voice,
        source_policy_default=source_policy_default,
        persona_override=persona_override,
    )
    return {"resolved": resolved, "route": route_id, "voice": voice}


async def _stored_locale(voice: str, *, session: AsyncSession) -> VoiceLocale:
    """The voice's stored locale (DB-first, YAML fallback) for preview surfaces.

    Mirrors what the runtime writer/outline/audit/topic_hot agents inject so the
    assembled-prompt preview and the user-prompt reference resolve
    ``{brand_name}``/``{output_language}``/``{market}``/… to the same values
    Gemini sees. Falls back to the default voice, then the HK-ZH defaults, when
    no persona row/YAML exists for ``voice``.
    """
    for slug in dict.fromkeys((voice, DEFAULT_VOICE)):
        try:
            return (await load_persona(slug, session=session)).locale
        except FileNotFoundError:
            continue
    return VoiceLocale()


def _default_persona_block(
    voice: str, persona_override: "_PersonaOverride | None" = None
) -> str:
    """Best-effort persona block for the preview, from the voice's YAML config.

    Falls back to the default voice, then a placeholder, when a voice has no
    bundled YAML (e.g. a duplicated voice exists only in the DB). The persona
    block is preview-cosmetic — runtime assembly reads the persona from the DB.

    When ``persona_override`` supplies an unsaved locale and/or glossary (live
    preview of in-progress edits), the persona block renders under that locale's
    labels and/or that draft glossary instead of the YAML-stored values. Each
    field absent ⇒ stored value, byte-identical to today.
    """
    for slug in dict.fromkeys((voice, DEFAULT_VOICE)):
        try:
            pack = load_persona_from_yaml(slug)
            if persona_override is not None:
                update: dict[str, Any] = {}
                if persona_override.locale is not None:
                    update["locale"] = persona_override.locale
                if persona_override.glossary is not None:
                    update["glossary"] = persona_override.glossary
                if update:
                    pack = pack.model_copy(update=update)
            return pack.to_prompt_block(None)
        except FileNotFoundError:
            continue
    return "（preview: persona block not configured）"


def _substitute_placeholders(
    text: str,
    *,
    overrides: dict[str, str],
    view: dict[str, TemplateRow],
    voice: str = DEFAULT_VOICE,
    source_policy_default: str = "",
    persona_override: "_PersonaOverride | None" = None,
) -> str:
    """Fill `{name}` placeholders with overrides or sensible defaults.

    Defaults mirror the live values the writer/audit/outline loaders compute
    at runtime so the preview reflects what Gemini actually sees. The persona
    block comes from the voice's YAML config, the source-policy block from the
    voice's policy, and `create_mode_block` from the voice's DB-backed
    ``outline_create_mode`` template (with the ``__shared__`` fallback).
    """
    today_iso = overrides.get("today_date", date.today().isoformat())
    locale_override = persona_override.locale if persona_override is not None else None

    if "persona_block" in overrides:
        persona_block = overrides["persona_block"]
    else:
        persona_block = _default_persona_block(voice, persona_override)

    if "source_policy_block" in overrides:
        source_policy_block = overrides["source_policy_block"]
    else:
        source_policy_block = source_policy_default

    if "create_mode_block" in overrides:
        create_mode_block = overrides["create_mode_block"]
    else:
        cm = view.get("outline_create_mode")
        create_mode_block = cm.body.rstrip() if cm is not None else ""

    out = (
        text.replace("{persona_block}", persona_block)
        .replace("{today_date}", today_iso)
        .replace("{source_policy_block}", source_policy_block)
        .replace("{create_mode_block}", create_mode_block)
    )
    # Live-locale preview: when an unsaved locale is supplied, resolve the
    # brand/language/market tokens and sources/FAQ heading tokens the runtime
    # agents inject so the assembled prompt reflects the in-progress edits.
    # Done BEFORE the context loop so an explicit ``context`` value still wins.
    # Absent ⇒ these tokens fall through exactly as today.
    if locale_override is not None:
        out = (
            out.replace("{brand_name}", locale_override.brand_name)
            .replace("{output_language}", locale_override.output_language)
            .replace("{market}", locale_override.market)
            .replace("{faq_heading}", locale_override.faq_heading)
            .replace("{sources_heading}", locale_override.sources_heading or "")
        )
    for key, value in overrides.items():
        if key in {"persona_block", "today_date", "source_policy_block", "create_mode_block"}:
            continue
        out = out.replace(f"{{{key}}}", value)
    return out


_USER_PROMPT_AGENTS = {"gap_analysis", "outline", "writer", "audit"}


class _MissingInputs(Exception):
    pass


async def _render_user_prompt(*, session: AsyncSession, run: Run, agent: str) -> str:
    if agent == "gap_analysis":
        return gap_agent.build_user_prompt(
            topic=run.topic,
            keywords=run.keywords,
            article_url=run.article_url,
            acf_adv_id=run.acf_adv_id,
            acf_widget_id=run.acf_widget_id,
            mode=run.mode,
            edit_note=run.edit_note,
        )

    if agent == "outline":
        # Create-mode runs have no fetched article or gap analysis — the
        # outline is built straight from the brief (mirrors outline.py).
        if run.start_mode == "create":
            return outline_agent.build_user_prompt_create_mode(
                topic=run.topic,
                keywords=list(run.keywords or []),
                target_audience=run.target_audience,
                acf_adv_id=run.acf_adv_id,
                acf_widget_id=run.acf_widget_id,
                edit_note=run.edit_note,
            )
        ga = (
            await session.execute(
                select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
            )
        ).scalar_one_or_none()
        fa = (
            await session.execute(
                select(FetchedArticle).where(FetchedArticle.run_id == run.run_id)
            )
        ).scalar_one_or_none()
        if ga is None or fa is None:
            raise _MissingInputs("outline needs gap_analysis + fetched_article")
        return outline_agent.build_user_prompt(
            gap_analysis_payload=ga.payload,
            existing_markdown=fa.markdown,
            chosen_route=run.chosen_route or "small_refresh",
            acf_adv_id=run.acf_adv_id,
            acf_widget_id=run.acf_widget_id,
        )

    if agent == "writer":
        ga = (
            await session.execute(
                select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
            )
        ).scalar_one_or_none()
        ol = (
            await session.execute(
                select(OutlineRow).where(OutlineRow.run_id == run.run_id)
            )
        ).scalar_one_or_none()
        fa = (
            await session.execute(
                select(FetchedArticle).where(FetchedArticle.run_id == run.run_id)
            )
        ).scalar_one_or_none()
        # In create-mode the writer is the first content node: gap analysis and
        # the fetched article are absent, so fall back to empty payloads exactly
        # like run_writer does. The outline is always required.
        if ol is None or (run.start_mode != "create" and (ga is None or fa is None)):
            raise _MissingInputs("writer needs outline (+ gap_analysis + fetched_article in refresh)")  # noqa: E501
        return writer_agent.build_user_prompt(
            run=run,
            gap_analysis=ga.payload if ga is not None else {},
            outline=ol.payload,
            existing_markdown=fa.markdown if fa is not None else "",
            refine_notes=None,
        )

    # agent == "audit"
    draft = (
        await session.execute(
            select(Draft)
            .where(Draft.run_id == run.run_id)
            .order_by(Draft.iteration.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if draft is None:
        raise _MissingInputs("audit needs a draft")
    ga = (
        await session.execute(
            select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
        )
    ).scalar_one_or_none()
    if ga is None:
        raise _MissingInputs("audit needs gap_analysis")
    render = (
        await session.execute(select(Render).where(Render.draft_id == draft.draft_id))
    ).scalar_one_or_none()
    if render is None:
        raise _MissingInputs("audit needs a render")
    cits = (
        await session.execute(select(Citation).where(Citation.draft_id == draft.draft_id))
    ).scalars().all()
    audit_row = (
        await session.execute(select(AuditRun).where(AuditRun.draft_id == draft.draft_id))
    ).scalar_one_or_none()
    return audit_agent.build_user_prompt(
        html_body=render.html_body,
        gap_update_plan=ga.payload.get("update_plan", {}),
        citation_intents=draft.citation_intents,
        citations_summary=[
            {
                "domain": c.domain,
                "final_url": c.final_url,
                "policy": c.policy_decision,
                "displayed": c.was_displayed,
                "denied_reason": c.denied_reason,
            }
            for c in cits
        ],
        deterministic_findings=(
            (audit_row.deterministic_findings or {}).get("findings", []) if audit_row else []
        ),
        edit_note=run.edit_note,
    )


@router.get("/user-example")
async def user_example(
    run_id: UUID = Query(...),  # noqa: B008
    agent: str = Query(...),
    sf=Depends(_get_session_factory),  # noqa: ANN001, B008
) -> dict:
    if agent not in _USER_PROMPT_AGENTS:
        raise HTTPException(400, f"agent must be one of {sorted(_USER_PROMPT_AGENTS)}")
    async with sf() as session:
        run = (
            await session.execute(select(Run).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        if run is None:
            raise HTTPException(404, "run not found")
        try:
            prompt = await _render_user_prompt(session=session, run=run, agent=agent)
        except _MissingInputs as e:
            raise HTTPException(422, f"missing inputs: {e}") from e
    return {"run_id": str(run_id), "agent": agent, "prompt": prompt}
