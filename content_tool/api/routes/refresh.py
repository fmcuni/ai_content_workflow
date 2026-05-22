"""Refresh route — /refresh/scan, /refresh/scan/{article_id}, /refresh/evaluations/{id}."""
from __future__ import annotations

from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.api.schemas import (
    RefreshEvaluationOut,
    ScanRequest,
    ScanResponse,
)
from content_tool.db.models import Article, RefreshEvaluation, Run
from content_tool.refresh.scanner import IN_FLIGHT_STATUSES, scan_article, scan_tick

router = APIRouter(prefix="/refresh", tags=["refresh"])


async def _session(request: Request) -> AsyncSession:  # type: ignore[return]
    sf: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    async with sf() as s:
        yield s


@router.post("/scan", response_model=ScanResponse)
async def trigger_scan(
    request: Request,
    body: ScanRequest = Body(default_factory=ScanRequest),  # noqa: B008
) -> ScanResponse:
    """Trigger a full scan tick.  Returns 409 if a tick is already in progress."""
    sf: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    wp_client = request.app.state.wp_client
    gemini = request.app.state.gemini_client

    result = await scan_tick(
        sf,
        wp_client=wp_client,
        gemini_client=gemini,
        trigger_source="manual_api",
        forced_article_ids=body.article_ids,
        force_bypass_due=body.force,
    )

    if result.skipped and any(
        s.get("reason") == "scan_in_progress" for s in result.skipped
    ):
        raise HTTPException(
            status_code=409,
            detail={"reason": "scan_in_progress"},
        )

    return ScanResponse(
        tick_id=result.tick_id,
        scanned=result.scanned,
        evaluations_created=result.evaluations_created,
        llm_calls=result.llm_calls,
        est_cost_usd_cents=result.est_cost_usd_cents,
        started_at=result.started_at,  # type: ignore[arg-type]
        finished_at=result.finished_at,  # type: ignore[arg-type]
        skipped=result.skipped or [],
    )


@router.post("/scan/{article_id}", response_model=RefreshEvaluationOut)
async def trigger_scan_one(
    article_id: UUID,
    request: Request,
    force: bool = False,
    session: AsyncSession = Depends(_session),  # noqa: B008
) -> RefreshEvaluationOut:
    """Trigger a scan for a single article.

    - 404 if article not found
    - 410 if article is dismissed and force=False
    - 409 if the article has an in-flight run
    """
    article = await session.get(Article, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="article not found")

    if article.dismissed_until is not None and not force:
        raise HTTPException(status_code=410, detail={"reason": "dismissed"})

    inflight = (
        await session.execute(
            select(Run.run_id)
            .where(Run.article_id == article_id)
            .where(Run.status.in_(IN_FLIGHT_STATUSES))
        )
    ).scalar_one_or_none()
    if inflight is not None:
        raise HTTPException(
            status_code=409,
            detail={"reason": "in_progress_run", "run_id": str(inflight)},
        )

    wp_client = request.app.state.wp_client
    gemini = request.app.state.gemini_client

    ev, _ = await scan_article(
        session,
        article=article,
        wp_client=wp_client,
        gemini_client=gemini,
        trigger_source="manual_per_article",
        llm_budget_remaining=999,
        tick_id=uuid4(),
    )
    await session.commit()
    await session.refresh(ev)
    return RefreshEvaluationOut.model_validate(ev, from_attributes=True)


@router.get("/evaluations/{evaluation_id}", response_model=RefreshEvaluationOut)
async def get_evaluation(
    evaluation_id: UUID,
    session: AsyncSession = Depends(_session),  # noqa: B008
) -> RefreshEvaluationOut:
    """Fetch a single refresh evaluation by ID.  Returns 404 if not found."""
    ev = await session.get(RefreshEvaluation, evaluation_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="evaluation not found")
    return RefreshEvaluationOut.model_validate(ev, from_attributes=True)
