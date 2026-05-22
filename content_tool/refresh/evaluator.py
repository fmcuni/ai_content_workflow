"""Composite staleness scoring + LLM-audit wrapper for refresh."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from content_tool.config import get_refresh_config
from content_tool.gemini.client import GeminiClient
from content_tool.refresh.deterministic_checks import DeterministicResult

Action = Literal["refresh", "monitor", "ok"]


@dataclass
class LLMFindings:
    severity_high: int = 0
    severity_medium: int = 0
    severity_low: int = 0
    raw: dict | None = None


def compute_staleness(
    det: DeterministicResult,
    llm: LLMFindings | None,
    age_days: int,
) -> tuple[Decimal, Action]:
    cfg = get_refresh_config()["scoring"]

    age_factor = min(10.0, 10.0 * age_days / cfg["age_full_score_days"])

    if llm is None:
        llm_factor = 0.0
    elif llm.severity_high > 0:
        llm_factor = 10.0
    elif llm.severity_medium > 0:
        llm_factor = 5.0
    else:
        llm_factor = 0.0

    raw_score = (
        cfg["age_weight"] * age_factor
        + cfg["det_high_weight"] * det.severity_high * 10.0
        + cfg["det_medium_weight"] * det.severity_medium * 5.0
        + cfg["llm_weight"] * llm_factor
    )
    score = Decimal(f"{max(0.0, min(10.0, raw_score)):.2f}")

    has_high_severity = det.severity_high > 0 or (llm is not None and llm.severity_high > 0)
    if score >= Decimal(str(cfg["refresh_threshold"])) or has_high_severity:
        action = "refresh"
    elif score >= Decimal(str(cfg["monitor_threshold"])):
        action = "monitor"
    else:
        action = "ok"

    return score, action


async def llm_audit_published(
    html: str,
    *,
    persona: str | None,
    gemini_client: GeminiClient,
) -> LLMFindings:
    """Run the existing audit prompt against published HTML.

    Reuses build_system_prompt + build_user_prompt from content_tool/agents/audit.py.
    The production run_audit() is coupled to a DB session and cannot be used here;
    instead we call gemini_client.generate() directly with the same prompt pair.

    Non-HTML context fields (gap_update_plan, citation_intents, citations_summary,
    deterministic_findings) are passed as empty structures because this path audits
    published content without a pipeline run_id.

    TODO(Task-9 integration): consider whether a thin refresh-specific system prompt
    variant is preferable to reusing the full draft-audit prompt verbatim.
    """
    from datetime import date

    from content_tool.agents.audit import build_system_prompt, build_user_prompt
    from content_tool.models.audit import AuditOutput

    effective_persona = persona or "default"
    sys_prompt = build_system_prompt(effective_persona, date.today())
    user_prompt = build_user_prompt(
        html_body=html,
        gap_update_plan={},
        citation_intents=[],
        citations_summary=[],
        deterministic_findings=[],
    )

    result = await gemini_client.generate(
        agent="audit",
        system_prompt=sys_prompt,
        user_prompt=user_prompt,
        response_schema=AuditOutput.model_json_schema(),
        tools=[],
    )

    llm_output = AuditOutput.model_validate(result.parsed)

    findings = LLMFindings(
        severity_high=sum(1 for f in llm_output.findings if f.severity == "high"),
        severity_medium=sum(1 for f in llm_output.findings if f.severity == "medium"),
        severity_low=sum(1 for f in llm_output.findings if f.severity == "low"),
        raw=llm_output.model_dump(mode="json"),
    )
    return findings
