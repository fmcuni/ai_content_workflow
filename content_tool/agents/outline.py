from datetime import date
from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool import prompts_store
from content_tool.db.models import FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.client import GeminiClient
from content_tool.gemini.prompt_context import PromptMeta, set_prompt_meta
from content_tool.models.outline import Outline
from content_tool.policy.personas import load_persona


async def build_system_prompt(
    today: date,
    start_mode: Literal["refresh", "create"] = "refresh",
    *,
    voice_slug: str = "bowtie-editor",
    session: AsyncSession,
) -> str:
    """Render the outline system prompt for ``voice_slug`` (the run's voice).

    ``start_mode == "create"``: slot the create-mode body into the
    ``{create_mode_block}`` placeholder so the LLM gets the create-mode brief
    *before* the refresh-mode instructions in the template.

    ``start_mode == "refresh"`` (default): the placeholder is replaced with
    an empty string and only the refresh-mode body applies — identical to
    the pre-Task-4 behaviour.

    Both the ``outline_rewrite_mode`` and ``outline_create_mode`` templates
    resolve under ``voice_slug`` (falling back to __shared__ / bundled file).
    """
    block = (
        (
            await prompts_store.get_assembled(
                "outline_create_mode", voice_slug=voice_slug, session=session
            )
        ).rstrip()
        if start_mode == "create"
        else ""
    )
    template = await prompts_store.get_assembled(
        "outline_rewrite_mode", voice_slug=voice_slug, session=session
    )
    row = await prompts_store.get_template_row(
        "outline_rewrite_mode", voice_slug=voice_slug, session=session
    )
    if row is not None:
        set_prompt_meta(PromptMeta(
            template_id=row.template_id, voice_slug=row.voice_slug, sha256=row.sha256
        ))
    # Locale/brand tokens (mirror writer.build_system_prompt). The create-mode
    # block is injected FIRST so any {output_language}/{brand_name}/{market}
    # tokens it carries are interpolated by the replaces below. HK-ZH defaults
    # equal the old literals → byte-identical for bowtie-editor.
    loc = (await load_persona(voice_slug, session=session)).locale
    return (
        template.replace("{today_date}", today.isoformat())
        .replace("{create_mode_block}", block)
        .replace("{brand_name}", loc.brand_name)
        .replace("{output_language}", loc.output_language)
        .replace("{market}", loc.market)
    )


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


def build_user_prompt_create_mode(
    *,
    topic: str,
    keywords: list[str],
    target_audience: str | None,
    acf_adv_id: int,
    acf_widget_id: int,
    edit_note: str | None = None,
) -> str:
    """Create-mode user prompt — there is no fetched article and no gap
    analysis to feed the model, just the brief from the operator (Front III)
    or the promoted topic candidate (Front II).
    """
    kw = ", ".join(keywords) if keywords else "(無)"
    audience = target_audience or "(未指定)"
    note_block = (
        f"編輯指示（最優先）：{edit_note}\n"  # noqa: RUF001
        if edit_note
        else ""
    )
    # Full-width colons are intentional — the prompt is rendered for CJK
    # readers and the model is conditioned on this style throughout the
    # prompts/ folder.
    return (
        f"主題：{topic}\n"  # noqa: RUF001
        f"關鍵字：{kw}\n"  # noqa: RUF001
        f"目標讀者：{audience}\n"  # noqa: RUF001
        f"acf_adv_id: {acf_adv_id}\n"
        f"acf_widget_id: {acf_widget_id}\n"
        f"{note_block}"
    )


async def run_outline(
    *,
    session: AsyncSession,
    gemini: GeminiClient,
    run_id: UUID,
    today: date,
) -> Outline:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    start_mode: Literal["refresh", "create"] = (
        "create" if run.start_mode == "create" else "refresh"
    )

    sys_prompt = await build_system_prompt(
        today, start_mode, voice_slug=run.persona, session=session
    )

    if start_mode == "create":
        user_prompt = build_user_prompt_create_mode(
            topic=run.topic,
            keywords=list(run.keywords or []),
            target_audience=run.target_audience,
            acf_adv_id=run.acf_adv_id,
            acf_widget_id=run.acf_widget_id,
            edit_note=run.edit_note,
        )
    else:
        fa = (
            await session.execute(select(FetchedArticle).where(FetchedArticle.run_id == run_id))
        ).scalar_one()
        ga = (
            await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))
        ).scalar_one()
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

    # Upsert so re-running the node (e.g. after a restart) refreshes the outline
    # instead of violating outlines_pkey. Preserve any prior human edits.
    payload = outline.model_dump()
    stmt = (
        pg_insert(OutlineRow)
        .values(run_id=run_id, payload=payload, edited_by_human=False)
        .on_conflict_do_update(
            index_elements=[OutlineRow.run_id],
            set_={"payload": payload},
        )
    )
    await session.execute(stmt)
    await session.commit()
    return outline
