import pytest

from content_tool.agents.topic_existing_search import (
    MAX_CANDIDATES,
    MAX_RESOLVE_ATTEMPTS,
    run_existing_article_search,
)
from content_tool.agents.url_resolver import ResolvedUrl
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.models.topic_batch import TopicDedupInput


def _chunk(uri: str, title: str | None = None) -> dict:
    return {"web": {"uri": uri, "title": title}}


def _client(grounding: list[dict]) -> FakeGeminiClient:
    return FakeGeminiClient(
        canned_responses={},
        canned_grounding={"topic_existing_search": grounding},
    )


def _resolver(mapping: dict[str, ResolvedUrl]):
    async def resolve(uri: str) -> ResolvedUrl:
        return mapping.get(uri, ResolvedUrl(uri, None, None, "unresolved"))

    return resolve


@pytest.mark.asyncio
async def test_returns_resolved_bowtie_articles_with_titles():
    grounding = [_chunk("v1", "自願醫保比較"), _chunk("v2", "退保")]
    resolve = _resolver(
        {
            "v1": ResolvedUrl("v1", "https://www.bowtie.com.hk/blog/zh/foo", "bowtie.com.hk"),
            "v2": ResolvedUrl("v2", "https://www.bowtie.com.hk/blog/zh/bar", "bowtie.com.hk"),
        }
    )

    client = _client(grounding)
    result = await run_existing_article_search(
        gemini=client,
        resolve=resolve,
        input=TopicDedupInput(topic="t", keywords=["k"]),
    )

    assert [a.url for a in result.articles] == [
        "https://www.bowtie.com.hk/blog/zh/foo",
        "https://www.bowtie.com.hk/blog/zh/bar",
    ]
    assert result.articles[0].title == "自願醫保比較"
    # Non-empty first pass → no retry, clean diagnostics.
    assert len(client.calls) == 1
    assert result.diagnostics.grounding_chunks == 2
    assert result.diagnostics.bowtie_hits == 2
    assert result.diagnostics.resolve_failures == 0
    assert result.diagnostics.second_pass is False
    assert result.diagnostics.grounding_empty is False


@pytest.mark.asyncio
async def test_filters_non_bowtie_and_counts_unresolved_as_failures():
    grounding = [_chunk("v1"), _chunk("bad"), _chunk("nores")]
    resolve = _resolver(
        {
            "v1": ResolvedUrl("v1", "https://www.bowtie.com.hk/blog/zh/foo", "bowtie.com.hk"),
            "bad": ResolvedUrl("bad", "https://example.com/x", "example.com"),
            # "nores" → unresolved (final_url None) — a resolve failure
        }
    )

    result = await run_existing_article_search(
        gemini=_client(grounding),
        resolve=resolve,
        input=TopicDedupInput(topic="t", keywords=[]),
    )

    assert [a.url for a in result.articles] == ["https://www.bowtie.com.hk/blog/zh/foo"]
    assert result.diagnostics.filtered_out == 1  # example.com resolved but not bowtie
    assert result.diagnostics.resolve_failures == 1  # "nores" never resolved


@pytest.mark.asyncio
async def test_dedupes_by_url_ignoring_trailing_slash():
    grounding = [_chunk("v1"), _chunk("v2")]
    resolve = _resolver(
        {
            "v1": ResolvedUrl("v1", "https://www.bowtie.com.hk/blog/zh/foo", "bowtie.com.hk"),
            "v2": ResolvedUrl("v2", "https://www.bowtie.com.hk/blog/zh/foo/", "bowtie.com.hk"),
        }
    )

    result = await run_existing_article_search(
        gemini=_client(grounding),
        resolve=resolve,
        input=TopicDedupInput(topic="t", keywords=[]),
    )

    assert len(result.articles) == 1


@pytest.mark.asyncio
async def test_caps_at_max_candidates():
    grounding = [_chunk(f"v{i}") for i in range(MAX_CANDIDATES + 3)]
    resolve = _resolver(
        {
            f"v{i}": ResolvedUrl(
                f"v{i}", f"https://www.bowtie.com.hk/blog/zh/p{i}", "bowtie.com.hk"
            )
            for i in range(MAX_CANDIDATES + 3)
        }
    )

    result = await run_existing_article_search(
        gemini=_client(grounding),
        resolve=resolve,
        input=TopicDedupInput(topic="t", keywords=[]),
    )

    assert len(result.articles) == MAX_CANDIDATES


@pytest.mark.asyncio
async def test_caps_resolve_attempts_per_pass_and_retries_once():
    """Bounds HEAD subrequests per search: a long grounding list of non-bowtie
    chunks must not trigger an unbounded resolve loop, which on Cloudflare Workers
    would exhaust the per-invocation subrequest budget shared across candidates.
    We resolve at most MAX_RESOLVE_ATTEMPTS chunks per pass; an empty result is
    retried once, so total resolves are bounded at 2 * MAX_RESOLVE_ATTEMPTS."""
    grounding = [_chunk(f"v{i}") for i in range(MAX_RESOLVE_ATTEMPTS + 10)]
    calls = 0

    async def resolve(uri: str) -> ResolvedUrl:
        nonlocal calls
        calls += 1
        return ResolvedUrl(uri, "https://example.com/x", "example.com")

    result = await run_existing_article_search(
        gemini=_client(grounding),
        resolve=resolve,
        input=TopicDedupInput(topic="t", keywords=[]),
    )

    assert result.articles == []
    assert calls == MAX_RESOLVE_ATTEMPTS * 2
    assert result.diagnostics.attempt_cap_hit is True
    assert result.diagnostics.second_pass is True
    assert result.diagnostics.filtered_out == MAX_RESOLVE_ATTEMPTS


@pytest.mark.asyncio
async def test_empty_grounding_returns_empty_and_retries():
    client = _client([])

    result = await run_existing_article_search(
        gemini=client,
        resolve=_resolver({}),
        input=TopicDedupInput(topic="新題", keywords=["a"]),
    )

    assert result.articles == []
    assert result.diagnostics.grounding_empty is True
    assert result.diagnostics.second_pass is True
    assert len(client.calls) == 2  # first pass empty → one retry
    call = client.calls[0]
    assert call["agent"] == "topic_existing_search"
    assert call["tools"] == ["googleSearch"]
    assert "site:bowtie.com.hk/blog" in call["user_prompt"]
    assert "topic:\n新題" in call["user_prompt"]


@pytest.mark.asyncio
async def test_recovers_via_retry_on_transient_resolve_failure():
    """The first pass's resolves fail (transient, e.g. the Workers subrequest
    cap); the retry succeeds and the real bowtie article is found."""
    grounding = [_chunk("v1", "手足口病")]
    seen: set[str] = set()

    async def resolve(uri: str) -> ResolvedUrl:
        if uri not in seen:
            seen.add(uri)
            return ResolvedUrl(uri, None, None, "Too many subrequests")
        return ResolvedUrl(uri, "https://www.bowtie.com.hk/blog/zh/hfmd", "bowtie.com.hk")

    client = _client(grounding)
    result = await run_existing_article_search(
        gemini=client,
        resolve=resolve,
        input=TopicDedupInput(topic="兒童夏日手足口病", keywords=[]),
    )

    assert [a.url for a in result.articles] == ["https://www.bowtie.com.hk/blog/zh/hfmd"]
    assert result.diagnostics.second_pass is True
    assert result.diagnostics.bowtie_hits == 1
    assert len(client.calls) == 2
