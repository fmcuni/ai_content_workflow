import hashlib
import os
import re
import tempfile
from datetime import date
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.agents import audit as audit_agent
from content_tool.agents import gap_analysis as gap_agent
from content_tool.agents import outline as outline_agent
from content_tool.agents import writer as writer_agent
from content_tool.agents.writer import resolve_includes
from content_tool.api.prompt_graph import PROMPT_GRAPHS
from content_tool.db.models import (
    AuditRun,
    Citation,
    Draft,
    FetchedArticle,
    GapAnalysisRow,
    OutlineRow,
    Render,
    Run,
)
from content_tool.policy.personas import load_persona_from_yaml
from content_tool.policy.source_policy import DEFAULT_POLICY_PATH, SourcePolicy

router = APIRouter(prefix="/prompts", tags=["prompts"])

_PROMPT_DIR = Path(__file__).resolve().parents[3] / "prompts"

# Agent-prompt files exposed by `/prompts/templates/{id}`. These are the
# full system-prompt templates that ship to Gemini, one per node in the graph.
_TEMPLATE_FILES = {
    "audit": "audit.md",
    "gap_analysis": "gap_analysis.md",
    "outline": "outline.md",
    "outline_create_mode": "outline_create_mode.md",
    "writer_small_refresh": "writer_small_refresh.md",
    "writer_full_rewrite": "writer_full_rewrite.md",
    "writer_create": "writer_create.md",
    "topic_gen": "topic_gen.md",
    "topic_dedup": "topic_dedup.md",
    "topic_hot": "topic_hot.md",
}

# Shared partials — slotted into agent prompts via `{{include:NAME}}`. Their
# template_id is the underscore-prefixed filename stem so the editor can
# distinguish them from full agent prompts in the list view.
_PARTIAL_FILES = {
    "_writer_brand_block": "_writer_brand_block.md",
    "_writer_schema": "_writer_schema.md",
    "_writer_seo": "_writer_seo.md",
    "_writer_refine_notes": "_writer_refine_notes.md",
    "_writer_output_format_tail": "_writer_output_format_tail.md",
}

_ALL_FILES = {**_TEMPLATE_FILES, **_PARTIAL_FILES}

# Required `{placeholder}` set per template — the writer/audit/outline/etc.
# loaders perform these substitutions on the rendered system prompt, so
# removing one would leak a literal `{persona_block}` into the model. The
# editor blocks any save that drops one of these.
_REQUIRED_PLACEHOLDERS: dict[str, set[str]] = {
    "audit": {"persona_block", "today_date"},
    "gap_analysis": {"today_date"},
    "outline": {"today_date", "create_mode_block"},
    "outline_create_mode": set(),
    "writer_small_refresh": {"persona_block", "today_date", "source_policy_block"},
    "writer_full_rewrite": {"persona_block", "today_date", "source_policy_block"},
    "writer_create": {"persona_block", "today_date", "source_policy_block"},
    "topic_gen": set(),
    "topic_dedup": set(),
    "topic_hot": set(),
    # Partials are pure text today, but their schema endpoint still returns
    # an entry so the UI can treat them uniformly.
    "_writer_brand_block": set(),
    "_writer_schema": set(),
    "_writer_seo": set(),
    "_writer_refine_notes": set(),
    "_writer_output_format_tail": set(),
}

_MAX_TEMPLATE_BYTES = 64 * 1024
_INCLUDE_RE = re.compile(r"\{\{include:([A-Za-z0-9_./-]+)\}\}")
_PLACEHOLDER_RE = re.compile(r"\{([a-z][a-z0-9_]*)\}")


def _category(template_id: str) -> str:
    return "partial" if template_id in _PARTIAL_FILES else "agent"


def _resolve_path(template_id: str) -> Path:
    filename = _ALL_FILES.get(template_id)
    if filename is None:
        raise HTTPException(404, f"unknown template_id '{template_id}'")
    return _PROMPT_DIR / filename


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _consumers_of(template_id: str) -> list[str]:
    """Agent templates whose body contains `{{include:<template_id>}}`.

    For agent templates the answer is just `[template_id]` — the editor
    previews the agent prompt against itself.
    """
    if template_id in _TEMPLATE_FILES:
        return [template_id]
    hits: list[str] = []
    for agent_id, filename in _TEMPLATE_FILES.items():
        body = (_PROMPT_DIR / filename).read_text(encoding="utf-8")
        for match in _INCLUDE_RE.finditer(body):
            if match.group(1) == template_id:
                hits.append(agent_id)
                break
    return sorted(hits)


def _partials_referenced_by(route_id: str) -> set[str]:
    body = (_PROMPT_DIR / _TEMPLATE_FILES[route_id]).read_text(encoding="utf-8")
    return {m.group(1) for m in _INCLUDE_RE.finditer(body)}


@router.get("/graph")
async def graph(mode: str = Query("refresh")) -> dict:
    g = PROMPT_GRAPHS.get(mode)
    if g is None:
        raise HTTPException(404, f"unknown graph mode '{mode}'")
    return g


@router.get("/templates")
async def list_templates() -> dict[str, Any]:
    """List every editable prompt file — agent prompts + shared partials.

    sha256 lets the editor detect server-side changes between load and save
    (optimistic concurrency).
    """
    items: list[dict[str, Any]] = []
    for template_id, filename in _ALL_FILES.items():
        path = _PROMPT_DIR / filename
        body = path.read_text(encoding="utf-8")
        items.append(
            {
                "template_id": template_id,
                "filename": filename,
                "category": _category(template_id),
                "sha256": _sha256(body),
                "bytes": len(body.encode("utf-8")),
            }
        )
    items.sort(key=lambda i: (i["category"] == "partial", i["template_id"]))
    return {"templates": items}


@router.get("/templates/{template_id}")
async def template(template_id: str) -> dict:
    path = _resolve_path(template_id)
    body = path.read_text(encoding="utf-8")
    return {
        "template_id": template_id,
        "filename": path.name,
        "category": _category(template_id),
        "template": body,
        "sha256": _sha256(body),
    }


@router.get("/templates/{template_id}/schema")
async def template_schema(template_id: str) -> dict[str, Any]:
    """Return required placeholders + the include directives this template
    currently references. The editor uses both: required placeholders drive
    the validation chips; includes drive the preview tabs.
    """
    path = _resolve_path(template_id)
    body = path.read_text(encoding="utf-8")
    required = sorted(_REQUIRED_PLACEHOLDERS.get(template_id, set()))
    found_placeholders = sorted({m.group(1) for m in _PLACEHOLDER_RE.finditer(body)})
    found_includes = sorted({m.group(1) for m in _INCLUDE_RE.finditer(body)})
    unknown_includes = sorted(
        name for name in found_includes if name not in _PARTIAL_FILES
    )
    return {
        "template_id": template_id,
        "required_placeholders": required,
        "found_placeholders": found_placeholders,
        "found_includes": found_includes,
        "unknown_includes": unknown_includes,
    }


@router.get("/templates/{template_id}/consumers")
async def template_consumers(template_id: str) -> dict[str, Any]:
    if template_id not in _ALL_FILES:
        raise HTTPException(404, f"unknown template_id '{template_id}'")
    return {"template_id": template_id, "consumers": _consumers_of(template_id)}


class _SaveTemplateRequest(BaseModel):
    template: str
    expected_sha256: str = Field(..., min_length=64, max_length=64)


@router.put("/templates/{template_id}")
async def save_template(template_id: str, body: _SaveTemplateRequest) -> dict[str, Any]:
    """Validate + atomically write a template file.

    HTTP 409 if expected_sha256 no longer matches what's on disk (another
    editor saved between load and save).
    HTTP 413 if the new body exceeds the 64 KiB cap.
    HTTP 400 if a required placeholder is removed, or if a `{{include:X}}`
    directive references an unknown partial.

    Atomic write via os.replace — a half-written file never overwrites the
    real one. Git history is the audit trail.
    """
    path = _resolve_path(template_id)
    current = path.read_text(encoding="utf-8")
    current_sha = _sha256(current)
    if current_sha != body.expected_sha256:
        raise HTTPException(
            409,
            {
                "error": "stale_sha",
                "message": "template was changed on disk since you loaded it",
                "current_sha256": current_sha,
            },
        )

    new_bytes = body.template.encode("utf-8")
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

    bad_includes = sorted(
        m.group(1)
        for m in _INCLUDE_RE.finditer(body.template)
        if m.group(1) not in _PARTIAL_FILES
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

    # Same-directory tmp + os.replace = atomic on POSIX; avoids cross-fs
    # edge cases when /tmp is a different filesystem.
    fd, tmp_path = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(new_bytes)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    return {
        "template_id": template_id,
        "sha256": _sha256(body.template),
        "bytes": len(new_bytes),
    }


class _PreviewRequest(BaseModel):
    template: str
    route: str | None = None
    context: dict[str, str] = Field(default_factory=dict)


@router.post("/templates/{template_id}/preview")
async def preview_template(template_id: str, body: _PreviewRequest) -> dict[str, Any]:
    """Render the fully assembled system prompt this template participates in.

    For an agent prompt, the request `template` IS the prompt body and any
    `route` must match `template_id`. For a partial, `route` picks which
    consumer to preview against — the agent file is read from disk and
    `{{include:<partial>}}` is replaced with the request body before the
    rest of the partials resolve from disk.

    Placeholders are substituted with live defaults (today's date, the
    `bowtie_default` persona, the active source_policy) unless the request
    overrides them via `context`.
    """
    if template_id not in _ALL_FILES:
        raise HTTPException(404, f"unknown template_id '{template_id}'")

    is_partial = template_id in _PARTIAL_FILES
    if is_partial:
        if body.route is None:
            raise HTTPException(400, "route is required when previewing a partial")
        if body.route not in _TEMPLATE_FILES:
            raise HTTPException(400, f"unknown route '{body.route}'")
        if template_id not in _partials_referenced_by(body.route):
            raise HTTPException(
                400,
                f"route '{body.route}' does not include partial '{template_id}'",
            )
        route_id = body.route
        route_text = (_PROMPT_DIR / _TEMPLATE_FILES[route_id]).read_text(
            encoding="utf-8"
        )
        assembled = _resolve_with_override(
            route_text, override_name=template_id, override_body=body.template
        )
    else:
        route_id = body.route or template_id
        if route_id != template_id:
            raise HTTPException(
                400, "route must equal template_id for agent prompts"
            )
        try:
            assembled = resolve_includes(body.template, base=_PROMPT_DIR)
        except FileNotFoundError as e:
            raise HTTPException(
                400,
                {
                    "error": "unknown_includes",
                    "message": "template references partials that do not exist",
                    "detail": str(e),
                },
            ) from e

    resolved = _substitute_placeholders(assembled, overrides=body.context)
    return {"resolved": resolved, "route": route_id}


def _resolve_with_override(
    text: str,
    *,
    override_name: str,
    override_body: str,
    base: Path = _PROMPT_DIR,
    _seen: frozenset[str] = frozenset(),
) -> str:
    """Like writer.resolve_includes but `override_name` resolves to
    `override_body` (the editor's draft) instead of reading from disk.
    """

    def _sub(match: re.Match[str]) -> str:
        name = match.group(1)
        if name in _seen:
            raise ValueError(f"include cycle detected at {{{{include:{name}}}}}")
        if name == override_name:
            body = override_body.rstrip("\n")
        else:
            sub_path = base / f"{name}.md"
            body = sub_path.read_text(encoding="utf-8").rstrip("\n")
        return _resolve_with_override(
            body,
            override_name=override_name,
            override_body=override_body,
            base=base,
            _seen=_seen | {name},
        )

    return _INCLUDE_RE.sub(_sub, text)


def _substitute_placeholders(text: str, *, overrides: dict[str, str]) -> str:
    """Fill `{name}` placeholders with overrides or sensible defaults.

    Defaults mirror the live values the writer/audit/outline loaders compute
    at runtime so the preview reflects what Gemini actually sees.
    """
    today_iso = overrides.get("today_date", date.today().isoformat())

    if "persona_block" in overrides:
        persona_block = overrides["persona_block"]
    else:
        try:
            persona = load_persona_from_yaml("bowtie_default")
            persona_block = persona.to_prompt_block(None)
        except FileNotFoundError:
            persona_block = "（preview: persona block not configured）"  # noqa: RUF001

    if "source_policy_block" in overrides:
        source_policy_block = overrides["source_policy_block"]
    else:
        try:
            source_policy_block = SourcePolicy.load_from(
                DEFAULT_POLICY_PATH
            ).to_prompt_block()
        except FileNotFoundError:
            source_policy_block = "（preview: source policy not configured）"  # noqa: RUF001

    if "create_mode_block" in overrides:
        create_mode_block = overrides["create_mode_block"]
    else:
        create_mode_path = _PROMPT_DIR / "outline_create_mode.md"
        create_mode_block = (
            create_mode_path.read_text(encoding="utf-8").rstrip()
            if create_mode_path.exists()
            else ""
        )

    out = (
        text.replace("{persona_block}", persona_block)
        .replace("{today_date}", today_iso)
        .replace("{source_policy_block}", source_policy_block)
        .replace("{create_mode_block}", create_mode_block)
    )
    for key, value in overrides.items():
        if key in {"persona_block", "today_date", "source_policy_block", "create_mode_block"}:
            continue
        out = out.replace(f"{{{key}}}", value)
    return out


_USER_PROMPT_AGENTS = {"gap_analysis", "outline", "writer", "audit"}


class _MissingInputs(Exception):
    pass


def _get_session_factory(request: Request) -> async_sessionmaker[Any]:
    return request.app.state.session_factory  # type: ignore[no-any-return]


async def _render_user_prompt(
    *, session: AsyncSession, run: Run, agent: str
) -> str:
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
        ga = (await session.execute(
            select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
        )).scalar_one_or_none()
        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run.run_id)
        )).scalar_one_or_none()
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
        ga = (await session.execute(
            select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
        )).scalar_one_or_none()
        ol = (await session.execute(
            select(OutlineRow).where(OutlineRow.run_id == run.run_id)
        )).scalar_one_or_none()
        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run.run_id)
        )).scalar_one_or_none()
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
    draft = (await session.execute(
        select(Draft).where(Draft.run_id == run.run_id)
        .order_by(Draft.iteration.desc()).limit(1)
    )).scalar_one_or_none()
    if draft is None:
        raise _MissingInputs("audit needs a draft")
    ga = (await session.execute(
        select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
    )).scalar_one_or_none()
    if ga is None:
        raise _MissingInputs("audit needs gap_analysis")
    render = (await session.execute(
        select(Render).where(Render.draft_id == draft.draft_id)
    )).scalar_one_or_none()
    if render is None:
        raise _MissingInputs("audit needs a render")
    cits = (await session.execute(
        select(Citation).where(Citation.draft_id == draft.draft_id)
    )).scalars().all()
    audit_row = (await session.execute(
        select(AuditRun).where(AuditRun.draft_id == draft.draft_id)
    )).scalar_one_or_none()
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
            (audit_row.deterministic_findings or {}).get("findings", [])
            if audit_row else []
        ),
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
