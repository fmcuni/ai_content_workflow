import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.writer import WriterOutput
from content_tool.policy.personas import load_persona

_PROMPT_DIR = Path(__file__).resolve().parents[2] / "prompts"
PROMPT_PATHS = {
    "small_refresh": _PROMPT_DIR / "writer_small_refresh.md",
    "full_rewrite": _PROMPT_DIR / "writer_full_rewrite.md",
}


@dataclass
class WriterRunResult:
    iteration: int
    diagnose: str
    markup_raw: str
    citation_intents: list[dict]
    grounding_chunks: list[dict] | None
    draft_id: UUID


async def build_system_prompt(
    route: str,
    persona_name: str,
    today: date,
    *,
    session: AsyncSession,
    context_text: str | None = None,
) -> str:
    template = PROMPT_PATHS[route].read_text(encoding="utf-8")
    persona = await load_persona(persona_name, session=session)
    return template.replace(
        "{persona_block}", persona.to_prompt_block(context_text)
    ).replace("{today_date}", today.isoformat())


def build_user_prompt(
    *,
    run: Run,
    gap_analysis: dict,
    outline: dict,
    existing_markdown: str,
    refine_notes: list[dict] | None,
) -> str:
    base = (
        f"topic: {run.topic}\n"
        f"focus_keywords: {', '.join(run.keywords)}\n"
        f"existing_article_URL: {run.article_url}\n"
        f"acf_adv_id: {run.acf_adv_id}\n"
        f"acf_widget_id: {run.acf_widget_id}\n"
        f"topic_category: {run.topic_category or 'N/A'}\n\n"
        f"# outline\n{json.dumps(outline, ensure_ascii=False)}\n\n"
        f"# gap_analysis\n{json.dumps(gap_analysis, ensure_ascii=False)}\n\n"
        f"# existing_article_markdown\n{existing_markdown}\n"
    )
    if refine_notes:
        base += (
            f"\n# refine_notes（上一輪 audit 必修問題）\n"  # noqa: RUF001
            f"{json.dumps(refine_notes, ensure_ascii=False)}\n"
        )
    return base


async def run_writer(
    *,
    session: AsyncSession,
    gemini: GeminiClient,
    run_id: UUID,
    iteration: int,
    today: date,
    refine_notes: list[dict] | None,
) -> WriterRunResult:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    fa = (
        await session.execute(select(FetchedArticle).where(FetchedArticle.run_id == run_id))
    ).scalar_one()
    ga = (
        await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))
    ).scalar_one()
    o = (
        await session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))
    ).scalar_one()

    route = run.chosen_route or "small_refresh"
    writer_context = (
        f"{run.topic}\n{' '.join(run.keywords)}\n"
        f"{json.dumps(o.payload, ensure_ascii=False)}\n{fa.markdown}"
    )
    sys_prompt = await build_system_prompt(
        route, run.persona, today, session=session, context_text=writer_context
    )
    user_prompt = build_user_prompt(
        run=run,
        gap_analysis=ga.payload,
        outline=o.payload,
        existing_markdown=fa.markdown,
        refine_notes=refine_notes,
    )

    result = await gemini.generate(
        agent="writer",
        system_prompt=sys_prompt,
        user_prompt=user_prompt,
        response_schema=WriterOutput.model_json_schema(),
        tools=["googleSearch", "urlContext"],
    )
    out = WriterOutput.model_validate(result.parsed)

    draft = Draft(
        run_id=run_id,
        iteration=iteration,
        diagnose=out.diagnose,
        markup_raw=out.markup,
        citation_intents=[c.model_dump() for c in out.citation_intents],
        grounding_chunks=result.grounding_chunks,
        tokens_in=result.tokens_in,
        tokens_out=result.tokens_out,
        thinking_tokens=result.thinking_tokens,
        latency_ms=result.latency_ms,
    )
    session.add(draft)
    await session.commit()
    await session.refresh(draft)

    return WriterRunResult(
        iteration=iteration,
        diagnose=out.diagnose,
        markup_raw=out.markup,
        citation_intents=[c.model_dump() for c in out.citation_intents],
        grounding_chunks=result.grounding_chunks,
        draft_id=draft.draft_id,
    )
