from datetime import date
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select

from content_tool.api.schemas import CreateRunRequest, CreateRunResponse
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
