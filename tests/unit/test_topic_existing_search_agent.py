import pytest

from content_tool.agents.topic_existing_search import (
    MAX_CANDIDATES,
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

    out = await run_existing_article_search(
        gemini=_client(grounding),
        resolve=resolve,
        input=TopicDedupInput(topic="t", keywords=["k"]),
    )

    assert [a.url for a in out] == [
        "https://www.bowtie.com.hk/blog/zh/foo",
        "https://www.bowtie.com.hk/blog/zh/bar",
    ]
    assert out[0].title == "自願醫保比較"


@pytest.mark.asyncio
async def test_filters_non_bowtie_and_unresolved():
    grounding = [_chunk("v1"), _chunk("bad"), _chunk("nores")]
    resolve = _resolver(
        {
            "v1": ResolvedUrl("v1", "https://www.bowtie.com.hk/blog/zh/foo", "bowtie.com.hk"),
            "bad": ResolvedUrl("bad", "https://example.com/x", "example.com"),
            # "nores" → unresolved (final_url None)
        }
    )

    out = await run_existing_article_search(
        gemini=_client(grounding),
        resolve=resolve,
        input=TopicDedupInput(topic="t", keywords=[]),
    )

    assert [a.url for a in out] == ["https://www.bowtie.com.hk/blog/zh/foo"]


@pytest.mark.asyncio
async def test_dedupes_by_url_ignoring_trailing_slash():
    grounding = [_chunk("v1"), _chunk("v2")]
    resolve = _resolver(
        {
            "v1": ResolvedUrl("v1", "https://www.bowtie.com.hk/blog/zh/foo", "bowtie.com.hk"),
            "v2": ResolvedUrl("v2", "https://www.bowtie.com.hk/blog/zh/foo/", "bowtie.com.hk"),
        }
    )

    out = await run_existing_article_search(
        gemini=_client(grounding),
        resolve=resolve,
        input=TopicDedupInput(topic="t", keywords=[]),
    )

    assert len(out) == 1


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

    out = await run_existing_article_search(
        gemini=_client(grounding),
        resolve=resolve,
        input=TopicDedupInput(topic="t", keywords=[]),
    )

    assert len(out) == MAX_CANDIDATES


@pytest.mark.asyncio
async def test_empty_grounding_returns_empty_and_uses_search_tool():
    client = _client([])

    out = await run_existing_article_search(
        gemini=client,
        resolve=_resolver({}),
        input=TopicDedupInput(topic="新題", keywords=["a"]),
    )

    assert out == []
    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["agent"] == "topic_existing_search"
    assert call["tools"] == ["googleSearch"]
    assert "site:bowtie.com.hk/blog" in call["user_prompt"]
    assert "topic:\n新題" in call["user_prompt"]
