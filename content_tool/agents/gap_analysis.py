from datetime import date
from typing import Literal
from uuid import UUID

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool import prompts_store
from content_tool.config import Settings, get_settings
from content_tool.db.models import GapAnalysisRow, Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.gap_analysis import GapAnalysis


async def build_system_prompt(
    today: date, *, voice_slug: str = "bowtie-editor", session: AsyncSession
) -> str:
    template = await prompts_store.get_assembled(
        "gap_analysis", voice_slug=voice_slug, session=session
    )
    return template.replace("{today_date}", today.isoformat())


def build_user_prompt(
    *,
    topic: str,
    keywords: list[str],
    article_url: str,
    acf_adv_id: int,
    acf_widget_id: int,
    mode: Literal["auto", "small_refresh", "full_rewrite"],
    edit_note: str | None,
) -> str:
    route_label = (
        "Auto (follow existing logic)" if mode == "auto" else f"{mode} (override existing logic)"
    )
    en = edit_note if edit_note else "N/A"
    keywords_joined = ", ".join(keywords)
    return (
        f"topic: {topic}\n"
        f"focus_keywords: {keywords_joined}\n"
        f"existing_article: {article_url}\n"
        f"acf_adv_id: {acf_adv_id}\n"
        f"acf_widget_id: {acf_widget_id}\n"
        f"route: {route_label}\n"
        f"article_edit_note: {en}"
    )


async def run_gap_analysis(
    *,
    session: AsyncSession,
    gemini: GeminiClient,
    run_id: UUID,
    today: date,
    settings: Settings | None = None,
) -> GapAnalysis:
    settings = settings or get_settings()

    run = (
        (await session.execute(Run.__table__.select().where(Run.__table__.c.run_id == run_id)))
        .mappings()
        .one()
    )

    sys_prompt = await build_system_prompt(today, voice_slug=run["persona"], session=session)
    user_prompt = build_user_prompt(
        topic=run["topic"],
        keywords=run["keywords"],
        article_url=run["article_url"],
        acf_adv_id=run["acf_adv_id"],
        acf_widget_id=run["acf_widget_id"],
        mode=run["mode"],
        edit_note=run["edit_note"],
    )

    result = await gemini.generate(
        agent="gap_analysis",
        system_prompt=sys_prompt,
        user_prompt=user_prompt,
        response_schema=GapAnalysis.model_json_schema(),
        tools=["googleSearch", "urlContext"],
    )

    ga = GapAnalysis.model_validate(result.parsed)

    # Apply override
    if run["mode"] != "auto":
        ga = ga.model_copy(update={"chosen_route": run["mode"]})

    session.add(
        GapAnalysisRow(
            run_id=run_id,
            model=settings.gemini_model,
            thinking_level=settings.gemini_thinking_level,
            payload=ga.model_dump(),
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            thinking_tokens=result.thinking_tokens,
            latency_ms=result.latency_ms,
            raw_response=None,
        )
    )
    await session.execute(
        update(Run).where(Run.run_id == run_id).values(chosen_route=ga.chosen_route)
    )
    await session.commit()
    return ga
