import json
from datetime import date
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool import prompts_store
from content_tool.agents.audit_checks import run_deterministic_checks
from content_tool.db.models import AuditRun, Citation, Draft, GapAnalysisRow, Render, Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.audit import AuditFinding, AuditOutput, SeveritySummary
from content_tool.models.persona import PersonaPack
from content_tool.policy.personas import load_persona


def build_system_prompt_from_pack(
    persona: PersonaPack,
    today: date,
    *,
    template_text: str,
    context_text: str | None = None,
) -> str:
    """Render the audit system prompt from a pre-loaded PersonaPack.

    ``template_text`` is the assembled prompt body from the DB store.
    ``context_text`` filters the glossary block to entries whose term or
    variants appear in the draft. When ``None`` the full glossary renders.
    """
    return template_text.replace(
        "{persona_block}", persona.to_prompt_block(context_text)
    ).replace("{today_date}", today.isoformat())


async def build_system_prompt(
    persona_name: str,
    today: date,
    *,
    session: AsyncSession,
    context_text: str | None = None,
) -> str:
    persona = await load_persona(persona_name, session=session)
    template_text = await prompts_store.get_assembled("audit", session=session)
    return build_system_prompt_from_pack(
        persona, today, template_text=template_text, context_text=context_text
    )


def build_user_prompt(
    *,
    html_body: str,
    gap_update_plan: dict,
    citation_intents: list,
    citations_summary: list,
    deterministic_findings: list,
) -> str:
    return (
        f"# final_html\n{html_body}\n\n"
        f"# gap_analysis.update_plan\n{json.dumps(gap_update_plan, ensure_ascii=False)}\n\n"
        f"# citation_intents\n{json.dumps(citation_intents, ensure_ascii=False)}\n\n"
        f"# citations (resolved)\n{json.dumps(citations_summary, ensure_ascii=False)}\n\n"
        f"# deterministic_findings\n{json.dumps(deterministic_findings, ensure_ascii=False)}"
    )


async def run_audit(
    *,
    session: AsyncSession,
    gemini: GeminiClient,
    draft_id: UUID,
    topic_category: str | None,
    today: date,
) -> AuditOutput:
    draft = (
        await session.execute(select(Draft).where(Draft.draft_id == draft_id))
    ).scalar_one()
    run = (
        await session.execute(select(Run).where(Run.run_id == draft.run_id))
    ).scalar_one()
    # Create-mode runs (Task 4) skip gap_analysis entirely, so there is no
    # GapAnalysisRow to read. The audit prompt only consumes the
    # ``update_plan`` slice of the payload — fall back to an empty dict when
    # the row is missing so the rest of the audit (LLM + deterministic
    # checks + persistence) runs unchanged.
    ga = (
        await session.execute(
            select(GapAnalysisRow).where(GapAnalysisRow.run_id == run.run_id)
        )
    ).scalar_one_or_none()
    ga_payload: dict = ga.payload if ga is not None else {}
    render = (
        await session.execute(select(Render).where(Render.draft_id == draft_id))
    ).scalar_one()
    citations = (
        await session.execute(select(Citation).where(Citation.draft_id == draft_id))
    ).scalars().all()

    citations_summary = [
        {
            "domain": c.domain,
            "final_url": c.final_url,
            "policy": c.policy_decision,
            "displayed": c.was_displayed,
            "denied_reason": c.denied_reason,
        }
        for c in citations
    ]
    denied_displayed = any(
        c.was_displayed and c.policy_decision == "denied" for c in citations
    )

    det_findings = run_deterministic_checks(
        render.html_body, citations_denied_displayed=denied_displayed
    )

    sys_prompt = await build_system_prompt(
        run.persona,
        today,
        session=session,
        context_text=render.html_body,
    )
    user_prompt = build_user_prompt(
        html_body=render.html_body,
        gap_update_plan=ga_payload.get("update_plan", {}),
        citation_intents=draft.citation_intents,
        citations_summary=citations_summary,
        deterministic_findings=det_findings,
    )

    result = await gemini.generate(
        agent="audit",
        system_prompt=sys_prompt,
        user_prompt=user_prompt,
        response_schema=AuditOutput.model_json_schema(),
        tools=[],
    )
    llm_audit = AuditOutput.model_validate(result.parsed)

    # Promote deterministic dict findings into AuditFinding instances
    det_findings_typed = [AuditFinding.model_validate(f) for f in det_findings]
    combined_findings = list(llm_audit.findings) + det_findings_typed

    # Recompute overall_pass with det findings folded in
    high_count = sum(1 for f in combined_findings if f.severity == "high")
    medium_count = sum(1 for f in combined_findings if f.severity == "medium")
    low_count = sum(1 for f in combined_findings if f.severity == "low")
    any_must_fix = any(f.must_fix for f in combined_findings)
    overall_pass = high_count == 0 and not any_must_fix

    merged = AuditOutput(
        overall_pass=overall_pass,
        severity_summary=SeveritySummary(
            high=high_count, medium=medium_count, low=low_count
        ),
        findings=combined_findings,
    )

    # Idempotency: LangGraph can re-enter the production sub-graph (resume,
    # retry, refine loop) and call this node twice for the same draft.
    # ``AuditRun.draft_id`` is UNIQUE, so a blind INSERT crashes with
    # ``UniqueViolationError`` on the second pass. DELETE first so the node has
    # single-row semantics regardless of how many times the graph replays it.
    await session.execute(delete(AuditRun).where(AuditRun.draft_id == draft_id))
    session.add(
        AuditRun(
            draft_id=draft_id,
            overall_pass=merged.overall_pass,
            severity_high=merged.severity_summary.high,
            severity_medium=merged.severity_summary.medium,
            severity_low=merged.severity_summary.low,
            llm_findings={"findings": [f.model_dump() for f in llm_audit.findings]},
            deterministic_findings={"findings": det_findings},
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            latency_ms=result.latency_ms,
        )
    )
    await session.commit()
    return merged
