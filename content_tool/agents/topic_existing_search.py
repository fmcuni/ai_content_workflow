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


@dataclass(frozen=True)
class Stage1Diagnostics:
    """Why stage-1 produced the candidate list it did.

    Built purely from local loop counters (zero extra subrequests) and persisted
    per candidate so an empty-candidate "no" verdict is explainable after the
    fact. ``resolve_failures > 0`` with an empty list is the smoking gun for a
    transient resolve failure (e.g. the Workers subrequest cap) rather than a
    genuine "no such article" — see :func:`content_tool.agents.topic_dedup`.

    Field names are snake_case and MUST stay byte-identical to the TypeScript
    ``Stage1Diagnostics`` so the persisted ``existing_search_debug`` row shape is
    shared across both backends.
    """

    grounding_chunks: int
    resolve_attempts: int
    resolved_count: int
    bowtie_hits: int
    filtered_out: int
    resolve_failures: int
    attempt_cap_hit: bool
    grounding_empty: bool
    second_pass: bool


@dataclass(frozen=True)
class Stage1Result:
    """The stage-1 candidate list plus the diagnostics explaining it."""

    articles: list[ExistingArticle]
    diagnostics: Stage1Diagnostics


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


async def _search_once(
    *,
    gemini: GeminiClient,
    resolve: UrlResolveFn,
    system_prompt: str,
    user_prompt: str,
    second_pass: bool,
) -> Stage1Result:
    """One grounded search pass: grounding chunks → resolved bowtie articles.

    Records a :class:`Stage1Diagnostics` from local counters so the caller can
    tell a genuine "nothing found" apart from a resolve failure.
    """
    result = await gemini.generate(
        agent="topic_existing_search",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response_schema=None,  # plain text — we harvest grounding, not the prose
        tools=["googleSearch"],
    )

    chunks = result.grounding_chunks or []
    seen: set[str] = set()
    articles: list[ExistingArticle] = []
    attempts = 0
    resolved_count = 0
    bowtie_hits = 0
    filtered_out = 0
    resolve_failures = 0
    attempt_cap_hit = False
    for chunk in chunks:
        web = cast("dict[str, Any]", chunk.get("web") or {})
        vertex_uri = web.get("uri")
        if not isinstance(vertex_uri, str) or not vertex_uri:
            continue
        if attempts >= MAX_RESOLVE_ATTEMPTS:
            attempt_cap_hit = True
            break
        attempts += 1
        resolved = await resolve(vertex_uri)
        final_url = resolved.final_url
        # A resolve that yielded no final URL is a *failure* (HEAD timeout,
        # network blip, or the Workers subrequest cap) — distinct from a
        # successful resolve to a non-bowtie competitor domain, which is a filter.
        if not final_url:
            resolve_failures += 1
            continue
        resolved_count += 1
        if resolved.domain != _BOWTIE_DOMAIN:
            filtered_out += 1
            continue
        bowtie_hits += 1
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

    diagnostics = Stage1Diagnostics(
        grounding_chunks=len(chunks),
        resolve_attempts=attempts,
        resolved_count=resolved_count,
        bowtie_hits=bowtie_hits,
        filtered_out=filtered_out,
        resolve_failures=resolve_failures,
        attempt_cap_hit=attempt_cap_hit,
        grounding_empty=len(chunks) == 0,
        second_pass=second_pass,
    )
    return Stage1Result(articles=articles, diagnostics=diagnostics)


async def run_existing_article_search(
    *,
    gemini: GeminiClient,
    resolve: UrlResolveFn,
    input: TopicDedupInput,
) -> Stage1Result:
    """Grounded search → resolved real bowtie article URLs (deduped, capped).

    Returns an empty article list when the model found no grounded bowtie
    article — the correct, non-hallucinated "nothing exists yet" signal for
    stage 2.

    An empty first pass is RETRIED once. The grounded search is reliable in
    isolation (it returns the real bowtie article for these topics); an empty
    result almost always means a transient in-run failure — the search tool
    returned no chunks, or every resolve failed under the Workers per-invocation
    subrequest budget while several candidates were analysed concurrently. A
    single retry recovers those without doubling cost on the common (non-empty)
    path. The decisive (second) pass's diagnostics are returned, flagged
    ``second_pass=True``.
    """
    system_prompt = await build_system_prompt()
    user_prompt = build_user_prompt(input)

    first = await _search_once(
        gemini=gemini,
        resolve=resolve,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        second_pass=False,
    )
    if first.articles:
        return first

    return await _search_once(
        gemini=gemini,
        resolve=resolve,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        second_pass=True,
    )
