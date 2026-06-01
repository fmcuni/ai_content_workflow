"""Inline article-editor agent.

Targeted, surgical edits to an already-rendered HTML article driven by reviewer
feedback — anchored ``comments`` (each tied to a highlighted span) and/or an
``notes`` overall direction. Unlike the writer, this never regenerates from the
outline / gap analysis: it takes the *existing output* and revises only what the
feedback asks for, returning the full revised HTML straight back to the editor.

The prompt strings are kept byte-for-byte identical to the TypeScript port in
``deploy/cloudflare-workers/src/agents/apply_edits.ts`` so Gemini receives the
same input across runtimes.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.api.schemas import Hitl2Comment
from content_tool.db.models import Run
from content_tool.gemini.client import GeminiClient
from content_tool.models.apply_edits import ApplyEditsOutput
from content_tool.policy.personas import load_persona

# {persona_block} is substituted with the run persona's prompt block so edits
# stay on-voice (glossary, banned terms, required HK phrasings).
SYSTEM_PROMPT = (
    "你係 Bowtie 嘅資深中文編輯。你會收到一篇【已完成】嘅 HTML 文章，"  # noqa: RUF001
    "同埋審稿人嘅修改要求。你嘅工作係**就住要求精準噉修改現有 HTML**，"  # noqa: RUF001
    "唔係由頭重寫成篇文。\n\n"
    "規則：\n"  # noqa: RUF001
    "- 只係改要求所指嘅內容；其餘段落、標題、連結、HTML 標籤同屬性"  # noqa: RUF001
    "（包括 class、id、data-* 屬性，以及 shortcode 例如 [adv_panel id=\"…\"]、"  # noqa: RUF001
    "[page_widget id=\"…\"]）必須原封不動保留。\n"  # noqa: RUF001
    "- 維持原有 HTML 結構；唔好用 markdown、code fence 或者註解包住輸出。\n"  # noqa: RUF001
    "- 針對某段 highlight 嘅 comment：搵返 anchor 文字所在嘅位置，"  # noqa: RUF001
    "按指示修改嗰一處。\n"
    "- overall note：就成篇文做整體調整，但要維持最小改動原則，"  # noqa: RUF001
    "唔好亂改無關段落。\n"
    "- 你可能會見到 <span data-comment-id=\"…\"> 包住嘅文字，嗰啲係編輯標註。"  # noqa: RUF001
    "你處理完對應嘅 comment 之後，可以將嗰個 span 拆走、淨返入面文字；"  # noqa: RUF001
    "其他未處理嘅 comment span 必須保留。\n"
    "- 維持原文嘅語氣同人格。\n\n"
    "{persona_block}\n"
    "輸出 JSON：html_body（修改後嘅完整 HTML）、"  # noqa: RUF001
    "diagnose（你做咗咩修改，一兩句總結）。"  # noqa: RUF001
)


def build_user_prompt(
    *,
    html_body: str,
    comments: list[Hitl2Comment],
    notes: str | None,
) -> str:
    """Assemble the reviewer-feedback user prompt.

    Only the sections that carry real feedback are emitted, so a comment-only or
    notes-only request stays focused.
    """
    sections: list[str] = [f"# 現有文章 HTML\n{html_body}"]
    live = [c for c in comments if c.body.strip()]
    if live:
        lines = "\n".join(
            f"- highlight：「{c.anchor_text}」\n  要求：{c.body}"  # noqa: RUF001
            for c in live
        )
        sections.append(
            "# 針對 highlight 嘅修改要求（comments）\n" + lines  # noqa: RUF001
        )
    if notes and notes.strip():
        sections.append(f"# 整體修改方向（overall note）\n{notes}")  # noqa: RUF001
    return "\n\n".join(sections) + "\n"


async def run_apply_edits(
    *,
    session: AsyncSession,
    gemini: GeminiClient,
    run: Run,
    html_body: str,
    comments: list[Hitl2Comment],
    notes: str | None,
) -> str:
    """Apply reviewer feedback to ``html_body`` and return the revised HTML.

    ``run`` is the already-loaded row (the route validates existence first), used
    only for its persona so edits stay on-voice. Raises ``pydantic.ValidationError``
    if Gemini returns a malformed payload — the route maps that to a 502.
    """
    persona = await load_persona(run.persona, session=session)
    system_prompt = SYSTEM_PROMPT.replace(
        "{persona_block}", persona.to_prompt_block(html_body)
    )
    user_prompt = build_user_prompt(html_body=html_body, comments=comments, notes=notes)

    result = await gemini.generate(
        agent="apply_edits",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=ApplyEditsOutput.model_json_schema(),
        tools=[],
    )
    out = ApplyEditsOutput.model_validate(result.parsed)
    return out.html_body
