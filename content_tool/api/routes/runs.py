from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sse_starlette.sse import EventSourceResponse

from content_tool.api.schemas import (
    CreateRunRequest,
    CreateRunResponse,
    DryPublishResponse,
    Hitl2Request,
    ResumeRequest,
)
from content_tool.api.sse import sse_stream
from content_tool.db.models import (
    AuditRun,
    Draft,
    GapAnalysisRow,
    OutlineRow,
    RefreshEvaluation,
    Render,
    Run,
)
from content_tool.refresh.inventory import upsert_article

router = APIRouter(prefix="/runs", tags=["runs"])


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


def get_runner(request: Request):  # noqa: ANN201
    return request.app.state.run_executor


@router.post("", response_model=CreateRunResponse)
async def create_run(
    payload: CreateRunRequest,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> CreateRunResponse:
    run_id = uuid4()
    async with sf() as session:
        article = await upsert_article(
            session,
            article_url=payload.article_url,
            topic=payload.topic,
            persona=payload.persona,
            topic_category=payload.topic_category,
        )

        ev = None
        if payload.triggered_by_evaluation_id is not None:
            ev = await session.get(RefreshEvaluation, payload.triggered_by_evaluation_id)
            if ev is None or ev.article_id != article.article_id:
                raise HTTPException(status_code=422, detail="triggered_by_evaluation_id mismatch")
            if ev.outcome != "open":
                raise HTTPException(status_code=409, detail="evaluation already resolved")

        row = Run(
            run_id=run_id,
            created_by=payload.editor_email,
            status="pending",
            article_url=payload.article_url,
            topic=payload.topic,
            keywords=payload.keywords,
            mode=payload.mode,
            edit_note=payload.edit_note,
            acf_adv_id=payload.acf_adv_id,
            acf_widget_id=payload.acf_widget_id,
            persona=payload.persona,
            topic_category=payload.topic_category,
            today_date=date.today(),
            article_id=article.article_id,
            triggered_by_evaluation_id=ev.evaluation_id if ev else None,
        )
        session.add(row)
        await session.flush()

        if ev is not None:
            ev.outcome = "triggered"
            ev.resulting_run_id = run_id
            ev.outcome_set_at = datetime.now(UTC)
            ev.outcome_set_by = payload.editor_email

        await session.commit()

    # Fire and forget: spawn graph execution
    await runner.start(run_id)
    return CreateRunResponse(
        run_id=run_id,
        status="pending",
        created_at=row.created_at if row.created_at else datetime.now(UTC),
        article_id=article.article_id,
    )


@router.get("")
async def list_runs(
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    status: str | None = None,
    limit: int = 50,
) -> list[dict]:
    async with sf() as session:
        q = select(Run)
        if status:
            q = q.where(Run.status == status)
        q = q.order_by(Run.created_at.desc()).limit(limit)
        rows = (await session.execute(q)).scalars().all()
        return [
            {
                "run_id": str(r.run_id),
                "status": r.status,
                "topic": r.topic,
                "article_url": r.article_url,
                "mode": r.mode,
                "created_at": r.created_at.isoformat(),
                "chosen_route": r.chosen_route,
                "iteration_count": r.iteration_count,
            }
            for r in rows
        ]


@router.get("/{run_id}")
async def get_run(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "run not found")
        return {
            "run_id": str(row.run_id),
            "status": row.status,
            "topic": row.topic,
            "article_url": row.article_url,
            "mode": row.mode,
            "chosen_route": row.chosen_route,
            "iteration_count": row.iteration_count,
        }


@router.get("/{run_id}/events")
async def events(
    run_id: UUID,
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> EventSourceResponse:
    return EventSourceResponse(sse_stream(runner, run_id))


@router.post("/{run_id}/resume")
async def resume_run(
    run_id: UUID,
    payload: ResumeRequest,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> dict:
    state_update: dict = {"hitl_1_decision": payload.decision}
    if payload.decision == "edit_outline" and payload.edited_outline:
        state_update["outline"] = payload.edited_outline
        # Also persist to outlines.human_edits
        from sqlalchemy import update

        from content_tool.db.models import OutlineRow

        async with sf() as session:
            await session.execute(
                update(OutlineRow)
                .where(OutlineRow.run_id == run_id)
                .values(edited_by_human=True, human_edits=payload.edited_outline)
            )
            await session.commit()
    if payload.decision == "override_route" and payload.new_route:
        state_update["chosen_route"] = payload.new_route
        # Persist to Run row so writer.py (reads run.chosen_route from DB) honors the override
        from sqlalchemy import update

        async with sf() as session:
            await session.execute(
                update(Run)
                .where(Run.run_id == run_id)
                .values(chosen_route=payload.new_route)
            )
            await session.commit()

    await runner.resume(run_id, state_update)
    return {"ok": True}


@router.post("/{run_id}/hitl-2")
async def hitl_2(
    run_id: UUID, payload: Hitl2Request,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> dict:
    from sqlalchemy import update

    async with sf() as session:
        await session.execute(
            update(Run).where(Run.run_id == run_id).values(
                hitl_2_decision=payload.decision,
                hitl_2_notes=payload.notes,
                approved_at=datetime.now(UTC) if payload.decision == "approve" else None,
                approved_by="placeholder-editor",  # Plan 4 binds real identity
                wp_publish_status=payload.wp_publish_status,
                wp_author_id=payload.wp_author_id,
                wp_category_ids=payload.wp_category_ids,
                wp_tag_ids=payload.wp_tag_ids,
                wp_featured_media_id=payload.wp_featured_media_id,
                wp_slug=payload.wp_slug,
                wp_excerpt=payload.wp_excerpt,
                wp_publish_at=payload.wp_publish_at,
            )
        )
        await session.commit()

    state_update: dict = {"hitl_2_decision": payload.decision, "hitl_2_notes": payload.notes}
    if payload.decision != "approve":
        state_update["status"] = "rejected" if payload.decision == "reject" else "changes_requested"

    await runner.resume(run_id, state_update)
    return {"ok": True}


@router.get("/{run_id}/gap-analysis")
async def get_gap_analysis(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        row = (
            await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        return row.payload


@router.get("/{run_id}/outline")
async def get_outline(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        row = (
            await session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        return {"payload": row.payload, "edited_by_human": row.edited_by_human}


@router.get("/{run_id}/drafts/latest")
async def get_latest_draft(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        q = select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        row = (await session.execute(q)).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        return {
            "draft_id": str(row.draft_id),
            "iteration": row.iteration,
            "diagnose": row.diagnose,
            "markup_raw": row.markup_raw,
            "final_markup": row.final_markup,
        }


@router.get("/{run_id}/render")
async def get_latest_render(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        q = select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        latest_draft = (await session.execute(q)).scalar_one_or_none()
        if not latest_draft:
            raise HTTPException(404, "no draft")
        render = (
            await session.execute(
                select(Render).where(Render.draft_id == latest_draft.draft_id)
            )
        ).scalar_one_or_none()
        if not render:
            raise HTTPException(404, "no render")
        return {
            "seo_title": render.seo_title,
            "meta_description": render.meta_description,
            "html_body": render.html_body,
            "faq_schema_jsonld": render.faq_schema_jsonld,
            "excerpt_suggestion": render.excerpt_suggestion,
            "slug_suggestion": render.slug_suggestion,
        }


@router.get("/{run_id}/audit")
async def get_latest_audit(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        q = select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        latest_draft = (await session.execute(q)).scalar_one_or_none()
        if not latest_draft:
            raise HTTPException(404, "no draft")
        audit = (
            await session.execute(
                select(AuditRun).where(AuditRun.draft_id == latest_draft.draft_id)
            )
        ).scalar_one_or_none()
        if not audit:
            raise HTTPException(404, "no audit")
        return {
            "overall_pass": audit.overall_pass,
            "severity_high": audit.severity_high,
            "severity_medium": audit.severity_medium,
            "severity_low": audit.severity_low,
            "llm_findings": audit.llm_findings,
            "deterministic_findings": audit.deterministic_findings,
        }


@router.post("/{run_id}/dry-publish", response_model=DryPublishResponse)
async def dry_publish(run_id: UUID, request: Request, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    """Return the exact REST payload we'd send to WP, WITHOUT calling WP."""
    from content_tool.db.models import FetchedArticle

    target_base = request.app.state.wp_client.base_url
    target_label = request.app.state.wp_target
    seo_plugin = request.app.state.seo_plugin

    async with sf() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run_id)
        )).scalar_one()
        draft = (await session.execute(
            select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        )).scalar_one()
        render = (await session.execute(
            select(Render).where(Render.draft_id == draft.draft_id)
        )).scalar_one()

    meta_key = (
        "_yoast_wpseo_metadesc" if seo_plugin == "yoast"
        else ("rank_math_description" if seo_plugin == "rankmath" else None)
    )
    meta = {meta_key: render.meta_description} if meta_key else {}

    body: dict = {
        "title": render.seo_title,
        "content": render.html_body,
        "status": run.wp_publish_status or "draft",
        "categories": run.wp_category_ids or [],
        "tags": run.wp_tag_ids or [],
        "meta": meta,
    }
    if run.wp_excerpt or render.excerpt_suggestion:
        body["excerpt"] = run.wp_excerpt or render.excerpt_suggestion
    if run.wp_slug:
        body["slug"] = run.wp_slug
    if run.wp_author_id:
        body["author"] = run.wp_author_id
    if run.wp_featured_media_id:
        body["featured_media"] = run.wp_featured_media_id

    url = (
        f"{target_base}/wp-json/wp/v2/posts/{fa.wp_post_id}"
        if fa.wp_post_id
        else f"{target_base}/wp-json/wp/v2/posts"
    )
    method = "PUT" if fa.wp_post_id else "POST"

    return {
        "target_base_url": target_base,
        "target_label": target_label,
        "request_method": method,
        "request_url": url,
        "request_headers": {
            "authorization": "Basic <redacted>",
            "content-type": "application/json",
        },
        "request_body": body,
    }
