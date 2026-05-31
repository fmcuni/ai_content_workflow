"""Shared LLM-judge scoring over a published run's latest draft.

Single source of truth used by both the nightly runner (``evals/runner.py``) and
the ad-hoc scorer (``evals/run_judges_adhoc.py``): gathers each judge's expected
inputs from the DB, runs the judges, and maps each rubric's raw output to a
normalised 0-1 score + pass flag. Read-only.
"""

import json
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.gemini.client import GeminiClient
from evals.judge_runner import run_judge

# metric -> (parsed key holding the raw score, raw is on a 1-5 scale, pass threshold on 0-1)
JUDGE_PASS_SPEC: dict[str, tuple[str, bool, float]] = {
    "brand_voice": ("score", True, 0.8),  # 4 of 5
    "hk_localisation": ("localisation_score", True, 0.8),
    "citation_alignment": ("support_rate", False, 0.8),
    "coverage": ("coverage_rate", False, 0.8),
}

JUDGE_METRICS: list[str] = list(JUDGE_PASS_SPEC)


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def normalise(metric: str, parsed: dict[str, Any]) -> tuple[float | None, bool]:
    """Map a judge's raw parsed output to (0-1 score, passed). None score if absent."""
    key, is_five_scale, threshold = JUDGE_PASS_SPEC[metric]
    raw = parsed.get(key)
    if raw is None:
        return None, False
    try:
        value = (float(raw) / 5.0) if is_five_scale else float(raw)
    except (TypeError, ValueError):
        return None, False
    return value, value >= threshold


async def gather_inputs(session: AsyncSession, run_id: str) -> dict[str, Any] | None:
    """Read the run's latest draft + render + persona pack + citations + gap plan.

    Returns None when the run has no draft (nothing to judge).
    """
    run = (
        await session.execute(
            text("SELECT persona, start_mode FROM content_tool.runs WHERE run_id = :r"),
            {"r": run_id},
        )
    ).first()
    if run is None:
        return None

    draft = (
        await session.execute(
            text(
                "SELECT draft_id, citation_intents FROM content_tool.drafts "
                "WHERE run_id = :r ORDER BY iteration DESC LIMIT 1"
            ),
            {"r": run_id},
        )
    ).first()
    if draft is None:
        return None

    render = (
        await session.execute(
            text("SELECT html_body FROM content_tool.renders WHERE draft_id = :d"),
            {"d": draft.draft_id},
        )
    ).first()
    persona = (
        await session.execute(
            text(
                "SELECT name, voice_rules, banned_terms, required_phrasings, "
                "tone_examples, glossary, disclaimer_templates "
                "FROM content_tool.personas WHERE slug = :p"
            ),
            {"p": run.persona},
        )
    ).first()
    citations = (
        await session.execute(
            text(
                "SELECT chunk_idx, final_url, domain, title, policy_decision, was_displayed "
                "FROM content_tool.citations WHERE draft_id = :d ORDER BY chunk_idx"
            ),
            {"d": draft.draft_id},
        )
    ).all()
    gap = (
        await session.execute(
            text("SELECT payload FROM content_tool.gap_analyses WHERE run_id = :r"),
            {"r": run_id},
        )
    ).first()

    persona_pack: dict[str, Any] = (
        {
            "name": persona.name,
            "voice_rules": persona.voice_rules,
            "banned_terms": persona.banned_terms,
            "required_phrasings": persona.required_phrasings,
            "tone_examples": persona.tone_examples,
            "glossary": persona.glossary,
            "disclaimer_templates": persona.disclaimer_templates,
        }
        if persona
        else {}
    )
    citation_rows: list[dict[str, Any]] = [
        {
            "chunk_idx": c.chunk_idx,
            "final_url": c.final_url,
            "domain": c.domain,
            "title": c.title,
            "policy_decision": c.policy_decision,
            "was_displayed": c.was_displayed,
        }
        for c in citations
    ]
    gap_payload: dict[str, Any] = (
        cast("dict[str, Any]", gap.payload) if gap and isinstance(gap.payload, dict) else {}
    )
    return {
        "start_mode": run.start_mode,
        "final_html": render.html_body if render else "",
        "persona_pack": persona_pack,
        "citation_intents": draft.citation_intents,
        "citations": citation_rows,
        "update_plan": gap_payload.get("update_plan"),
    }


def build_jobs(ctx: dict[str, Any]) -> list[tuple[str, dict[str, Any], bool]]:
    """(metric, payload, use_url_context). coverage only applies when a gap plan exists."""
    jobs: list[tuple[str, dict[str, Any], bool]] = [
        (
            "brand_voice",
            {"final_html": ctx["final_html"], "persona_pack": ctx["persona_pack"]},
            False,
        ),
        ("hk_localisation", {"final_html": ctx["final_html"]}, False),
        (
            "citation_alignment",
            {"citation_intents": ctx["citation_intents"], "citations": ctx["citations"]},
            True,
        ),
    ]
    if ctx["update_plan"]:
        jobs.append(
            (
                "coverage",
                {"update_plan": ctx["update_plan"], "final_html": ctx["final_html"]},
                False,
            )
        )
    return jobs


async def score_run(
    gemini: GeminiClient, ctx: dict[str, Any]
) -> list[tuple[str, float | None, bool, dict[str, Any]]]:
    """Run every applicable judge for one run; return (metric, score, passed, parsed) rows."""
    results: list[tuple[str, float | None, bool, dict[str, Any]]] = []
    for metric, payload, use_url in build_jobs(ctx):
        res = await run_judge(
            gemini=gemini,
            metric=metric,
            user_payload=_dump(payload),
            use_url_context=use_url,
        )
        score, passed = normalise(metric, res.parsed)
        results.append((metric, score, passed, res.parsed))
    return results
