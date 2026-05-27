import asyncio
import json
import logging
from collections import deque
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.client import GeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.root import build_root_graph
from content_tool.wordpress.client import WordPressClient

logger = logging.getLogger(__name__)

# state.next tuple → Run.status when the root graph is paused at an interrupt.
_NEXT_TO_STATUS: dict[tuple[str, ...], str] = {
    ("production",): "hitl_1",
    ("publish_or_revise",): "hitl_2",
}

# state.next tuple → Run.status while that node is actively running.
_RUNNING_STATUS: dict[tuple[str, ...], str] = {
    ("production",): "production",
    ("publish_or_revise",): "publishing",
}

# Per-run event history kept in memory so a late SSE subscriber (page refresh,
# nav back to the run page) can be brought up-to-date instead of seeing a blank
# timeline. Bounded to avoid unbounded growth.
_EVENT_BUFFER_SIZE = 500


class RunExecutor:
    """Owns background tasks per run; multicasts LangGraph events to SSE subscribers."""

    def __init__(
        self,
        *,
        postgres_url: str,
        session_factory: async_sessionmaker[Any],
        gemini: GeminiClient,
        wp_client: WordPressClient | None = None,
        seo_plugin: str | None = None,
    ) -> None:
        self._postgres_url = postgres_url
        self._sf = session_factory
        self._gemini = gemini
        self._wp_client = wp_client
        self._seo_plugin = seo_plugin
        self._subscribers: dict[UUID, list[asyncio.Queue[str]]] = {}
        self._tasks: dict[UUID, asyncio.Task[None]] = {}
        self._history: dict[UUID, deque[str]] = {}

    def subscribe(self, run_id: UUID) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue()
        # Replay buffered history first so the new subscriber sees the timeline
        # so far before live events arrive.
        for past in self._history.get(run_id, ()):
            q.put_nowait(past)
        self._subscribers.setdefault(run_id, []).append(q)
        return q

    def unsubscribe(self, run_id: UUID, q: asyncio.Queue[str]) -> None:
        if run_id in self._subscribers and q in self._subscribers[run_id]:
            self._subscribers[run_id].remove(q)

    async def _set_status(
        self,
        run_id: UUID,
        status: str,
        *,
        error: dict[str, Any] | None = None,
        clear_error: bool = False,
    ) -> None:
        values: dict[str, Any] = {"status": status}
        if clear_error:
            values["error"] = None
        elif error is not None:
            values["error"] = error
        try:
            async with self._sf() as session:
                await session.execute(
                    update(Run).where(Run.run_id == run_id).values(**values)
                )
                await session.commit()
        except Exception:
            logger.exception(
                "failed to persist run status update",
                extra={"run_id": str(run_id), "status": status},
            )

    async def _emit(self, run_id: UUID, event: str, payload: dict[str, Any]) -> None:
        data = json.dumps(
            {
                "event": event,
                "run_id": str(run_id),
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "payload": payload,
            },
            ensure_ascii=False,
        )
        buf = self._history.setdefault(run_id, deque(maxlen=_EVENT_BUFFER_SIZE))
        buf.append(data)
        for q in self._subscribers.get(run_id, []):
            await q.put(data)

    async def start(self, run_id: UUID) -> None:
        self._tasks[run_id] = asyncio.create_task(self._run(run_id))

    async def resume(self, run_id: UUID, update: dict[str, Any]) -> None:
        self._tasks[run_id] = asyncio.create_task(self._run(run_id, resume=True, update=update))

    async def restart(self, run_id: UUID) -> None:
        """Re-run a failed run from the top.

        A crashed run keeps its partial LangGraph checkpoint, so re-invoking
        ``start`` alone would resume the broken super-step. Delete the thread's
        checkpoint first so the graph executes from the beginning with a freshly
        built initial state, clear the persisted error, and drop the stale event
        history so the live timeline doesn't replay the previous crash.
        """
        async with make_checkpointer(self._postgres_url) as cp:
            await cp.adelete_thread(str(run_id))
        await self._clear_derived_rows(run_id)
        self._history.pop(run_id, None)
        await self._set_status(run_id, "pending", clear_error=True)
        await self.start(run_id)

    async def _clear_derived_rows(self, run_id: UUID) -> None:
        """Drop rows the graph nodes wrote on prior attempts.

        Restarting re-runs every node from the top, and each node INSERTs its
        output (outline, draft, render, citations, audit). Without clearing the
        previous attempt's rows they accumulate, so reads like
        ``select(Render).where(...).scalar_one()`` raise "Multiple rows were
        found". Deleting the run's drafts cascades to citations, renders, and
        audit_runs; outlines/gap_analyses/fetched_articles are cleared directly.
        compliance_log is intentionally left alone (only written post-publish).
        """
        async with self._sf() as session:
            for model in (Draft, OutlineRow, GapAnalysisRow, FetchedArticle):
                await session.execute(delete(model).where(model.run_id == run_id))
            await session.commit()

    async def _run(
        self,
        run_id: UUID,
        *,
        resume: bool = False,
        update: dict[str, Any] | None = None,
    ) -> None:
        try:
            async with make_checkpointer(self._postgres_url) as cp:
                graph = build_root_graph(
                    session_factory=self._sf, gemini=self._gemini, checkpointer=cp,
                    wp_client=self._wp_client, seo_plugin=self._seo_plugin,
                )
                config = {"configurable": {"thread_id": str(run_id)}}

                if resume:
                    if update:
                        await graph.aupdate_state(config, update)
                    inputs = None
                    pre_state = await graph.aget_state(config)
                    pre_next = tuple(pre_state.next) if pre_state.next else ()
                    if pre_next:
                        running_status = _RUNNING_STATUS.get(pre_next, "production")
                        await self._set_status(run_id, running_status)
                    # else: graph already at terminal state; let the completion
                    # branch below decide whether to mirror anything.
                else:
                    inputs = await _build_initial_state(self._sf, run_id)
                    await self._set_status(run_id, "strategy")

                # subgraphs=True yields (namespace_tuple, {node_name: update})
                # for every node in the strategy/production sub-graphs. Without
                # it the root graph emits a single "production.done" for the
                # entire 1-5min production stage and the live timeline appears
                # frozen. Namespace is e.g. ("production:abc",) - strip the
                # langgraph-generated id and keep just the parent label.
                async for ns, chunk in graph.astream(
                    inputs,
                    config=config,
                    stream_mode="updates",
                    subgraphs=True,
                ):
                    prefix_parts = [n.split(":", 1)[0] for n in ns] if ns else []
                    for node_name in chunk.keys():
                        # langgraph emits "__interrupt__" as a synthetic node
                        # at each interrupt boundary; not useful to surface.
                        if node_name.startswith("__"):
                            continue
                        label = ".".join([*prefix_parts, node_name, "done"])
                        await self._emit(run_id, label, {})

                state = await graph.aget_state(config)
                if state.next:  # interrupted at HITL gate
                    next_status = _NEXT_TO_STATUS.get(tuple(state.next))
                    if next_status:
                        await self._set_status(run_id, next_status)
                    await self._emit(run_id, "hitl.interrupted", {"next": list(state.next)})
                else:
                    # publish.py owns "published"/"failed". The only other
                    # terminal graph-state values worth mirroring are explicit
                    # rejection paths from n_publish (when hitl_2_decision is
                    # not "approve"). state.values["status"] otherwise carries
                    # a stale stage marker ("strategy") and should NOT be
                    # written back to the Run row.
                    final_status = (state.values or {}).get("status") if state.values else None
                    if final_status in ("rejected", "changes_requested"):
                        await self._set_status(run_id, final_status)
                    await self._emit(run_id, "graph.completed", {})
        except Exception as e:
            # Persist so the UI surfaces the failure even when no SSE subscriber
            # was listening at the moment of the crash.
            await self._set_status(
                run_id,
                "failed",
                error={"type": type(e).__name__, "message": str(e)},
            )
            logger.exception("runner crashed", extra={"run_id": str(run_id)})
            await self._emit(run_id, "graph.error", {"message": str(e)})


async def _build_initial_state(sf: async_sessionmaker[Any], run_id: UUID) -> dict[str, Any]:
    from sqlalchemy import select

    from content_tool.db.models import Run

    async with sf() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        return {
            "run_id": str(row.run_id),
            "article_url": row.article_url,
            "topic": row.topic,
            "keywords": row.keywords,
            "mode": row.mode,
            "edit_note": row.edit_note,
            "acf_adv_id": row.acf_adv_id,
            "acf_widget_id": row.acf_widget_id,
            "persona": row.persona,
            "topic_category": row.topic_category,
            "today_date": row.today_date.isoformat(),
            "existing_article_markdown": None,
            "wp_post_id": None,
            "wp_categories": None,
            "gap_analysis": None,
            "outline": None,
            "chosen_route": None,
            "writer_output": None,
            "grounding_chunks": None,
            "citations": None,
            "render": None,
            "final_markup": None,
            "audit_findings": None,
            "iteration": 0,
            "hitl_1_decision": None,
            "hitl_1_edits": None,
            "hitl_2_decision": None,
            "hitl_2_notes": None,
            "status": "pending",
            "error": None,
            "start_mode": row.start_mode,
            "topic_candidate_id": (
                str(row.topic_candidate_id) if row.topic_candidate_id else None
            ),
            "target_audience": row.target_audience,
        }


async def sse_stream(executor: RunExecutor, run_id: UUID) -> AsyncIterator[dict[str, str]]:
    q = executor.subscribe(run_id)
    try:
        while True:
            data = await q.get()
            yield {"event": "message", "data": data}
    finally:
        executor.unsubscribe(run_id, q)
