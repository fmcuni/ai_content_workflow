from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sse_starlette.sse import EventSourceResponse

from content_tool.api.schemas import (
    CreateRunRequest,
    CreateRunResponse,
    Hitl2Request,
    ResumeRequest,
)
from content_tool.api.sse import sse_stream
from content_tool.db.models import Run

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
        )
        session.add(row)
        await session.commit()

    # Fire and forget: spawn graph execution
    await runner.start(run_id)
    return CreateRunResponse(
        run_id=run_id,
        status="pending",
        created_at=row.created_at if row.created_at else __import__("datetime").datetime.utcnow(),
    )


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
