from datetime import date
from pathlib import Path
from typing import Literal

PROMPT_PATH = Path("prompts/gap_analysis.md")


def build_system_prompt(today: date) -> str:
    template = PROMPT_PATH.read_text(encoding="utf-8")
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
