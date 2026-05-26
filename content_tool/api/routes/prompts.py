from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.agents import audit as audit_agent
from content_tool.agents import gap_analysis as gap_agent
from content_tool.agents import outline as outline_agent
from content_tool.agents import writer as writer_agent
from content_tool.api.prompt_graph import PROMPT_GRAPH
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
    "writer_small_refresh": "writer_small_refresh.md",
    "writer_full_rewrite": "writer_full_rewrite.md",
}


@router.get("/graph")
async def graph() -> dict:
    return PROMPT_GRAPH


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
        if ga is None or ol is None or fa is None:
            raise _MissingInputs("writer needs gap_analysis + outline + fetched_article")
        return writer_agent.build_user_prompt(
            run=run,
            gap_analysis=ga.payload,
            outline=ol.payload,
            existing_markdown=fa.markdown,
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
