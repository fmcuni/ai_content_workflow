"""RunExecutor + SSE streaming.

Drives a compiled LangGraph run to completion (pausing at the HITL interrupts)
and streams each step to the browser as Server-Sent Events. Every emitted event
is also mirrored into the ``run_event_logs`` table for the verbose debug panel.
"""

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
from content_tool.gemini.prompt_context import RunContext, set_run_context
from content_tool.gemini.streaming import set_thought_emitter
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.root import build_root_graph
from content_tool.observability.event_log import RunEventLogWriter, set_event_emitter
from content_tool.wordpress.client import WordPressClient
from content_tool.wordpress.seo_plugin import SeoPluginResolver

logger = logging.getLogger(__name__)


class RunAlreadyExecutingError(RuntimeError):
    """Raised when a second graph task is requested for a run already in flight.

    Two concurrent ``start``/``resume``/``restart`` calls for the same run would
    otherwise spawn duplicate LangGraph tasks (double publish, racing checkpoint
    writes). Callers surface this as HTTP 409.
    """

    def __init__(self, run_id: UUID) -> None:
        super().__init__(f"run {run_id} is already executing")
        self.run_id = run_id

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

# Statuses meaning "LangGraph was actively driving this run". On a fresh process
# there is no live task for any of these, so they are guaranteed orphaned and
# must be recovered as "failed" so the user can restart. HITL pauses
# ("hitl_1", "hitl_2") deliberately have no in-memory task — they survive
# restarts via the checkpoint — so they are NOT in this set.
_IN_FLIGHT_STATUSES: tuple[str, ...] = (
    "pending",
    "fetching",
    "strategy",
    "production",
    "publishing",
)

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
        seo_resolver: SeoPluginResolver | None = None,
    ) -> None:
        self._postgres_url = postgres_url
        self._sf = session_factory
        self._gemini = gemini
        self._wp_client = wp_client
        self._seo_resolver = seo_resolver
        self._subscribers: dict[UUID, list[asyncio.Queue[str]]] = {}
        self._tasks: dict[UUID, asyncio.Task[None]] = {}
        self._history: dict[UUID, deque[str]] = {}
        # Side-channel: persists every emitted event to run_event_logs. Failures
        # here are logged and dropped inside the writer; they never break SSE.
        self._event_log = RunEventLogWriter(session_factory)

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
        envelope = {
            "event": event,
            "run_id": str(run_id),
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "payload": payload,
        }
        # Persist to run_event_logs (fire-and-forget; never raises).
        self._event_log.enqueue(str(run_id), "run", envelope)
        data = json.dumps(envelope, ensure_ascii=False)
        # Drop thinking chunks from the replay buffer — they are live-only
        # progress for currently-watching subscribers, accumulate fast (one
        # event per Gemini thought-summary chunk), and would otherwise evict
        # the structurally meaningful milestone events that the timeline UI
        # actually replays on a late connect.
        if not event.endswith(".thinking"):
            buf = self._history.setdefault(run_id, deque(maxlen=_EVENT_BUFFER_SIZE))
            buf.append(data)
        for q in self._subscribers.get(run_id, []):
            await q.put(data)

    async def recover_orphaned(self) -> list[UUID]:
        """Mark in-flight runs from a prior process as ``failed``.

        A server restart (auto-reload during dev, crash, redeploy) kills any
        live LangGraph task in memory but the Run row still carries whatever
        in-flight status it held at the moment. Without this recovery, the
        ``/restart`` endpoint refuses (requires status="failed") and the run
        is silently stuck. Called from the lifespan after the executor is
        constructed but before requests are served, so no live tasks can
        exist yet.
        """
        from sqlalchemy import select

        async with self._sf() as session:
            rows = (
                await session.execute(
                    select(Run.run_id).where(Run.status.in_(_IN_FLIGHT_STATUSES))
                )
            ).scalars().all()
            if not rows:
                return []
            await session.execute(
                update(Run)
                .where(Run.status.in_(_IN_FLIGHT_STATUSES))
                .values(
                    status="failed",
                    error={
                        "type": "OrphanedRun",
                        "message": (
                            "Server restarted while this run was in flight; "
                            "the in-memory task was lost. Click Restart to retry."
                        ),
                    },
                )
            )
            await session.commit()
        logger.warning(
            "recovered orphaned in-flight runs as failed",
            extra={"count": len(rows), "run_ids": [str(r) for r in rows]},
        )
        return list(rows)

    def _assert_no_live_task(self, run_id: UUID) -> None:
        """Refuse to spawn a duplicate task when one is already in flight.

        A finished task (``done()``) is fine to replace — it lets a completed or
        failed run be started again (e.g. restart). A still-running task means a
        concurrent start/resume is mid-execution and must not be duplicated.
        """
        existing = self._tasks.get(run_id)
        if existing is not None and not existing.done():
            raise RunAlreadyExecutingError(run_id)

    async def start(self, run_id: UUID) -> None:
        self._assert_no_live_task(run_id)
        self._tasks[run_id] = asyncio.create_task(self._run(run_id))

    async def resume(self, run_id: UUID, update: dict[str, Any]) -> None:
        self._assert_no_live_task(run_id)
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

    async def cancel(self, run_id: UUID) -> None:
        """Stop any in-flight background task for this run and drop its state.

        Called before a hard-delete so the executor isn't still streaming into
        rows that are about to be removed (which would race the delete and try
        to re-INSERT derived rows against a now-missing run). Cancelling the
        task and awaiting it guarantees the graph has stopped before we touch
        the DB. Safe to call when there is no live task.
        """
        task = self._tasks.pop(run_id, None)
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("error awaiting cancelled run task", extra={"run_id": str(run_id)})
        # Drop the LangGraph checkpoint thread so no orphaned state lingers.
        try:
            async with make_checkpointer(self._postgres_url) as cp:
                await cp.adelete_thread(str(run_id))
        except Exception:
            logger.exception("failed to delete checkpoint thread", extra={"run_id": str(run_id)})
        self._history.pop(run_id, None)
        self._subscribers.pop(run_id, None)
        # Persist anything still queued before the run's rows are deleted.
        await self._event_log.flush()

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
        async def _emit_thought(agent: str, chunk: str) -> None:
            await self._emit(
                run_id, f"{agent}.thinking", {"agent": agent, "chunk": chunk}
            )

        async def _emit_event(event: str, payload: dict[str, Any]) -> None:
            await self._emit(run_id, event, payload)

        # Bind on a ContextVar so any ``gemini.generate`` call inside the graph
        # (writer, audit, …) picks it up and streams; nodes running outside
        # this executor (CLI, refresh evaluator) see the default ``None`` and
        # use the one-shot path. The event emitter is bound alongside so the
        # ``logged_node`` wrappers emit ``*.start`` / ``*.error`` lifecycle
        # markers through the same SSE + persistence choke point.
        set_thought_emitter(_emit_thought)
        set_event_emitter(_emit_event)
        set_run_context(RunContext(run_id=str(run_id)))
        self._event_log.start()
        try:
            # Re-detect the SEO plugin against the live WP target as the run
            # builds (on HITL_2 resume this is effectively publish time), rather
            # than trusting a value cached once at process startup.
            seo_plugin = (
                await self._seo_resolver.resolve() if self._seo_resolver is not None else None
            )
            async with make_checkpointer(self._postgres_url) as cp:
                graph = build_root_graph(
                    session_factory=self._sf, gemini=self._gemini, checkpointer=cp,
                    wp_client=self._wp_client, seo_plugin=seo_plugin,
                )
                config = {"configurable": {"thread_id": str(run_id)}}

                # The stream is wrapped in a loop so an auto-accepted HITL_1 gate
                # can approve in place and re-enter the graph WITHOUT pausing for
                # a human. `resume_iter`/`pending_update` carry the per-iteration
                # resume state; the initial values are the call's own args.
                resume_iter = resume
                pending_update = update
                while True:
                    if resume_iter:
                        if pending_update:
                            await graph.aupdate_state(config, pending_update)
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
                        # Auto-accept the HITL_1 outline gate: approve in place and
                        # re-enter the graph instead of pausing. HITL_2 still
                        # pauses. The flag only matches the outline gate, so this
                        # can run at most once and cannot loop.
                        if next_status == "hitl_1" and await _load_auto_accept_hitl1(
                            self._sf, run_id
                        ):
                            await self._emit(run_id, "hitl.auto_approved", {"gate": "hitl_1"})
                            resume_iter = True
                            pending_update = {"hitl_1_decision": "approve"}
                            continue
                        if next_status:
                            await self._set_status(run_id, next_status)
                        await self._emit(run_id, "hitl.interrupted", {"next": list(state.next)})
                        break
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
                    break
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
        finally:
            # ContextVar lives for the lifetime of this asyncio task; clearing
            # is belt-and-braces in case the executor coroutine is reused.
            set_thought_emitter(None)
            set_event_emitter(None)
            # Drain any events still queued so a finished/failed run's log is
            # complete even if the periodic drain hasn't fired yet.
            await self._event_log.flush()


async def _load_auto_accept_hitl1(sf: async_sessionmaker[Any], run_id: UUID) -> bool:
    """Whether this run should auto-approve its HITL_1 outline gate."""
    from sqlalchemy import select

    from content_tool.db.models import Run

    async with sf() as session:
        flag = (
            await session.execute(select(Run.auto_accept_hitl1).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        return bool(flag)


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
