from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.api.schemas import (
    ArticleDetailOut,
    ArticleListResponse,
    ArticleOut,
    DismissRequest,
    RefreshEvaluationOut,
)
from content_tool.db.models import Article, RefreshEvaluation, Run

router = APIRouter(prefix="/articles", tags=["articles"])


def _get_session_factory(request: Request):  # noqa: ANN202
    return request.app.state.session_factory


async def _session(
    sf=Depends(_get_session_factory),  # noqa: ANN001, B008
) -> AsyncSession:
    sf_typed: async_sessionmaker[AsyncSession] = sf
    async with sf_typed() as s:
        yield s


def _to_out(
    a: Article, latest_eval: RefreshEvaluation | None, open_runs_count: int
) -> ArticleOut:
    return ArticleOut(
        article_id=a.article_id,
        article_url=a.article_url,
        wp_post_id=a.wp_post_id,
        topic=a.topic,
        persona=a.persona,
        topic_category=a.topic_category,
        first_seen_at=a.first_seen_at,
        last_persisted_at=a.last_persisted_at,
        next_scan_due_at=a.next_scan_due_at,
        dismissed_until=a.dismissed_until,
        latest_evaluation=(
            RefreshEvaluationOut.model_validate(latest_eval, from_attributes=True)
            if latest_eval
            else None
        ),
        open_runs_count=open_runs_count,
    )


_OPEN_STATUSES = ("pending", "strategy", "hitl_1", "production", "hitl_2", "persisted")


@router.get("", response_model=ArticleListResponse)
async def list_articles(
    needs_refresh: bool | None = Query(None),
    persona: str | None = Query(None),
    topic_category: str | None = Query(None),
    q: str | None = Query(None),
    sort: Literal["staleness", "next_scan_due", "last_persisted"] = Query("staleness"),
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(_session),  # noqa: B008
) -> ArticleListResponse:
    # Subquery: latest evaluation per article via row_number()
    latest_eval_sq = select(
        RefreshEvaluation.article_id,
        RefreshEvaluation.evaluation_id.label("latest_eval_id"),
        func.row_number()
        .over(
            partition_by=RefreshEvaluation.article_id,
            order_by=RefreshEvaluation.evaluated_at.desc(),
        )
        .label("rn"),
    ).subquery()
    latest_only = (
        select(latest_eval_sq.c.article_id, latest_eval_sq.c.latest_eval_id)
        .where(latest_eval_sq.c.rn == 1)
        .subquery()
    )

    base = (
        select(Article, RefreshEvaluation)
        .join(latest_only, latest_only.c.article_id == Article.article_id, isouter=True)
        .join(
            RefreshEvaluation,
            RefreshEvaluation.evaluation_id == latest_only.c.latest_eval_id,
            isouter=True,
        )
    )

    if needs_refresh:
        base = base.where(
            RefreshEvaluation.recommended_action == "refresh",
            RefreshEvaluation.outcome == "open",
        )
    if persona:
        base = base.where(Article.persona == persona)
    if topic_category:
        base = base.where(Article.topic_category == topic_category)
    if q:
        like = f"%{q}%"
        base = base.where(
            or_(Article.topic.ilike(like), Article.article_url.ilike(like))
        )

    if sort == "staleness":
        base = base.order_by(RefreshEvaluation.staleness_score.desc().nullslast())
    elif sort == "next_scan_due":
        base = base.order_by(Article.next_scan_due_at.asc())
    else:
        base = base.order_by(Article.last_persisted_at.desc().nullslast())

    total_q = select(func.count()).select_from(base.subquery())
    total = (await session.execute(total_q)).scalar_one()

    rows = (await session.execute(base.limit(limit).offset(offset))).all()
    items: list[ArticleOut] = []
    for a, ev in rows:
        ip = (
            await session.execute(
                select(func.count())
                .select_from(Run)
                .where(Run.article_id == a.article_id)
                .where(Run.status.in_(_OPEN_STATUSES))
            )
        ).scalar_one()
        items.append(_to_out(a, ev, open_runs_count=int(ip)))

    return ArticleListResponse(items=items, total=int(total))


@router.get("/{article_id}", response_model=ArticleDetailOut)
async def get_article(
    article_id: UUID,
    session: AsyncSession = Depends(_session),  # noqa: B008
) -> ArticleDetailOut:
    a = await session.get(Article, article_id)
    if a is None:
        raise HTTPException(status_code=404, detail="article not found")
    evs = (
        await session.execute(
            select(RefreshEvaluation)
            .where(RefreshEvaluation.article_id == article_id)
            .order_by(RefreshEvaluation.evaluated_at.desc())
            .limit(10)
        )
    ).scalars().all()
    run_ids = (
        await session.execute(
            select(Run.run_id)
            .where(Run.article_id == article_id)
            .order_by(Run.created_at.desc())
            .limit(10)
        )
    ).scalars().all()
    ip = (
        await session.execute(
            select(func.count())
            .select_from(Run)
            .where(Run.article_id == article_id)
            .where(Run.status.in_(_OPEN_STATUSES))
        )
    ).scalar_one()
    latest = evs[0] if evs else None
    base = _to_out(a, latest, open_runs_count=int(ip))
    return ArticleDetailOut(
        **base.model_dump(),
        recent_evaluations=[
            RefreshEvaluationOut.model_validate(e, from_attributes=True) for e in evs
        ],
        recent_run_ids=list(run_ids),
    )


@router.post("/{article_id}/dismiss", response_model=ArticleOut)
async def dismiss_article(
    article_id: UUID,
    body: DismissRequest,
    session: AsyncSession = Depends(_session),  # noqa: B008
) -> ArticleOut:
    if body.until <= datetime.now(UTC):
        raise HTTPException(status_code=422, detail="until must be in the future")
    a = await session.get(Article, article_id)
    if a is None:
        raise HTTPException(status_code=404, detail="article not found")
    a.dismissed_until = body.until
    a.dismissed_by = body.dismissed_by
    a.dismissed_reason = body.reason
    a.next_scan_due_at = body.until
    a.updated_at = datetime.now(UTC)

    latest_open = (
        await session.execute(
            select(RefreshEvaluation)
            .where(
                RefreshEvaluation.article_id == article_id,
                RefreshEvaluation.outcome == "open",
            )
            .order_by(RefreshEvaluation.evaluated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if latest_open is not None:
        latest_open.outcome = "dismissed"
        latest_open.outcome_set_at = datetime.now(UTC)
        latest_open.outcome_set_by = body.dismissed_by

    await session.commit()
    await session.refresh(a)
    return _to_out(a, latest_open, open_runs_count=0)


@router.delete("/{article_id}/dismiss", response_model=ArticleOut)
async def clear_dismissal(
    article_id: UUID,
    session: AsyncSession = Depends(_session),  # noqa: B008
) -> ArticleOut:
    a = await session.get(Article, article_id)
    if a is None:
        raise HTTPException(status_code=404, detail="article not found")
    a.dismissed_until = None
    a.dismissed_by = None
    a.dismissed_reason = None
    a.updated_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(a)
    return _to_out(a, None, open_runs_count=0)
