from datetime import date, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import and_, select, text

from content_tool.config import config_path, get_settings
from content_tool.db.models import Draft, GapAnalysisRow, Run
from content_tool.observability.cost import CostCalculator

router = APIRouter(prefix="/costs", tags=["costs"])


def get_session_factory(request: Request) -> Any:  # noqa: ANN401
    return request.app.state.session_factory


@router.get("/run/{run_id}")
async def cost_for_run(
    run_id: UUID,
    sf: Any = Depends(get_session_factory),  # noqa: ANN401, B008
) -> dict[str, int]:
    calc = CostCalculator.load_from(config_path("pricing.yaml"))
    async with sf() as session:
        ga = (
            await session.execute(
                select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id)
            )
        ).scalar_one_or_none()
        drafts = (
            await session.execute(select(Draft).where(Draft.run_id == run_id))
        ).scalars().all()
        if not ga and not drafts:
            raise HTTPException(404, "no usage")

        tin = (ga.tokens_in or 0) if ga else 0
        tout = (ga.tokens_out or 0) if ga else 0
        tthk = (ga.thinking_tokens or 0) if ga else 0
        for d in drafts:
            tin += d.tokens_in or 0
            tout += d.tokens_out or 0
            tthk += d.thinking_tokens or 0

        # Price by the model the run actually used. gap_analyses.model is the
        # only per-run model record; create-mode runs have no GA row, so fall
        # back to the currently-configured default model.
        model = ga.model if ga else get_settings().gemini_model
        cents = calc.estimate_cents(
            model=model,
            tokens_in=tin,
            tokens_out=tout,
            thinking_tokens=tthk,
        )
        return {
            "tokens_in": tin,
            "tokens_out": tout,
            "thinking_tokens": tthk,
            "est_usd_cents": cents,
        }


@router.get("/summary")
async def cost_summary(
    start: date,
    end: date,
    sf: Any = Depends(get_session_factory),  # noqa: ANN401, B008
) -> dict[str, Any]:
    calc = CostCalculator.load_from(config_path("pricing.yaml"))
    async with sf() as session:
        runs = (
            await session.execute(
                select(Run).where(
                    and_(
                        Run.created_at >= datetime.combine(start, datetime.min.time()),
                        Run.created_at <= datetime.combine(end, datetime.max.time()),
                    )
                )
            )
        ).scalars().all()
        total_cents = 0
        for r in runs:
            ga = (
                await session.execute(
                    select(GapAnalysisRow).where(GapAnalysisRow.run_id == r.run_id)
                )
            ).scalar_one_or_none()
            drafts = (
                await session.execute(select(Draft).where(Draft.run_id == r.run_id))
            ).scalars().all()
            tin = (ga.tokens_in or 0) if ga else 0
            tout = (ga.tokens_out or 0) if ga else 0
            tthk = (ga.thinking_tokens or 0) if ga else 0
            for d in drafts:
                tin += d.tokens_in or 0
                tout += d.tokens_out or 0
                tthk += d.thinking_tokens or 0
            model = ga.model if ga else get_settings().gemini_model
            total_cents += calc.estimate_cents(
                model=model,
                tokens_in=tin,
                tokens_out=tout,
                thinking_tokens=tthk,
            )

        refresh = (
            await session.execute(
                text("""
                    SELECT
                      COALESCE(SUM(tokens_in), 0)          AS tokens_in,
                      COALESCE(SUM(tokens_out), 0)         AS tokens_out,
                      COALESCE(SUM(est_cost_usd_cents), 0) AS cents
                    FROM content_tool.refresh_evaluations
                    WHERE evaluated_at >= now() - INTERVAL '30 days'
                """)
            )
        ).one()

        return {
            "runs": len(runs),
            "total_usd_cents": total_cents,
            "refresh_scan_30d": {
                "tokens_in": int(refresh.tokens_in),
                "tokens_out": int(refresh.tokens_out),
                "cents": int(refresh.cents),
            },
        }
