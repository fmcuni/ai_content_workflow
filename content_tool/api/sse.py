import asyncio
import json
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.gemini.client import GeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.root import build_root_graph


class RunExecutor:
    """Owns background tasks per run; multicasts LangGraph events to SSE subscribers."""

    def __init__(
        self,
        *,
        postgres_url: str,
        session_factory: async_sessionmaker[Any],
        gemini: GeminiClient,
    ) -> None:
        self._postgres_url = postgres_url
        self._sf = session_factory
        self._gemini = gemini
        self._subscribers: dict[UUID, list[asyncio.Queue[str]]] = {}
        self._tasks: dict[UUID, asyncio.Task[None]] = {}

    def subscribe(self, run_id: UUID) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue()
        self._subscribers.setdefault(run_id, []).append(q)
        return q

    def unsubscribe(self, run_id: UUID, q: asyncio.Queue[str]) -> None:
        if run_id in self._subscribers and q in self._subscribers[run_id]:
            self._subscribers[run_id].remove(q)

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
        for q in self._subscribers.get(run_id, []):
            await q.put(data)

    async def start(self, run_id: UUID) -> None:
        self._tasks[run_id] = asyncio.create_task(self._run(run_id))

    async def resume(self, run_id: UUID, update: dict[str, Any]) -> None:
        self._tasks[run_id] = asyncio.create_task(self._run(run_id, resume=True, update=update))

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
                    session_factory=self._sf, gemini=self._gemini, checkpointer=cp
                )
                config = {"configurable": {"thread_id": str(run_id)}}

                if resume:
                    if update:
                        await graph.aupdate_state(config, update)
                    inputs = None
                else:
                    inputs = await _build_initial_state(self._sf, run_id)

                async for chunk in graph.astream(inputs, config=config, stream_mode="updates"):
                    for node_name, _ in chunk.items():
                        await self._emit(run_id, f"{node_name}.done", {})

                state = await graph.aget_state(config)
                if state.next:  # interrupted
                    await self._emit(run_id, "hitl.interrupted", {"next": list(state.next)})
                else:
                    await self._emit(run_id, "graph.completed", {})
        except Exception as e:
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
        }


async def sse_stream(executor: RunExecutor, run_id: UUID) -> AsyncIterator[dict[str, str]]:
    q = executor.subscribe(run_id)
    try:
        while True:
            data = await q.get()
            yield {"event": "message", "data": data}
    finally:
        executor.unsubscribe(run_id, q)
