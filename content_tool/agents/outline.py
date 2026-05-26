from datetime import date
from pathlib import Path
from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.outline import Outline

_PROMPT_DIR = Path(__file__).resolve().parents[2] / "prompts"
PROMPT_PATH = _PROMPT_DIR / "outline.md"
# Create-mode body slotted into the ``{create_mode_block}`` placeholder when
# ``start_mode == "create"``. Sourced verbatim from the n8n reference workflow
# (``AI Content Creation - 1) Create article.json`` node ``Settings3``).
CREATE_MODE_PROMPT_PATH = _PROMPT_DIR / "outline_create_mode.md"


def build_system_prompt(today: date, start_mode: Literal["refresh", "create"] = "refresh") -> str:
    """Render the outline system prompt.

    ``start_mode == "create"``: slot the n8n Settings3 body into the
    ``{create_mode_block}`` placeholder so the LLM gets the create-mode brief
    *before* the refresh-mode instructions in the template.

    ``start_mode == "refresh"`` (default): the placeholder is replaced with
    an empty string and only the refresh-mode body applies — identical to
    the pre-Task-4 behaviour.
    """
    block = (
        CREATE_MODE_PROMPT_PATH.read_text(encoding="utf-8").rstrip()
        if start_mode == "create"
        else ""
    )
    return (
        PROMPT_PATH.read_text(encoding="utf-8")
        .replace("{today_date}", today.isoformat())
        .replace("{create_mode_block}", block)
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
) -> str:
    """Create-mode user prompt — there is no fetched article and no gap
    analysis to feed the model, just the brief from the operator (Front III)
    or the promoted topic candidate (Front II).
    """
    kw = ", ".join(keywords) if keywords else "(無)"
    audience = target_audience or "(未指定)"
    # Full-width colons are intentional — the prompt is rendered for CJK
    # readers and the model is conditioned on this style throughout the
    # prompts/ folder.
    return (
        f"主題：{topic}\n"  # noqa: RUF001
        f"關鍵字：{kw}\n"  # noqa: RUF001
        f"目標讀者：{audience}\n"  # noqa: RUF001
        f"acf_adv_id: {acf_adv_id}\n"
        f"acf_widget_id: {acf_widget_id}\n"
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

    sys_prompt = build_system_prompt(today, start_mode)

    if start_mode == "create":
        user_prompt = build_user_prompt_create_mode(
            topic=run.topic,
            keywords=list(run.keywords or []),
            target_audience=run.target_audience,
            acf_adv_id=run.acf_adv_id,
            acf_widget_id=run.acf_widget_id,
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

    session.add(OutlineRow(run_id=run_id, payload=outline.model_dump(), edited_by_human=False))
    await session.commit()
    return outline
