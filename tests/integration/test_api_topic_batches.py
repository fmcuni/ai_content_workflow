"""Integration tests for the topic-batches HTTP surface (Task 5).

Covers the full lifecycle endpoints in
``content_tool/api/routes/topic_batches.py``: create + SSE event, PATCH
candidate, mixed-mode promote, atomic 422 on blank refresh URL, 409 on
failed batch, skip, and close.

The background topic-expansion graph is exercised indirectly through a
stubbed Gemini for the create-with-SSE test; everything else seeds rows
directly so we test the API layer in isolation and don't depend on
LangGraph timing.
"""

from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from content_tool.api.main import create_app
from content_tool.db.models import Run, TopicBatch, TopicCandidate
from content_tool.gemini.fake import FakeGeminiClient


class _StubRunExecutor:
    """Captures ``start(run_id)`` calls so we can assert on dispatch without
    actually compiling/running the LangGraph root graph."""

    def __init__(self) -> None:
        self.started: list[UUID] = []

    async def start(self, run_id: UUID) -> None:
        self.started.append(run_id)


@pytest_asyncio.fixture
async def api_client_with_stub_runner(pg_session_factory):
    """API client with session_factory wired and a stub run-executor.

    Most tests don't need the real ``RunExecutor`` — the stub records
    promote-time ``start()`` calls so we can assert dispatch without
    spinning up LangGraph.
    """
    app = create_app()
    app.state.session_factory = pg_session_factory
    app.state.run_executor = _StubRunExecutor()
    app.state.gemini_client = FakeGeminiClient(canned_responses={})
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac, app


async def _seed_batch_with_candidates(
    sf,
    *,
    status: str = "ready_for_review",
    candidate_count: int = 2,
    existing_verdicts: list[str] | None = None,
    hot_verdicts: list[str] | None = None,
    existing_urls: list[str] | None = None,
) -> tuple[UUID, list[UUID]]:
    """Insert a batch + ``candidate_count`` analysed candidates."""
    existing_verdicts = existing_verdicts or ["no"] * candidate_count
    hot_verdicts = hot_verdicts or ["yes"] * candidate_count
    existing_urls = existing_urls or [""] * candidate_count
    async with sf() as session:
        batch = TopicBatch(
            created_by="t@bowtie",
            status=status,
            research_theme="保險新手",
            target_audience="香港 25-35",
            topic_count=candidate_count,
            keywords_per_topic=2,
            must_cover=[],
            must_avoid=[],
            persona_default="bowtie-editor",
            acf_adv_id_default=11,
            acf_widget_id_default=22,
        )
        session.add(batch)
        await session.flush()
        bid = batch.batch_id
        cand_ids: list[UUID] = []
        for i in range(candidate_count):
            cand = TopicCandidate(
                batch_id=bid,
                position=i,
                status="candidate",
                topic=f"topic-{i}",
                keywords=[f"kw-{i}-a", f"kw-{i}-b"],
                original_topic=f"topic-{i}",
                original_keywords=[f"kw-{i}-a", f"kw-{i}-b"],
                existing=existing_verdicts[i],
                existing_note="note",
                existing_url=existing_urls[i],
                hot_topic=hot_verdicts[i],
                hot_topic_note="note",
            )
            session.add(cand)
            await session.flush()
            cand_ids.append(cand.candidate_id)
        await session.commit()
    return bid, cand_ids


@pytest.mark.asyncio
async def test_create_topic_batch_persists_and_returns_pending(
    api_client_with_stub_runner,
    pg_session_factory,
):
    ac, _ = api_client_with_stub_runner
    payload = {
        "research_theme": "保險新手",
        "target_audience": "香港 25-35 歲首次買保險的上班族",
        "topic_count": 2,
        "keywords_per_topic": 2,
        "must_cover": ["VHIS"],
        "must_avoid": [],
        "editor_email": "editor@bowtie",
    }
    resp = await ac.post("/topic-batches", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "pending"
    bid = UUID(body["batch_id"])

    async with pg_session_factory() as session:
        row = (
            await session.execute(select(TopicBatch).where(TopicBatch.batch_id == bid))
        ).scalar_one()
        assert row.research_theme == "保險新手"
        assert row.must_cover == ["VHIS"]
        assert row.created_by == "editor@bowtie"


@pytest.mark.asyncio
async def test_topic_batch_executor_multicasts_events_to_subscribers(
    pg_session_factory,
):
    """Verifies the per-batch SSE pipe: events emitted into the executor
    are replayed to a late subscriber via the in-memory history buffer and
    forwarded live to existing subscribers.

    Driving the real LangGraph subgraph via HTTP-streamed SSE was flaky
    under ``ASGITransport`` (response-body buffering); the end-to-end path
    is already covered by ``test_topic_expansion_graph.py``, so here we
    focus on the multicast contract.
    """
    from content_tool.api.routes.topic_batches import TopicBatchExecutor

    bid = uuid4()
    executor = TopicBatchExecutor(
        postgres_url="postgresql://unused",
        session_factory=pg_session_factory,
        gemini=FakeGeminiClient(canned_responses={}),
    )

    # Late subscriber: emit two events first, then subscribe and expect to
    # receive both via the history replay.
    await executor._emit(bid, "topic_gen.done", {})
    await executor._emit(bid, "graph.completed", {})
    late_q = executor.subscribe(bid)
    replayed: list[str] = []
    for _ in range(2):
        replayed.append(await asyncio.wait_for(late_q.get(), timeout=1.0))
    assert any('"event": "topic_gen.done"' in e for e in replayed), replayed
    assert any('"event": "graph.completed"' in e for e in replayed), replayed

    # Live subscriber: an event emitted AFTER subscribing must arrive on
    # the queue.
    live_q = executor.subscribe(bid)
    # Drain the replayed history first.
    for _ in range(2):
        await asyncio.wait_for(live_q.get(), timeout=1.0)
    await executor._emit(bid, "analyse_candidate.done", {})
    live_evt = await asyncio.wait_for(live_q.get(), timeout=1.0)
    assert '"event": "analyse_candidate.done"' in live_evt


@pytest.mark.asyncio
async def test_patch_candidate_updates_fields_and_stamps_editor(
    api_client_with_stub_runner,
    pg_session_factory,
):
    ac, _ = api_client_with_stub_runner
    bid, cand_ids = await _seed_batch_with_candidates(pg_session_factory)
    cid = cand_ids[0]
    resp = await ac.patch(
        f"/topic-batches/{bid}/candidates/{cid}",
        json={
            "topic": "rewritten topic",
            "keywords": ["new", "kw"],
            "persona_slug": "bowtie-editor",
            "editor_email": "editor@bowtie",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["topic"] == "rewritten topic"
    assert body["keywords"] == ["new", "kw"]
    assert body["last_edited_by"] == "editor@bowtie"
    assert body["last_edited_at"] is not None
    assert body["original_topic"] == "topic-0"


@pytest.mark.asyncio
async def test_promote_dispatches_mixed_modes_and_updates_candidates(
    api_client_with_stub_runner,
    pg_session_factory,
):
    ac, app = api_client_with_stub_runner
    bid, cand_ids = await _seed_batch_with_candidates(
        pg_session_factory,
        candidate_count=2,
        existing_verdicts=["no", "yes"],
        hot_verdicts=["yes", "yes"],
        existing_urls=["", "https://wp.bowtie.test/existing/"],
    )
    resp = await ac.post(
        f"/topic-batches/{bid}/promote",
        json={
            "promotions": [
                {"candidate_id": str(cand_ids[0]), "mode": "create"},
                {"candidate_id": str(cand_ids[1]), "mode": "refresh"},
            ],
            "editor_email": "editor@bowtie",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["items"]) == 2
    assert body["batch_status"] == "done"

    modes = sorted(item["mode"] for item in body["items"])
    assert modes == ["create", "refresh"]

    runner: _StubRunExecutor = app.state.run_executor
    started_ids = {str(rid) for rid in runner.started}
    response_run_ids = {item["run_id"] for item in body["items"]}
    assert started_ids == response_run_ids

    async with pg_session_factory() as session:
        runs = (
            await session.execute(
                select(Run).where(Run.topic_candidate_id.in_(cand_ids))
            )
        ).scalars().all()
        assert len(runs) == 2
        by_mode = {r.start_mode: r for r in runs}
        assert by_mode["create"].article_url is None
        assert by_mode["refresh"].article_url == "https://wp.bowtie.test/existing/"
        assert all(r.target_audience == "香港 25-35" for r in runs)
        assert all(r.persona == "bowtie-editor" for r in runs)
        assert by_mode["create"].acf_adv_id == 11
        assert by_mode["create"].acf_widget_id == 22

        cands = (
            await session.execute(
                select(TopicCandidate).where(TopicCandidate.batch_id == bid)
            )
        ).scalars().all()
        assert all(c.status == "promoted" for c in cands)
        assert {c.promote_mode for c in cands} == {"create", "refresh"}


@pytest.mark.asyncio
async def test_promote_atomic_422_on_blank_refresh_url(
    api_client_with_stub_runner,
    pg_session_factory,
):
    """When one refresh promotion has no existing_url the whole request
    must be rejected — no runs created, no candidates updated."""
    ac, app = api_client_with_stub_runner
    bid, cand_ids = await _seed_batch_with_candidates(
        pg_session_factory,
        candidate_count=2,
        existing_verdicts=["no", "yes"],
        hot_verdicts=["yes", "yes"],
        existing_urls=["", ""],
    )
    resp = await ac.post(
        f"/topic-batches/{bid}/promote",
        json={
            "promotions": [
                {"candidate_id": str(cand_ids[0]), "mode": "create"},
                {"candidate_id": str(cand_ids[1]), "mode": "refresh"},
            ],
            "editor_email": "editor@bowtie",
        },
    )
    assert resp.status_code == 422, resp.text
    assert "existing_url is blank" in resp.json()["detail"]

    runner: _StubRunExecutor = app.state.run_executor
    assert runner.started == []
    async with pg_session_factory() as session:
        cands = (
            await session.execute(
                select(TopicCandidate).where(TopicCandidate.batch_id == bid)
            )
        ).scalars().all()
        assert all(c.status == "candidate" for c in cands)
        assert all(c.promoted_run_id is None for c in cands)


@pytest.mark.asyncio
async def test_promote_409_on_failed_batch(
    api_client_with_stub_runner,
    pg_session_factory,
):
    ac, _ = api_client_with_stub_runner
    bid, cand_ids = await _seed_batch_with_candidates(
        pg_session_factory, status="failed"
    )
    resp = await ac.post(
        f"/topic-batches/{bid}/promote",
        json={
            "promotions": [{"candidate_id": str(cand_ids[0]), "mode": "create"}],
            "editor_email": "e@x",
        },
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.asyncio
async def test_skip_candidate_and_recompute_status(
    api_client_with_stub_runner,
    pg_session_factory,
):
    ac, _ = api_client_with_stub_runner
    bid, cand_ids = await _seed_batch_with_candidates(
        pg_session_factory, candidate_count=2
    )
    r1 = await ac.post(
        f"/topic-batches/{bid}/candidates/{cand_ids[0]}/skip",
        json={"editor_email": "e@x"},
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["status"] == "skipped"

    batch_resp = await ac.get(f"/topic-batches/{bid}")
    assert batch_resp.json()["status"] == "partially_promoted"

    r2 = await ac.post(
        f"/topic-batches/{bid}/candidates/{cand_ids[1]}/skip",
        json={"editor_email": "e@x"},
    )
    assert r2.status_code == 200
    batch_resp = await ac.get(f"/topic-batches/{bid}")
    assert batch_resp.json()["status"] == "done"


@pytest.mark.asyncio
async def test_close_batch_forces_done_and_409_when_terminal(
    api_client_with_stub_runner,
    pg_session_factory,
):
    ac, _ = api_client_with_stub_runner
    bid, _cands = await _seed_batch_with_candidates(pg_session_factory)

    close = await ac.post(f"/topic-batches/{bid}/close")
    assert close.status_code == 200, close.text
    assert close.json()["status"] == "done"

    close2 = await ac.post(f"/topic-batches/{bid}/close")
    assert close2.status_code == 409, close2.text


@pytest.mark.asyncio
async def test_get_batch_returns_candidates_in_position_order(
    api_client_with_stub_runner,
    pg_session_factory,
):
    ac, _ = api_client_with_stub_runner
    bid, _cids = await _seed_batch_with_candidates(
        pg_session_factory, candidate_count=3
    )
    resp = await ac.get(f"/topic-batches/{bid}")
    assert resp.status_code == 200
    body = resp.json()
    positions = [c["position"] for c in body["candidates"]]
    assert positions == [0, 1, 2]


@pytest.mark.asyncio
async def test_get_batch_404_when_missing(api_client_with_stub_runner):
    ac, _ = api_client_with_stub_runner
    resp = await ac.get(f"/topic-batches/{uuid4()}")
    assert resp.status_code == 404
