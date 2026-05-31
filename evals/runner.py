import asyncio
import subprocess
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.db.models import Eval

# Judge only the most-recent N published runs per nightly run, and skip runs that
# already have judge scores — bounds the recurring Gemini cost.
JUDGE_RUN_LIMIT = 5


def current_commit_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()  # noqa: S607
    except Exception:
        return "unknown"


async def record_eval(
    sf: async_sessionmaker,  # type: ignore[type-arg]
    *,
    metric: str,
    fixture_id: str,
    score: float | None,
    passed: bool,
    judge_notes: dict[str, object] | None = None,
    run_id: UUID | None = None,
) -> None:
    sha = current_commit_sha()
    async with sf() as session:
        session.add(Eval(
            eval_id=uuid4(), metric=metric, fixture_id=fixture_id, run_id=run_id,
            score=score, pass_=passed, judge_notes=judge_notes, commit_sha=sha,
        ))
        await session.commit()


async def main() -> None:
    """Run reference + LLM-judge evals against recent published runs; emit to content_tool.evals."""
    from sqlalchemy import select

    from content_tool import prompts_store
    from content_tool.config import get_settings
    from content_tool.db.connection import make_engine, make_session_factory
    from content_tool.db.models import Citation, Draft, Run
    from content_tool.gemini.client import RealGeminiClient
    from evals.judges import JUDGE_METRICS, gather_inputs, score_run

    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    prompts_store.configure(sf)  # judge prompts are DB-backed

    async with sf() as session:
        runs = (await session.execute(
            select(Run).where(Run.status == "published").order_by(Run.created_at.desc()).limit(30)
        )).scalars().all()

        for r in runs:
            # Citation allow-list compliance
            drafts = (await session.execute(
                select(Draft).where(Draft.run_id == r.run_id)
            )).scalars().all()
            if not drafts:
                continue
            latest = max(drafts, key=lambda d: d.iteration)
            citations = (await session.execute(
                select(Citation).where(Citation.draft_id == latest.draft_id)
            )).scalars().all()
            denied_displayed = any(
                c.was_displayed and c.policy_decision == "denied" for c in citations
            )
            await record_eval(sf, metric="citation_policy_compliance",
                              fixture_id=str(r.run_id), score=0.0 if denied_displayed else 1.0,
                              passed=not denied_displayed, run_id=r.run_id)

            # Refine-loop convergence (passed if iteration_count <= 1 → converged in ≤2 drafts)
            converged = (r.iteration_count or 0) <= 1
            await record_eval(sf, metric="refine_loop_convergence",
                              fixture_id=str(r.run_id), score=1.0 if converged else 0.0,
                              passed=converged, run_id=r.run_id)

    # LLM-judge pass — bounded to the most recent runs, skipping already-judged ones.
    assert settings.gemini_api_key, "GEMINI_API_KEY is required for the LLM-judge pass"
    gemini = RealGeminiClient(
        api_key=settings.gemini_api_key, model=settings.gemini_model, thinking_level="low"
    )
    for r in runs[:JUDGE_RUN_LIMIT]:
        ctx: dict[str, Any] | None = None
        async with sf() as session:
            already = (await session.execute(
                select(Eval.eval_id)
                .where(Eval.run_id == r.run_id, Eval.metric.in_(JUDGE_METRICS))
                .limit(1)
            )).first()
            if already is not None:
                continue
            ctx = await gather_inputs(session, str(r.run_id))
        if ctx is None:
            continue
        for metric, score, passed, notes in await score_run(gemini, ctx):
            await record_eval(sf, metric=metric, fixture_id=str(r.run_id),
                              score=score, passed=passed, judge_notes=notes, run_id=r.run_id)

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
