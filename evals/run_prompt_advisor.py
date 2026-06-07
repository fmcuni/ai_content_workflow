"""CLI for the Prompt-Improvement Advisor.

Aggregates recent judge scores, attributes recurring weakness to prompts, asks
the advisor LLM for directional fixes + a revised-prompt proposal, then writes a
Markdown report and (best-effort) mirrors findings to Langfuse.

Usage::

    python -m evals.run_prompt_advisor [--limit N] [--voice slug]
        [--min-fail-rate F] [--min-samples K] [--out PATH] [--no-langfuse]

Read-only against prompts + Postgres; the only writes are the report file and
optional Langfuse scores. Runs locally (HK residential IP) where the plain
Gemini API is reachable — same constraint as ``evals/run_judges_adhoc.py``.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import UTC, datetime
from pathlib import Path

from content_tool import prompts_store
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.factory import make_gemini_client
from content_tool.observability.langfuse_client import flush_langfuse, init_langfuse
from evals.prompt_advisor import (
    MIN_FAIL_RATE,
    MIN_SAMPLES,
    aggregate_metrics,
    build_jobs,
    db_body_loader,
    emit_langfuse_findings,
    gather_eval_rows,
    load_advisor_prompt,
    run_advisor,
)
from evals.prompt_advisor_report import render_report

_DEFAULT_OUT_DIR = Path(__file__).resolve().parent / "out"


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Prompt-Improvement Advisor")
    p.add_argument("--limit", type=int, default=20, help="recent published runs to analyse")
    p.add_argument("--voice", default=None, help="restrict to one persona slug")
    p.add_argument("--min-fail-rate", type=float, default=MIN_FAIL_RATE,
                   help="weakness gate: minimum fail rate (0-1)")
    p.add_argument("--min-samples", type=int, default=MIN_SAMPLES,
                   help="weakness gate: minimum sample count")
    p.add_argument("--out", default=None,
                   help="report path (default evals/out/prompt-advisor-<date>.md)")
    p.add_argument("--no-langfuse", action="store_true", help="skip Langfuse write-back")
    return p.parse_args()


async def main() -> None:
    args = _parse_args()
    settings = get_settings()
    # Standalone scripts must init the Langfuse singleton themselves (the FastAPI
    # lifespan does it for the server). No-op + never raises when disabled.
    if not args.no_langfuse:
        init_langfuse()
    assert settings.postgres_url, "POSTGRES_URL is required to run the advisor"
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    prompts_store.configure(sf)  # advisor + prompt bodies are DB-backed
    try:
        async with sf() as session:
            rows = await gather_eval_rows(session, limit=args.limit, voice=args.voice)
        aggregates = aggregate_metrics(rows)
        jobs = await build_jobs(
            aggregates,
            db_body_loader,
            min_samples=args.min_samples,
            min_fail_rate=args.min_fail_rate,
        )
        print(f"analysed {len(rows)} eval rows → {len(jobs)} prompt(s) to advise")

        findings = []
        if jobs:
            assert settings.gemini_api_key, "GEMINI_API_KEY is required to run the advisor"
            gemini = make_gemini_client(
                api_key=settings.gemini_api_key,
                model=settings.gemini_model,
                thinking_level="low",
            )
            advisor_prompt = await load_advisor_prompt()
            findings = await run_advisor(gemini, jobs, advisor_prompt)

        if findings and not args.no_langfuse:
            emitted = emit_langfuse_findings(findings)
            print(f"emitted {emitted} Langfuse score(s)")

        generated = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
        report = render_report(
            findings,
            generated_date=generated,
            run_limit=args.limit,
            voice_filter=args.voice,
        )
        out_path = Path(args.out) if args.out else (
            _DEFAULT_OUT_DIR / f"prompt-advisor-{datetime.now(UTC):%Y-%m-%d}.md"
        )
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report, encoding="utf-8")
        print(f"wrote report → {out_path}")
    finally:
        # Flush queued Langfuse scores before the short-lived process exits,
        # else batched events are lost. No-op when disabled.
        await flush_langfuse()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
