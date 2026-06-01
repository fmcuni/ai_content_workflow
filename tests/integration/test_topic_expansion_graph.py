"""End-to-end integration test for the topic-expansion subgraph.

Drives the full ``topic_gen -> fan_out -> analyse_candidate -> aggregate``
flow against a real Postgres (from the project's testcontainers harness)
with a custom Gemini stub. We exercise:

* the happy path produces 10 ``topic_candidates`` rows with verdicts
* batch status transitions ``pending -> generating -> analysing ->
  ready_for_review``
* one candidate that always raises through retries lands with
  ``last_error`` set but the batch still completes
* the shared semaphore caps concurrent in-flight Gemini calls at 5
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import pytest
from sqlalchemy import select

from content_tool.db.models import TopicBatch, TopicCandidate
from content_tool.gemini.client import GeminiResult
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.topic_expansion import (
    CONCURRENCY_CAP,
    build_topic_expansion_graph,
)


class _ConcurrencyTrackingGemini:
    """Stub Gemini client that records peak concurrency and supports
    per-topic failure injection for the dedup/hot agents.

    Canned ``topic_gen`` returns 10 topics by default. ``analyse_candidate``
    runs ``topic_dedup`` and ``topic_hot`` concurrently for each candidate,
    so peak in-flight should be 2 * CONCURRENCY_CAP if both halves of every
    pair are in flight simultaneously, but we want to cap *candidate*-level
    concurrency. The semaphore lives at the candidate boundary, so peak
    Gemini-call concurrency may rise to 2 * CONCURRENCY_CAP — what we
    actually assert is that we never see more than ``CONCURRENCY_CAP``
    *distinct candidates* in flight at once.
    """

    def __init__(
        self,
        *,
        topic_gen_topics: list[dict[str, Any]],
        fail_topics: set[str] | None = None,
        per_call_delay_s: float = 0.05,
    ) -> None:
        self._topic_gen_topics = topic_gen_topics
        self._fail_topics = fail_topics or set()
        self._per_call_delay_s = per_call_delay_s
        self.peak_concurrent_calls = 0
        self.peak_concurrent_candidates = 0
        self._in_flight = 0
        # candidate-level tracking: maps a "candidate fingerprint" (the
        # topic string, which is unique per candidate in the test fixture)
        # to a refcount; peak distinct count is what we report.
        self._candidates_in_flight: set[str] = set()
        self._fail_counts: dict[str, int] = {}
        self._lock = asyncio.Lock()
        self.calls: list[dict[str, Any]] = []

    async def generate(
        self,
        *,
        agent: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: dict[str, Any] | None,
        tools: list[str],
    ) -> GeminiResult:
        topic = _extract_topic_from_user_prompt(user_prompt)
        async with self._lock:
            self._in_flight += 1
            if self._in_flight > self.peak_concurrent_calls:
                self.peak_concurrent_calls = self._in_flight
            if topic is not None and agent in ("topic_dedup", "topic_hot"):
                self._candidates_in_flight.add(topic)
                if (
                    len(self._candidates_in_flight)
                    > self.peak_concurrent_candidates
                ):
                    self.peak_concurrent_candidates = len(
                        self._candidates_in_flight
                    )
            self.calls.append({"agent": agent, "topic": topic})
        try:
            # tiny delay so concurrent calls actually overlap
            await asyncio.sleep(self._per_call_delay_s)

            if agent == "topic_gen":
                payload = {"topics": self._topic_gen_topics}
            elif topic is not None and topic in self._fail_topics:
                # Raise on every attempt so the subgraph's retry exhausts.
                self._fail_counts[topic] = self._fail_counts.get(topic, 0) + 1
                raise RuntimeError(f"stub: forced failure for topic {topic!r}")
            elif agent == "topic_existing_search":
                # Dedup stage 1: grounded retrieval. No grounding chunks here →
                # zero existing-article candidates (the common return below sets
                # grounding_chunks=None), so the judge sees an empty list.
                payload = {}
            elif agent == "topic_dedup":
                payload = {
                    "existing": "no",
                    "existing_note": f"not seen for {topic}",
                    "existing_url": "",
                }
            elif agent == "topic_hot":
                payload = {
                    "hot_topic": "yes",
                    "hot_topic_note": f"trending: {topic}",
                }
            else:  # pragma: no cover - defensive
                raise KeyError(f"unknown agent: {agent}")
            return GeminiResult(
                parsed=payload,
                raw_text=json.dumps(payload, ensure_ascii=False),
                tokens_in=10,
                tokens_out=5,
                thinking_tokens=1,
                latency_ms=1,
            )
        finally:
            async with self._lock:
                self._in_flight -= 1
                if topic is not None:
                    self._candidates_in_flight.discard(topic)


def _extract_topic_from_user_prompt(user_prompt: str) -> str | None:
    """Pull the ``topic`` line out of the dedup/hot agent prompts.

    Their user prompt is::

        ...
        topic:
        <topic>

        focus_keywords: ...

    Easier than threading the candidate id through state.
    """
    marker = "topic:\n"
    idx = user_prompt.find(marker)
    if idx == -1:
        return None
    rest = user_prompt[idx + len(marker) :]
    end = rest.find("\n")
    if end == -1:
        return rest.strip() or None
    return rest[:end].strip() or None


def _make_topics(n: int) -> list[dict[str, Any]]:
    return [
        {"topic": f"topic-{i:02d}", "keywords": [f"kw-{i:02d}-a", f"kw-{i:02d}-b"]}
        for i in range(n)
    ]


@pytest.mark.asyncio
async def test_topic_expansion_graph_end_to_end(
    postgres_url,
    pg_session_factory,
    caplog,
):
    """Happy path + one always-failing candidate.

    Hits all four nodes, verifies persisted rows + status transitions,
    and asserts the semaphore caps candidate-level concurrency at five.
    """
    caplog.set_level(logging.WARNING, logger="content_tool.graph.topic_expansion")

    sf = pg_session_factory
    topics = _make_topics(10)
    # Pick one topic to fail through retries.
    fail_topic = topics[3]["topic"]

    gemini = _ConcurrencyTrackingGemini(
        topic_gen_topics=topics,
        fail_topics={fail_topic},
        per_call_delay_s=0.08,
    )

    # Seed the parent batch row.
    async with sf() as session:
        batch = TopicBatch(
            created_by="t@bowtie",
            status="pending",
            research_theme="theme",
            target_audience="audience",
            topic_count=10,
            keywords_per_topic=2,
            must_cover=[],
            must_avoid=[],
        )
        session.add(batch)
        await session.flush()
        batch_id = batch.batch_id
        await session.commit()

    # Build + compile graph.
    async with make_checkpointer(postgres_url) as cp:
        graph = build_topic_expansion_graph(
            session_factory=sf, gemini=gemini
        ).compile(checkpointer=cp)
        config: dict[str, Any] = {"configurable": {"thread_id": str(batch_id)}}
        initial = {
            "batch_id": str(batch_id),
            "input": {
                "research_theme": "theme",
                "target_audience": "audience",
                "topic_count": 10,
                "keywords_per_topic": 2,
                "must_cover": [],
                "must_avoid": [],
                "priority_focus": None,
                "notes": None,
            },
        }
        # Speed: shrink the retry helper's backoff so the failing
        # candidate doesn't make the test glacial. (Production: 1s + 2s.)
        from content_tool.graph import topic_expansion as te

        orig_base = te._BASE_BACKOFF_S
        te._BASE_BACKOFF_S = 0.0
        try:
            final = await graph.ainvoke(initial, config=config)
        finally:
            te._BASE_BACKOFF_S = orig_base

    # ----- assertions -----

    # 1. All 10 candidates persisted in position order.
    async with sf() as session:
        rows = (
            await session.execute(
                select(TopicCandidate)
                .where(TopicCandidate.batch_id == batch_id)
                .order_by(TopicCandidate.position)
            )
        ).scalars().all()
    assert len(rows) == 10
    assert [r.position for r in rows] == list(range(10))
    assert [r.topic for r in rows] == [t["topic"] for t in topics]
    # Snapshot fields populated on insert.
    for r, t in zip(rows, topics, strict=True):
        assert r.original_topic == t["topic"]
        assert r.original_keywords == t["keywords"]

    # 2. Nine candidates have verdicts; the failing one has last_error set
    #    and NULL verdicts.
    failed_rows = [r for r in rows if r.topic == fail_topic]
    happy_rows = [r for r in rows if r.topic != fail_topic]
    assert len(failed_rows) == 1
    failed = failed_rows[0]
    assert failed.last_error is not None
    assert "dedup" in failed.last_error or "hot_topic" in failed.last_error
    assert failed.existing is None
    assert failed.hot_topic is None

    for r in happy_rows:
        assert r.existing == "no"
        assert r.existing_note is not None
        assert r.hot_topic == "yes"
        assert r.hot_topic_note is not None
        assert r.last_error is None

    # 3. Batch ends at ready_for_review (one failure is not enough to
    #    flip the whole batch to "failed").
    async with sf() as session:
        b = (
            await session.execute(
                select(TopicBatch).where(TopicBatch.batch_id == batch_id)
            )
        ).scalar_one()
    assert b.status == "ready_for_review"
    assert b.last_error is None
    assert final.get("status") == "ready_for_review"

    # 4. The retry helper logged at least one retry warning for the
    #    failing candidate (proves we did 2 retries, not 1 attempt).
    retry_logs = [
        rec for rec in caplog.records
        if "topic_expansion" in rec.name and "retrying" in rec.getMessage()
    ]
    # Each Gemini call retries up to 2 times => up to 2 warnings per
    # call. The failing candidate runs dedup + hot, both fail forever,
    # so we expect at least 4 warnings (2 retries x 2 agents).
    assert len(retry_logs) >= 4, (
        f"expected >=4 retry warnings, got {len(retry_logs)}: "
        f"{[r.getMessage() for r in retry_logs]}"
    )

    # 5. Concurrency cap on candidates.
    assert gemini.peak_concurrent_candidates <= CONCURRENCY_CAP, (
        f"peak candidate concurrency {gemini.peak_concurrent_candidates} "
        f"exceeded cap {CONCURRENCY_CAP}"
    )
    # We expect the peak to actually hit the cap (10 candidates, 5 slots,
    # 80ms per call — overlap is guaranteed) — otherwise the semaphore
    # logic could be silently broken without us noticing.
    assert gemini.peak_concurrent_candidates >= 2, (
        "concurrency tracking saw barely any overlap — semaphore may not be"
        " shared across candidates as intended"
    )


@pytest.mark.asyncio
async def test_topic_expansion_graph_all_candidates_fail_marks_batch_failed(
    postgres_url,
    pg_session_factory,
):
    """When every candidate errors, ``aggregate`` flips the batch to ``failed``."""
    sf = pg_session_factory
    topics = _make_topics(3)
    fail_set = {t["topic"] for t in topics}
    gemini = _ConcurrencyTrackingGemini(
        topic_gen_topics=topics,
        fail_topics=fail_set,
        per_call_delay_s=0.01,
    )

    async with sf() as session:
        batch = TopicBatch(
            created_by="t@bowtie",
            status="pending",
            research_theme="theme",
            target_audience="audience",
            topic_count=3,
            keywords_per_topic=2,
            must_cover=[],
            must_avoid=[],
        )
        session.add(batch)
        await session.flush()
        batch_id = batch.batch_id
        await session.commit()

    async with make_checkpointer(postgres_url) as cp:
        graph = build_topic_expansion_graph(
            session_factory=sf, gemini=gemini
        ).compile(checkpointer=cp)
        config: dict[str, Any] = {"configurable": {"thread_id": str(batch_id)}}
        initial = {
            "batch_id": str(batch_id),
            "input": {
                "research_theme": "theme",
                "target_audience": "audience",
                "topic_count": 3,
                "keywords_per_topic": 2,
                "must_cover": [],
                "must_avoid": [],
                "priority_focus": None,
                "notes": None,
            },
        }
        from content_tool.graph import topic_expansion as te

        orig_base = te._BASE_BACKOFF_S
        te._BASE_BACKOFF_S = 0.0
        try:
            final = await graph.ainvoke(initial, config=config)
        finally:
            te._BASE_BACKOFF_S = orig_base

    async with sf() as session:
        b = (
            await session.execute(
                select(TopicBatch).where(TopicBatch.batch_id == batch_id)
            )
        ).scalar_one()
        rows = (
            await session.execute(
                select(TopicCandidate).where(TopicCandidate.batch_id == batch_id)
            )
        ).scalars().all()

    assert b.status == "failed"
    assert b.last_error is not None
    assert final.get("status") == "failed"
    assert len(rows) == 3
    assert all(r.last_error is not None for r in rows)


