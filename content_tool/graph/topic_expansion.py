"""Topic-expansion subgraph.

Drives Front II ("Expand Topics"): one ``topic_gen`` call followed by a
fan-out over each generated topic that runs the dedup and hot-topic agents
in parallel and persists the verdict back onto the matching
``topic_candidates`` row.

Structure (one node per stage)::

    topic_gen -> fan_out -> [analyse_candidate]xN  ->  aggregate
                              (Send map-reduce)

No HITL interrupt sits inside this subgraph — HITL_T1 is "graph completes,
operator reviews via the API." The caller compiles this graph with the
project's :class:`AsyncPostgresSaver` checkpointer; no checkpointer-specific
work is needed here since the state stays small and serialisable.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any, TypedDict
from uuid import UUID

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.agents.topic_dedup import run_topic_dedup
from content_tool.agents.topic_gen import run_topic_gen
from content_tool.agents.topic_hot import run_topic_hot
from content_tool.agents.url_resolver import UrlResolver
from content_tool.db.topic_batch_model import TopicBatch, TopicCandidate
from content_tool.gemini.client import GeminiClient
from content_tool.models.topic_batch import (
    TopicDedupInput,
    TopicDedupOutput,
    TopicGenInput,
    TopicHotInput,
    TopicHotOutput,
)
from content_tool.observability.event_log import logged_node

_logger = logging.getLogger(__name__)

# Cap concurrent in-flight ``analyse_candidate`` invocations. The factory
# constructs one ``asyncio.Semaphore(CONCURRENCY_CAP)`` and shares it across
# every Send-spawned task for the duration of one batch run.
CONCURRENCY_CAP = 5

# Two retries (so up to three Gemini attempts in total) with exponential
# backoff. See ``_retry_with_backoff`` below; values mirror the n8n
# workflow's "Wait" node settling-times.
_MAX_ATTEMPTS = 3
_BASE_BACKOFF_S = 1.0


class TopicExpansionState(TypedDict, total=False):
    """Top-level state carried through the topic-expansion subgraph.

    Per-candidate state is intentionally NOT carried in this dict — each
    ``Send`` packet carries just the ``candidate_id`` and the
    ``analyse_candidate`` node refetches the row from Postgres. That keeps
    the LangGraph reducer trivial and the checkpoint payload small.

    Fields:
        batch_id: stringified UUID of the parent ``topic_batches`` row.
        input: serialised ``TopicGenInput`` (the brief).
        generated: rows written by ``topic_gen`` for ``fan_out`` to drain.
        candidate_ids: stringified candidate UUIDs that ``fan_out`` just
            inserted. ``analyse_candidate`` ignores this — it's only here
            so the conditional edge can emit one ``Send`` per id.
        status: terminal label written by ``aggregate``.
    """

    batch_id: str
    input: dict[str, Any]
    generated: list[dict[str, Any]]
    candidate_ids: list[str]
    status: str


# ---------------------------------------------------------------------------
# Small inline retry helper. There is no shared retry module yet (``writer.py``
# inlines its own attempt count via the audit loop), so we keep this local.
# ---------------------------------------------------------------------------


async def _retry_with_backoff[T](
    fn: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = _MAX_ATTEMPTS,
    base_backoff_s: float = _BASE_BACKOFF_S,
    label: str = "gemini-call",
) -> T:
    """Run ``fn`` with up to ``max_attempts`` tries on transient failure.

    Backoff is exponential (``base * 2**attempt``) with a small jitter to
    avoid thundering-herd retries when several candidates fail at once.
    The last exception is re-raised so the caller can record it on the
    candidate row.
    """
    last_exc: BaseException | None = None
    for attempt in range(max_attempts):
        try:
            return await fn()
        except Exception as exc:  # we want any LLM/transport error
            last_exc = exc
            if attempt + 1 >= max_attempts:
                break
            # 1s, 2s, ... with up to 25% jitter
            delay = base_backoff_s * (2**attempt)
            delay += delay * random.uniform(0.0, 0.25)  # noqa: S311
            _logger.warning(
                "topic_expansion.%s attempt %d/%d failed: %s — retrying in %.2fs",
                label,
                attempt + 1,
                max_attempts,
                exc,
                delay,
            )
            await asyncio.sleep(delay)
    assert last_exc is not None  # for type-checker; loop must have raised
    raise last_exc


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


async def _set_batch_status(
    session: AsyncSession,
    batch_id: UUID,
    status: str,
    *,
    last_error: str | None = None,
) -> None:
    values: dict[str, Any] = {"status": status}
    if last_error is not None:
        values["last_error"] = last_error
    await session.execute(
        update(TopicBatch).where(TopicBatch.batch_id == batch_id).values(**values)
    )
    await session.commit()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def build_topic_expansion_graph(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    gemini: GeminiClient,
) -> StateGraph:
    """Build the topic-expansion subgraph.

    The caller is expected to compile the returned :class:`StateGraph` with
    the project's :class:`AsyncPostgresSaver` checkpointer.

    A single :class:`asyncio.Semaphore` is constructed here and closed over
    by ``n_analyse_candidate`` so all fan-out candidates for one batch run
    share the same concurrency budget.
    """
    semaphore = asyncio.Semaphore(CONCURRENCY_CAP)

    # ---- topic_gen ----------------------------------------------------
    async def n_topic_gen(state: TopicExpansionState) -> dict[str, Any]:
        batch_id = UUID(state["batch_id"])
        async with session_factory() as session:
            await _set_batch_status(session, batch_id, "generating")
        gen_input = TopicGenInput.model_validate(state["input"])
        try:
            output = await _retry_with_backoff(
                lambda: run_topic_gen(gemini=gemini, input=gen_input),
                label="topic_gen",
            )
        except Exception as exc:
            err = f"topic_gen failed after retries: {exc!r}"
            async with session_factory() as session:
                await _set_batch_status(session, batch_id, "failed", last_error=err)
            raise
        async with session_factory() as session:
            await _set_batch_status(session, batch_id, "analysing")
        return {
            "generated": [c.model_dump() for c in output.topics],
        }

    # ---- fan_out -----------------------------------------------------
    async def n_fan_out(state: TopicExpansionState) -> dict[str, Any]:
        """Insert one ``topic_candidates`` row per generated topic.

        Returns nothing meaningful for the state — the conditional edge
        that follows is what emits the ``Send`` packets.
        """
        batch_id = UUID(state["batch_id"])
        generated = state.get("generated", [])
        candidate_ids: list[str] = []
        async with session_factory() as session:
            for position, item in enumerate(generated):
                topic = str(item["topic"])
                keywords = [str(k) for k in item["keywords"]]
                row = TopicCandidate(
                    batch_id=batch_id,
                    position=position,
                    status="candidate",
                    topic=topic,
                    keywords=keywords,
                    original_topic=topic,
                    original_keywords=keywords,
                )
                session.add(row)
                await session.flush()
                candidate_ids.append(str(row.candidate_id))
            await session.commit()
        # The candidate_ids list goes into the state so the conditional
        # edge can emit one ``Send`` per id. Not strictly required (the
        # edge could re-query), but keeping it explicit is cheaper and
        # simplifies test introspection.
        return {"candidate_ids": candidate_ids}

    # ---- analyse_candidate (one per Send) ----------------------------
    async def n_analyse_candidate(payload: dict[str, Any]) -> dict[str, Any]:
        """Analyse a single candidate.

        Receives a ``Send``-payload dict containing ``candidate_id``;
        re-loads the row, runs dedup + hot-topic in parallel under the
        shared semaphore, and writes both verdicts back. Errors are
        captured on the row's ``last_error`` column rather than raised,
        so a partial failure does not bring down the whole batch.
        """
        candidate_id = UUID(payload["candidate_id"])
        async with semaphore:
            async with session_factory() as session:
                cand_obj = (
                    await session.execute(
                        select(TopicCandidate).where(
                            TopicCandidate.candidate_id == candidate_id
                        )
                    )
                ).scalar_one()
                topic = cand_obj.topic
                keywords = list(cand_obj.keywords)

            dedup_input = TopicDedupInput(topic=topic, keywords=keywords)
            hot_input = TopicHotInput(topic=topic, keywords=keywords)

            async def _do_dedup() -> TopicDedupOutput:
                # Dedup needs its own session (the stage-1 URL resolver writes to
                # url_resolution_cache); it must not share one with the hot call
                # running concurrently under the same gather. A fresh session per
                # attempt also keeps retries clean. The resolver flushes within
                # the session; commit here to persist the cache rows it wrote.
                async def _call() -> TopicDedupOutput:
                    async with session_factory() as dedup_session:
                        resolver = UrlResolver(session=dedup_session)
                        out = await run_topic_dedup(
                            gemini=gemini, resolve=resolver.resolve, input=dedup_input
                        )
                        await dedup_session.commit()
                        return out

                return await _retry_with_backoff(_call, label="topic_dedup")

            async def _do_hot() -> TopicHotOutput:
                return await _retry_with_backoff(
                    lambda: run_topic_hot(gemini=gemini, input=hot_input),
                    label="topic_hot",
                )

            results = await asyncio.gather(_do_dedup(), _do_hot(), return_exceptions=True)
            dedup_res, hot_res = results

            values: dict[str, Any] = {}
            errors: list[str] = []
            if isinstance(dedup_res, BaseException):
                errors.append(f"dedup: {dedup_res!r}")
                values["existing"] = None
                values["existing_note"] = None
                values["existing_url"] = None
            else:
                values["existing"] = dedup_res.existing
                values["existing_note"] = dedup_res.existing_note
                values["existing_url"] = dedup_res.existing_url
            if isinstance(hot_res, BaseException):
                errors.append(f"hot_topic: {hot_res!r}")
                values["hot_topic"] = None
                values["hot_topic_note"] = None
            else:
                values["hot_topic"] = hot_res.hot_topic
                values["hot_topic_note"] = hot_res.hot_topic_note
            if errors:
                values["last_error"] = "; ".join(errors)

            async with session_factory() as session:
                await session.execute(
                    update(TopicCandidate)
                    .where(TopicCandidate.candidate_id == candidate_id)
                    .values(**values)
                )
                await session.commit()
        return {}

    # ---- aggregate ---------------------------------------------------
    async def n_aggregate(state: TopicExpansionState) -> dict[str, Any]:
        """All candidates have settled — flip the batch status.

        ``ready_for_review`` if at least one candidate ended without an
        error; ``failed`` only if *every* candidate ended with
        ``last_error`` set (e.g. Gemini was wholly unreachable).
        """
        batch_id = UUID(state["batch_id"])
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(TopicCandidate.last_error).where(
                        TopicCandidate.batch_id == batch_id
                    )
                )
            ).all()
            if rows and all(r[0] is not None for r in rows):
                await _set_batch_status(
                    session,
                    batch_id,
                    "failed",
                    last_error="every candidate errored during analyse_candidate",
                )
                return {"status": "failed"}
            await _set_batch_status(session, batch_id, "ready_for_review")
        return {"status": "ready_for_review"}

    # ---- Send-emitting conditional edge ------------------------------
    def _continue_to_candidates(state: dict[str, Any]) -> list[Send]:
        ids = state.get("candidate_ids", []) or []
        return [Send("analyse_candidate", {"candidate_id": cid}) for cid in ids]

    g = StateGraph(TopicExpansionState)
    g.add_node("topic_gen", logged_node("topic", "topic_gen", n_topic_gen))
    g.add_node("fan_out", logged_node("topic", "fan_out", n_fan_out))
    g.add_node("analyse_candidate", logged_node("topic", "analyse_candidate", n_analyse_candidate))
    g.add_node("aggregate", logged_node("topic", "aggregate", n_aggregate))

    g.add_edge(START, "topic_gen")
    g.add_edge("topic_gen", "fan_out")
    g.add_conditional_edges("fan_out", _continue_to_candidates, ["analyse_candidate"])
    g.add_edge("analyse_candidate", "aggregate")
    g.add_edge("aggregate", END)
    return g
