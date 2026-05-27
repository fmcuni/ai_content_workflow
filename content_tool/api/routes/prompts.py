from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.agents import audit as audit_agent
from content_tool.agents import gap_analysis as gap_agent
from content_tool.agents import outline as outline_agent
from content_tool.agents import writer as writer_agent
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

router = APIRouter(prefix="/prompts", tags=["prompts"])

_PROMPT_DIR = Path(__file__).resolve().parents[3] / "prompts"
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


@router.get("/graph")
async def graph(mode: str = Query("refresh")) -> dict:
    g = PROMPT_GRAPHS.get(mode)
    if g is None:
        raise HTTPException(404, f"unknown graph mode '{mode}'")
    return g


@router.get("/templates/{template_id}")
async def template(template_id: str) -> dict:
    filename = _TEMPLATE_FILES.get(template_id)
    if filename is None:
        raise HTTPException(404, f"unknown template_id '{template_id}'")
    path = _PROMPT_DIR / filename
    return {"template_id": template_id, "template": path.read_text(encoding="utf-8")}


_USER_PROMPT_AGENTS = {"gap_analysis", "outline", "writer", "audit"}


class _MissingInputs(Exception):
    pass


def _get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


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
    agent: str = Query(...),  # noqa: B008
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
