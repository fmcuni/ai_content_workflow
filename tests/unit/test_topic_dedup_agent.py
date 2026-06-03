# ruff: noqa: RUF001, RUF003
import pytest

from content_tool.agents.topic_dedup import run_topic_dedup
from content_tool.agents.url_resolver import ResolvedUrl
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.models.topic_batch import TopicDedupInput

# Grounding chunks the retrieval (stage-1) call returns. Each web.uri is a
# vertexaisearch redirect; the injected resolver maps it to a real URL.
_GROUNDING = [
    {"web": {"uri": "vertex://1", "title": "自願醫保比較"}},
    {"web": {"uri": "vertex://2", "title": "退保須知"}},
]
_BT = "https://www.bowtie.com.hk/blog/zh"
_RESOLVED = {
    "vertex://1": ResolvedUrl("vertex://1", f"{_BT}/foo", "bowtie.com.hk"),
    "vertex://2": ResolvedUrl("vertex://2", f"{_BT}/bar", "bowtie.com.hk"),
}


async def _fake_resolve(uri: str) -> ResolvedUrl:
    return _RESOLVED.get(uri, ResolvedUrl(uri, None, None, "unresolved"))


def _client(verdict: dict, grounding=_GROUNDING) -> FakeGeminiClient:
    return FakeGeminiClient(
        canned_responses={"topic_dedup": verdict},
        canned_grounding={"topic_existing_search": grounding},
    )


@pytest.mark.asyncio
async def test_topic_dedup_returns_grounded_url():
    # The judge picks a URL that IS in the grounded candidate list.
    verdict = {
        "existing": "yes",
        "existing_note": "Bowtie blog 已有同題文章。",
        "existing_url": "https://www.bowtie.com.hk/blog/zh/foo",
    }
    client = _client(verdict)

    out = await run_topic_dedup(
        gemini=client,
        resolve=_fake_resolve,
        input=TopicDedupInput(topic="退保須知", keywords=["退保", "cash value"]),
    )

    assert out.output.existing == "yes"
    assert out.output.existing_url == "https://www.bowtie.com.hk/blog/zh/foo"
    # Stage-1 diagnostics are surfaced for persistence.
    assert out.stage1.bowtie_hits == 2
    assert out.stage1.resolve_failures == 0
    assert out.stage1.second_pass is False


@pytest.mark.asyncio
async def test_two_stage_call_shape():
    verdict = {"existing": "no", "existing_note": "未找到對應文章。", "existing_url": ""}
    client = _client(verdict)

    await run_topic_dedup(
        gemini=client,
        resolve=_fake_resolve,
        input=TopicDedupInput(topic="某新題", keywords=["a", "b"]),
    )

    # Stage 1 = grounded retrieval (googleSearch); stage 2 = judge (urlContext).
    assert len(client.calls) == 2
    search, judge = client.calls
    assert search["agent"] == "topic_existing_search"
    assert search["tools"] == ["googleSearch"]
    assert "topic:\n某新題" in search["user_prompt"]
    assert judge["agent"] == "topic_dedup"
    assert judge["tools"] == ["urlContext"]
    # The judge prompt embeds the real grounded candidate URLs.
    assert "https://www.bowtie.com.hk/blog/zh/foo" in judge["user_prompt"]
    assert "a, b" in judge["user_prompt"]


@pytest.mark.asyncio
async def test_hallucinated_url_is_blanked_and_downgraded():
    # Judge fabricates a URL NOT in the grounded list → blanked, yes→not_sure.
    verdict = {
        "existing": "yes",
        "existing_note": "聲稱有文章但 URL 是捏造的。",
        "existing_url": "https://www.bowtie.com.hk/blog/zh/HALLUCINATED",
    }
    client = _client(verdict)

    out = await run_topic_dedup(
        gemini=client,
        resolve=_fake_resolve,
        input=TopicDedupInput(topic="x", keywords=["k"]),
    )

    assert out.output.existing_url == ""
    assert out.output.existing == "not_sure"


def _judge_call(client: FakeGeminiClient) -> dict:
    return next(c for c in client.calls if c["agent"] == "topic_dedup")


@pytest.mark.asyncio
async def test_no_grounded_candidates_renders_empty_list():
    verdict = {"existing": "no", "existing_note": "搜尋不到。", "existing_url": ""}
    client = _client(verdict, grounding=[])

    out = await run_topic_dedup(
        gemini=client,
        resolve=_fake_resolve,
        input=TopicDedupInput(topic="x", keywords=[]),
    )

    # Genuine empty grounding (no resolve failures) → "no" stands untouched.
    assert out.output.existing == "no"
    assert out.stage1.grounding_empty is True
    assert out.stage1.resolve_failures == 0
    judge = _judge_call(client)
    assert "候選文章：（無，搜尋不到相關文章）" in judge["user_prompt"]
    # Empty-keywords path renders 「（無）」 in the user prompt.
    assert "focus_keywords:\n（無）" in judge["user_prompt"]


@pytest.mark.asyncio
async def test_non_bowtie_grounding_is_filtered_out():
    # A grounded chunk resolving to a non-bowtie domain must not become a candidate.
    grounding = [{"web": {"uri": "vertex://x", "title": "外站"}}]

    async def resolve(uri: str) -> ResolvedUrl:
        return ResolvedUrl(uri, "https://example.com/post", "example.com")

    verdict = {"existing": "no", "existing_note": "只有外站結果。", "existing_url": ""}
    client = _client(verdict, grounding=grounding)

    out = await run_topic_dedup(
        gemini=client,
        resolve=resolve,
        input=TopicDedupInput(topic="x", keywords=["k"]),
    )

    # Resolved cleanly to a competitor (a filter, not a failure) → "no" stands.
    assert out.output.existing == "no"
    assert "候選文章：（無，搜尋不到相關文章）" in _judge_call(client)["user_prompt"]


@pytest.mark.asyncio
async def test_no_is_downgraded_to_not_sure_when_resolves_failed():
    # Grounding returned chunks, but every resolve failed (the transient-failure
    # signature, e.g. the Workers subrequest cap). A confident "no" must not
    # silently hide a possibly-existing article.
    async def failing_resolve(uri: str) -> ResolvedUrl:
        return ResolvedUrl(uri, None, None, "Too many subrequests")

    verdict = {"existing": "no", "existing_note": "候選清單為空。", "existing_url": ""}
    client = _client(verdict, grounding=_GROUNDING)

    out = await run_topic_dedup(
        gemini=client,
        resolve=failing_resolve,
        input=TopicDedupInput(topic="兒童夏日手足口病", keywords=[]),
    )

    assert out.stage1.resolve_failures > 0
    assert out.stage1.second_pass is True  # empty first pass was retried
    assert out.output.existing == "not_sure"
    assert "請人手覆檢" in out.output.existing_note
