"""Ad-hoc LLM-judge runner: score one run's published draft with real Gemini.

Read-only — assembles each judge's expected inputs from the DB, calls
evals.judge_runner.run_judge for the four judge metrics, and prints the parsed
JSON. Does NOT write to the evals table.

Usage:
    python -m evals.run_judges_adhoc <run_id>

Runs locally (HK residential IP) where the plain Gemini API is reachable — the
geo-block only affects the Cloudflare datacenter, which is why the Worker uses a
US-pinned proxy DO.
"""

import asyncio
import json
import sys
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from content_tool import prompts_store
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.client import RealGeminiClient
from evals.judge_runner import run_judge


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


async def _gather(engine: AsyncEngine, run_id: str) -> dict[str, Any]:
    """Read the run's latest draft + render + persona pack + citations + gap plan."""
    async with engine.connect() as conn:
        run = (
            await conn.execute(
                text("SELECT persona, start_mode FROM content_tool.runs WHERE run_id = :r"),
                {"r": run_id},
            )
        ).first()
        if run is None:
            raise SystemExit(f"run {run_id} not found")

        draft = (
            await conn.execute(
                text(
                    "SELECT draft_id, iteration, citation_intents "
                    "FROM content_tool.drafts WHERE run_id = :r "
                    "ORDER BY iteration DESC LIMIT 1"
                ),
                {"r": run_id},
            )
        ).first()
        if draft is None:
            raise SystemExit(f"run {run_id} has no drafts")

        render = (
            await conn.execute(
                text(
                    "SELECT html_body, seo_title, meta_description "
                    "FROM content_tool.renders WHERE draft_id = :d"
                ),
                {"d": draft.draft_id},
            )
        ).first()

        persona = (
            await conn.execute(
                text(
                    "SELECT name, voice_rules, banned_terms, required_phrasings, "
                    "tone_examples, glossary, disclaimer_templates "
                    "FROM content_tool.personas WHERE slug = :p"
                ),
                {"p": run.persona},
            )
        ).first()

        citations = (
            await conn.execute(
                text(
                    "SELECT chunk_idx, final_url, domain, title, policy_decision, was_displayed "
                    "FROM content_tool.citations WHERE draft_id = :d ORDER BY chunk_idx"
                ),
                {"d": draft.draft_id},
            )
        ).all()

        gap = (
            await conn.execute(
                text("SELECT payload FROM content_tool.gap_analyses WHERE run_id = :r"),
                {"r": run_id},
            )
        ).first()

    final_html = render.html_body if render else ""
    persona_pack = (
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
    update_plan = (gap.payload or {}).get("update_plan") if gap else None
    return {
        "start_mode": run.start_mode,
        "final_html": final_html,
        "persona_pack": persona_pack,
        "citation_intents": draft.citation_intents,
        "citations": [dict(c._mapping) for c in citations],
        "update_plan": update_plan,
    }


async def main(run_id: str) -> None:
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    # The judge prompts are DB-backed; the prompt store must be configured with a
    # live session factory before run_judge can assemble them.
    prompts_store.configure(make_session_factory(engine))
    try:
        ctx = await _gather(engine, run_id)
        gemini = RealGeminiClient(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            thinking_level="low",
        )

        # (metric, payload, use_url_context). coverage only applies to refresh
        # runs (needs gap_analysis.update_plan); skip it when there is none.
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

        print(f"\n=== run {run_id} (start_mode={ctx['start_mode']}) ===")
        for metric, payload, use_url in jobs:
            try:
                res = await run_judge(
                    gemini=gemini,
                    metric=metric,
                    user_payload=_dump(payload),
                    use_url_context=use_url,
                )
                print(f"{metric}: {_dump(res.parsed)}")
            except Exception as exc:  # ad-hoc tool: report and keep going
                print(f"{metric}: ERROR {type(exc).__name__}: {exc}")
        if not ctx["update_plan"]:
            print("coverage: SKIPPED (create-mode run has no gap_analysis.update_plan)")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m evals.run_judges_adhoc <run_id>")
    asyncio.run(main(sys.argv[1]))
