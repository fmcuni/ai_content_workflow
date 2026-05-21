import csv
import io
from datetime import date, datetime

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import and_, select

from content_tool.db.models import ComplianceLog

router = APIRouter(prefix="/compliance", tags=["compliance"])


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


@router.get("/export.csv")
async def export_csv(
    start: date,
    end: date,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> Response:
    async with sf() as session:
        rows = (
            (
                await session.execute(
                    select(ComplianceLog)
                    .where(
                        and_(
                            ComplianceLog.persisted_at
                            >= datetime.combine(start, datetime.min.time()),
                            ComplianceLog.persisted_at
                            <= datetime.combine(end, datetime.max.time()),
                        )
                    )
                    .order_by(ComplianceLog.persisted_at)
                )
            )
            .scalars()
            .all()
        )

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "run_id",
            "persisted_at",
            "persona",
            "article_url",
            "wp_pushed_post_id",
            "chosen_route",
            "sources_cited",
            "sources_denied",
            "audit_overall_pass",
            "audit_severity_high",
            "audit_severity_medium",
            "audit_severity_low",
            "approver_email",
            "iteration_count",
            "gemini_model",
            "total_tokens",
            "est_cost_usd_cents",
        ]
    )
    for r in rows:
        s: dict[str, int] = r.audit_severity_summary or {}
        w.writerow(
            [
                str(r.run_id),
                r.persisted_at.isoformat(),
                r.persona,
                r.article_url,
                r.wp_pushed_post_id or "",
                r.chosen_route,
                r.sources_cited,
                r.sources_denied or "",
                r.audit_overall_pass,
                s.get("high", 0),
                s.get("medium", 0),
                s.get("low", 0),
                r.approver_email,
                r.iteration_count,
                r.gemini_model,
                r.total_tokens or 0,
                r.est_cost_usd_cents or 0,
            ]
        )

    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"content-disposition": f'attachment; filename="compliance_{start}_to_{end}.csv"'},
    )
