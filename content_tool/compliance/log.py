from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import (
    AuditRun,
    Citation,
    ComplianceLog,
    Draft,
    GapAnalysisRow,
    Run,
)
from content_tool.observability.cost import CostCalculator


async def write_compliance_log(
    *,
    session: AsyncSession,
    run_id: UUID,
    cost_calc: CostCalculator,
    gemini_model: str,
) -> None:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    drafts = (await session.execute(select(Draft).where(Draft.run_id == run_id))).scalars().all()
    if not drafts:
        return
    latest = max(drafts, key=lambda d: d.iteration)
    audit = (
        await session.execute(select(AuditRun).where(AuditRun.draft_id == latest.draft_id))
    ).scalar_one_or_none()
    # Create-mode runs (Task 4) have no GapAnalysisRow — fall back to zeros
    # for the GA token-count contribution to total_tokens / cost_cents.
    ga = (
        await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))
    ).scalar_one_or_none()
    ga_tokens_in = (ga.tokens_in or 0) if ga is not None else 0
    ga_tokens_out = (ga.tokens_out or 0) if ga is not None else 0
    ga_thinking = (ga.thinking_tokens or 0) if ga is not None else 0
    citations = (
        await session.execute(select(Citation).where(Citation.draft_id == latest.draft_id))
    ).scalars().all()

    cited = ";".join(sorted({c.domain for c in citations if c.was_displayed and c.domain}))
    denied = ";".join(
        sorted({c.domain for c in citations if c.policy_decision == "denied" and c.domain})
    )

    total_tokens = sum(
        (d.tokens_in or 0) + (d.tokens_out or 0) + (d.thinking_tokens or 0) for d in drafts
    )
    total_tokens += ga_tokens_in + ga_tokens_out + ga_thinking
    cost_cents = cost_calc.estimate_cents(
        model=gemini_model,
        tokens_in=sum((d.tokens_in or 0) for d in drafts) + ga_tokens_in,
        tokens_out=sum((d.tokens_out or 0) for d in drafts) + ga_tokens_out,
        thinking_tokens=sum((d.thinking_tokens or 0) for d in drafts) + ga_thinking,
    )

    stmt = pg_insert(ComplianceLog).values(
        run_id=run_id,
        persona=run.persona,
        article_url=run.article_url,
        wp_pushed_post_id=run.wp_pushed_post_id,
        chosen_route=run.chosen_route or "unknown",
        sources_cited=cited,
        sources_denied=denied,
        audit_overall_pass=audit.overall_pass if audit else False,
        audit_severity_summary={
            "high": audit.severity_high if audit else 0,
            "medium": audit.severity_medium if audit else 0,
            "low": audit.severity_low if audit else 0,
        },
        approver_email=run.approved_by or "unknown",
        iteration_count=run.iteration_count or 0,
        gemini_model=gemini_model,
        total_tokens=total_tokens,
        est_cost_usd_cents=cost_cents,
    ).on_conflict_do_nothing(index_elements=["run_id"])

    await session.execute(stmt)
    await session.commit()
