# ruff: noqa: RUF001
"""Topic-dedup agent (two-stage).

Stage 1 (:mod:`content_tool.agents.topic_existing_search`) runs a *grounded*
search and returns the REAL ``bowtie.com.hk/blog`` article URLs from Gemini's
grounding metadata. Stage 2 (here) is the verdict call: the judge picks
``existing_url`` strictly from that real candidate list, so the field can only
ever be a verifiable URL or the empty string — never a hallucination.

No retry/backoff here — that is the topic-expansion subgraph's concern.
"""

from __future__ import annotations

from dataclasses import dataclass

from content_tool import prompts_store
from content_tool.agents.topic_existing_search import (
    ExistingArticle,
    Stage1Diagnostics,
    UrlResolveFn,
    run_existing_article_search,
)
from content_tool.gemini.client import GeminiClient
from content_tool.models.topic_batch import TopicDedupInput, TopicDedupOutput

# Appended to ``existing_note`` when stage-1 could not confirm the candidate
# list because resolves failed (so a real article may have been missed). Kept
# byte-identical to the TypeScript ``DEGRADED_NOTE_SUFFIX``.
_DEGRADED_NOTE_SUFFIX = (
    "（系統提示：檢索時連結解析失敗，未能確認是否已有文章，請人手覆檢。）"
)


@dataclass(frozen=True)
class TopicDedupResult:
    """The stage-2 verdict plus the stage-1 diagnostics that produced it."""

    output: TopicDedupOutput
    stage1: Stage1Diagnostics


async def build_system_prompt() -> str:
    return await prompts_store.get_assembled_standalone("topic_dedup")


def _render_candidates(candidates: list[ExistingArticle]) -> str:
    if not candidates:
        return "候選文章：（無，搜尋不到相關文章）"
    lines = ["候選文章（系統預先搜尋找到的真實 URL，existing_url 只可從這裡照抄其一）："]
    for i, art in enumerate(candidates, 1):
        title = art.title or "（無標題）"
        lines.append(f"{i}. {title} — {art.url}")
    return "\n".join(lines)


def build_user_prompt(input_: TopicDedupInput, candidates: list[ExistingArticle]) -> str:
    keywords = ", ".join(input_.keywords) if input_.keywords else "（無）"
    return (
        "請判斷以下單一 topic 在 site:bowtie.com.hk/blog 是否已有相同 topic 的文章。"
        "只輸出符合 schema 的 JSON。\n\n"
        f"topic:\n{input_.topic}\n\n"
        f"focus_keywords:\n{keywords}\n\n"
        f"{_render_candidates(candidates)}\n"
    )


def _constrain_to_candidates(
    output: TopicDedupOutput, candidates: list[ExistingArticle]
) -> TopicDedupOutput:
    """Force ``existing_url`` to be one of the real candidate URLs, else blank.

    Defence-in-depth against the judge fabricating or mangling a URL despite the
    prompt. Matching ignores a trailing slash; the canonical candidate URL wins.
    If blanking the URL would leave a ``yes`` verdict with no source, downgrade
    to ``not_sure`` to preserve the "no reliable URL ⇒ not yes" invariant.
    """
    by_key = {art.url.rstrip("/"): art.url for art in candidates}
    matched = by_key.get((output.existing_url or "").rstrip("/"))
    if matched is not None:
        return output.model_copy(update={"existing_url": matched})
    existing = "not_sure" if output.existing == "yes" else output.existing
    return output.model_copy(update={"existing": existing, "existing_url": ""})


def _apply_degraded_guard(
    output: TopicDedupOutput,
    candidates: list[ExistingArticle],
    diagnostics: Stage1Diagnostics,
) -> TopicDedupOutput:
    """Never report a confident "no" when stage-1 could not actually confirm.

    If the candidate list is empty *because* every resolve failed (chunks were
    returned but none resolved — the transient-failure signature, e.g. the
    Workers subrequest cap), a "no" is not trustworthy: a real, live article may
    have been missed. Downgrade it to ``not_sure`` and annotate the note so the
    operator double-checks instead of silently dropping a duplicate. A genuine
    empty grounding (``resolve_failures == 0``) is left untouched.
    """
    if (
        not candidates
        and diagnostics.resolve_failures > 0
        and output.existing == "no"
    ):
        return output.model_copy(
            update={
                "existing": "not_sure",
                "existing_note": output.existing_note + _DEGRADED_NOTE_SUFFIX,
            }
        )
    return output


async def run_topic_dedup(
    *,
    gemini: GeminiClient,
    resolve: UrlResolveFn,
    input: TopicDedupInput,
) -> TopicDedupResult:
    """Two-stage dedup verdict for one candidate.

    ``resolve`` backs the stage-1 URL resolver (vertexaisearch redirect →
    real URL, cached in ``url_resolution_cache``). Returns the verdict together
    with the stage-1 :class:`Stage1Diagnostics` (persisted for observability).
    """
    stage1 = await run_existing_article_search(
        gemini=gemini, resolve=resolve, input=input
    )
    candidates = stage1.articles

    system_prompt = await build_system_prompt()
    user_prompt = build_user_prompt(input, candidates)
    result = await gemini.generate(
        agent="topic_dedup",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=TopicDedupOutput.model_json_schema(),
        tools=["urlContext"],  # open the real candidate URLs to verify the match
    )
    output = TopicDedupOutput.model_validate(result.parsed)
    output = _constrain_to_candidates(output, candidates)
    output = _apply_degraded_guard(output, candidates, stage1.diagnostics)
    return TopicDedupResult(output=output, stage1=stage1.diagnostics)
