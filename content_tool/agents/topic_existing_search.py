# ruff: noqa: RUF001
"""Topic existing-article retrieval agent (dedup stage 1).

A single *grounded* Gemini call that searches ``site:bowtie.com.hk/blog`` for
the candidate topic and returns the REAL article URLs found in the response's
grounding metadata — never URLs the model writes into its own text.

Why a dedicated retrieval call: with a JSON-schema verdict request the model
answers the dedup question from memory and never triggers Google Search, so its
``existing_url`` is hallucinated and the response carries zero grounding chunks.
Framing the call purely as retrieval ("search and list the articles") reliably
makes the model search, populating ``grounding_chunks`` with verifiable cited
URLs. We then resolve each ``vertexaisearch`` redirect to its final URL via the
shared :class:`UrlResolver` (same path the writer's citation pipeline uses) and
keep only ``bowtie.com.hk`` results. Stage 2 (:mod:`content_tool.agents.topic_dedup`)
picks ``existing_url`` strictly from this list.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, cast

from content_tool import prompts_store
from content_tool.agents.url_resolver import ResolvedUrl
from content_tool.gemini.client import GeminiClient
from content_tool.models.topic_batch import TopicDedupInput

# Resolves a vertexaisearch redirect URI to its final URL + apex domain. The
# graph wires :meth:`UrlResolver.resolve`; tests inject a stub. Injecting it
# keeps this agent free of DB/session/network so it stays unit-testable.
UrlResolveFn = Callable[[str], Awaitable[ResolvedUrl]]

# The bowtie blog is the only domain the existing-article check cares about.
_BOWTIE_DOMAIN = "bowtie.com.hk"
# Cap the candidate list handed to the judge: enough to cover near-duplicates,
# small enough to keep the stage-2 urlContext verification cheap.
MAX_CANDIDATES = 5
# Cap how many grounding chunks we HEAD-resolve per search. Each resolve is a
# network subrequest; on Cloudflare Workers (the prod backend) these share a
# per-invocation subrequest budget across the concurrently-analysed candidates,
# so an unbounded loop over a long, mixed grounding list can exhaust the cap and
# make every later resolve fail. Kept above MAX_CANDIDATES so a clean
# site:-scoped search (mostly bowtie hits) still fills the candidate list.
MAX_RESOLVE_ATTEMPTS = 12


@dataclass(frozen=True)
class ExistingArticle:
    """A real, grounding-sourced bowtie.com.hk/blog article candidate."""

    url: str
    title: str | None


async def build_system_prompt() -> str:
    return await prompts_store.get_assembled_standalone("topic_existing_search")


def build_user_prompt(input_: TopicDedupInput) -> str:
    keywords = ", ".join(input_.keywords) if input_.keywords else "（無）"
    return (
        "請用 googleSearch 實際搜尋 site:bowtie.com.hk/blog，找出與以下 topic "
        "最相關的現有文章，列出標題與完整 URL。\n\n"
        f"topic:\n{input_.topic}\n\n"
        f"focus_keywords:\n{keywords}\n"
    )


async def run_existing_article_search(
    *,
    gemini: GeminiClient,
    resolve: UrlResolveFn,
    input: TopicDedupInput,
) -> list[ExistingArticle]:
    """Grounded search → resolved real bowtie article URLs (deduped, capped).

    Returns an empty list when the model found no grounded bowtie article — the
    correct, non-hallucinated "nothing exists yet" signal for stage 2.
    """
    system_prompt = await build_system_prompt()
    user_prompt = build_user_prompt(input)
    result = await gemini.generate(
        agent="topic_existing_search",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=None,  # plain text — we harvest grounding, not the prose
        tools=["googleSearch"],
    )

    seen: set[str] = set()
    articles: list[ExistingArticle] = []
    attempts = 0
    for chunk in result.grounding_chunks or []:
        web = cast("dict[str, Any]", chunk.get("web") or {})
        vertex_uri = web.get("uri")
        if not isinstance(vertex_uri, str) or not vertex_uri:
            continue
        if attempts >= MAX_RESOLVE_ATTEMPTS:
            break
        attempts += 1
        resolved = await resolve(vertex_uri)
        final_url = resolved.final_url
        if not final_url or resolved.domain != _BOWTIE_DOMAIN:
            continue
        key = final_url.rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        title = web.get("title")
        articles.append(
            ExistingArticle(url=final_url, title=title if isinstance(title, str) else None)
        )
        if len(articles) >= MAX_CANDIDATES:
            break

    return articles
