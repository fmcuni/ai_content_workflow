"""Ad-hoc LLM-judge runner: score one run's published draft with real Gemini.

Read-only — prints each judge's normalised score + raw parsed JSON. Does NOT
write to the evals table (use the nightly runner for that). Shares all input
gathering + scoring with the nightly runner via evals.judges.

Usage:
    python -m evals.run_judges_adhoc <run_id>

Runs locally (HK residential IP) where the plain Gemini API is reachable — the
geo-block only affects the Cloudflare datacenter, which is why the Worker uses a
US-pinned proxy DO.
"""

import asyncio
import json
import sys

from content_tool import prompts_store
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.factory import make_gemini_client
from evals.judges import gather_inputs, score_run


async def main(run_id: str) -> None:
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    prompts_store.configure(sf)  # judge prompts are DB-backed
    try:
        async with sf() as session:
            ctx = await gather_inputs(session, run_id)
        if ctx is None:
            raise SystemExit(f"run {run_id} not found or has no draft")

        assert settings.gemini_api_key, "GEMINI_API_KEY is required to run the judges"
        gemini = make_gemini_client(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            thinking_level="low",
        )
        print(f"\n=== run {run_id} (start_mode={ctx['start_mode']}) ===")
        for metric, score, passed, parsed in await score_run(gemini, ctx):
            raw = json.dumps(parsed, ensure_ascii=False, default=str)
            print(f"{metric}: score={score} pass={passed} {raw}")
        if not ctx["update_plan"]:
            print("coverage: SKIPPED (create-mode run has no gap_analysis.update_plan)")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m evals.run_judges_adhoc <run_id>")
    asyncio.run(main(sys.argv[1]))
