from datetime import date
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.outline import Outline

PROMPT_PATH = Path(__file__).resolve().parents[2] / "prompts" / "outline.md"


def build_system_prompt(today: date) -> str:
    return PROMPT_PATH.read_text(encoding="utf-8").replace("{today_date}", today.isoformat())


def build_user_prompt(
    *,
    gap_analysis_payload: dict,
    existing_markdown: str,
    chosen_route: str,
    acf_adv_id: int,
    acf_widget_id: int,
) -> str:
    import json as _j

    return (
        f"chosen_route: {chosen_route}\n"
        f"acf_adv_id: {acf_adv_id}\n"
        f"acf_widget_id: {acf_widget_id}\n\n"
        f"# gap_analysis\n{_j.dumps(gap_analysis_payload, ensure_ascii=False)}\n\n"
        f"# existing_article_markdown\n{existing_markdown}"
    )


async def run_outline(
    *,
    session: AsyncSession,
    gemini: GeminiClient,
    run_id: UUID,
    today: date,
) -> Outline:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    fa = (
        await session.execute(select(FetchedArticle).where(FetchedArticle.run_id == run_id))
    ).scalar_one()
    ga = (
        await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))
    ).scalar_one()

    sys_prompt = build_system_prompt(today)
    user_prompt = build_user_prompt(
        gap_analysis_payload=ga.payload,
        existing_markdown=fa.markdown,
        chosen_route=run.chosen_route or "small_refresh",
        acf_adv_id=run.acf_adv_id,
        acf_widget_id=run.acf_widget_id,
    )

    result = await gemini.generate(
        agent="outline",
        system_prompt=sys_prompt,
        user_prompt=user_prompt,
        response_schema=Outline.model_json_schema(),
        tools=[],
    )
    outline = Outline.model_validate(result.parsed)

    session.add(OutlineRow(run_id=run_id, payload=outline.model_dump(), edited_by_human=False))
    await session.commit()
    return outline
