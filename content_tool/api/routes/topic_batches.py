"""HTTP surface for the topic-expansion batches (Front II).

Mirrors the layout of ``content_tool/api/routes/runs.py``: a small router that
owns CRUD + SSE for the parent ``topic_batches`` row plus the operator
actions (PATCH candidate, promote, skip, close). The background graph launch
follows the ``RunExecutor`` pattern in ``content_tool/api/sse.py`` — a
per-batch ``asyncio.Task`` that drives ``build_topic_expansion_graph`` and
multicasts events to SSE subscribers.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sse_starlette.sse import EventSourceResponse

from content_tool.api.routes.runs import (
    _create_run_row as create_run_row,  # pyright: ignore[reportPrivateUsage]
)
from content_tool.api.schemas import (
    CreateRunRequest,
    PatchCandidateIn,
    PromoteRequest,
    PromoteResponse,
    PromoteResponseItem,
    SkipCandidateRequest,
    TopicBatchCreateResponse,
    TopicBatchIn,
    TopicBatchOut,
    TopicCandidateOut,
)
from content_tool.db.models import TopicBatch, TopicCandidate
from content_tool.gemini.client import GeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.topic_expansion import (
    build_topic_expansion_graph,  # pyright: ignore[reportUnknownVariableType]
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/topic-batches", tags=["topic-batches"])

_TERMINAL_STATUSES: frozenset[str] = frozenset({"done", "failed"})
_BATCH_EVENT_BUFFER_SIZE = 500


def get_session_factory(request: Request) -> async_sessionmaker[Any]:
    return request.app.state.session_factory  # type: ignore[no-any-return]


def get_runner(request: Request) -> Any:  # noqa: ANN401
    return request.app.state.run_executor


def get_batch_executor(request: Request) -> TopicBatchExecutor:
    """Lazily attach a ``TopicBatchExecutor`` to ``app.state`` on first use.

    The factory mirrors the lifespan-wired ``RunExecutor`` but is created
    here so we don't have to thread another dependency through
    ``content_tool/api/main.py``.
    """
    existing = getattr(request.app.state, "topic_batch_executor", None)
    if existing is not None:
        return existing  # type: ignore[no-any-return]
    executor = TopicBatchExecutor(
        postgres_url=_get_postgres_url(request),
        session_factory=request.app.state.session_factory,
        gemini=request.app.state.gemini_client,
    )
    request.app.state.topic_batch_executor = executor
    return executor


def _get_postgres_url(request: Request) -> str:
    """Best-effort lookup of the postgres URL the app was wired with.

    SQLAlchemy's ``str(URL)`` masks the password as ``***``; we need the
    real DSN to hand to LangGraph's psycopg-based checkpointer, so render
    explicitly with the password preserved.
    """
    bind = request.app.state.session_factory.kw.get("bind")
    if bind is not None:
        return str(bind.url.render_as_string(hide_password=False))
    from content_tool.config import get_settings

    return get_settings().postgres_url


class TopicBatchExecutor:
    """Runs ``build_topic_expansion_graph`` in the background per batch."""

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
        self._history: dict[UUID, deque[str]] = {}

    def subscribe(self, batch_id: UUID) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue()
        for past in self._history.get(batch_id, ()):
            q.put_nowait(past)
        self._subscribers.setdefault(batch_id, []).append(q)
        return q

    def unsubscribe(self, batch_id: UUID, q: asyncio.Queue[str]) -> None:
        subs = self._subscribers.get(batch_id)
        if subs and q in subs:
            subs.remove(q)

    async def _emit(self, batch_id: UUID, event: str, payload: dict[str, Any]) -> None:
        data = json.dumps(
            {
                "event": event,
                "batch_id": str(batch_id),
                "timestamp": datetime.now(UTC).isoformat(),
                "payload": payload,
            },
            ensure_ascii=False,
        )
        self._history.setdefault(
            batch_id, deque(maxlen=_BATCH_EVENT_BUFFER_SIZE)
        ).append(data)
        for q in self._subscribers.get(batch_id, []):
            await q.put(data)

    async def start(self, batch_id: UUID, payload: TopicBatchIn) -> None:
        self._tasks[batch_id] = asyncio.create_task(self._run(batch_id, payload))

    async def cancel(self, batch_id: UUID) -> None:
        """Stop any in-flight generation task for this batch and drop its state.

        Mirrors ``RunExecutor.cancel`` — used before a hard-delete so the graph
        isn't still writing candidate rows that are about to be removed. Safe to
        call when there is no live task.
        """
        task = self._tasks.pop(batch_id, None)
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception(
                    "error awaiting cancelled batch task", extra={"batch_id": str(batch_id)}
                )
        try:
            async with make_checkpointer(self._postgres_url) as cp:
                await cp.adelete_thread(str(batch_id))
        except Exception:
            logger.exception(
                "failed to delete batch checkpoint thread", extra={"batch_id": str(batch_id)}
            )
        self._history.pop(batch_id, None)
        self._subscribers.pop(batch_id, None)

    async def _run(self, batch_id: UUID, payload: TopicBatchIn) -> None:
        try:
            async with make_checkpointer(self._postgres_url) as cp:
                graph: Any = build_topic_expansion_graph(  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType]
                    session_factory=self._sf, gemini=self._gemini
                ).compile(checkpointer=cp)
                config: Any = {"configurable": {"thread_id": str(batch_id)}}
                initial: dict[str, Any] = {
                    "batch_id": str(batch_id),
                    "input": {
                        "research_theme": payload.research_theme,
                        "target_audience": payload.target_audience,
                        "topic_count": payload.topic_count,
                        "keywords_per_topic": payload.keywords_per_topic,
                        "must_cover": payload.must_cover,
                        "must_avoid": payload.must_avoid,
                        "priority_focus": payload.priority_focus,
                        "notes": payload.notes,
                    },
                }
                async for ns, chunk in graph.astream(
                    initial, config=config, stream_mode="updates", subgraphs=True
                ):
                    ns_list: list[str] = list(ns) if ns else []
                    prefix: list[str] = [n.split(":", 1)[0] for n in ns_list]
                    chunk_dict: dict[str, Any] = chunk
                    for node_name in chunk_dict:
                        if node_name.startswith("__"):
                            continue
                        label = ".".join([*prefix, node_name, "done"])
                        await self._emit(batch_id, label, {})
                await self._emit(batch_id, "graph.completed", {})
        except Exception as e:
            logger.exception(
                "topic-batch runner crashed", extra={"batch_id": str(batch_id)}
            )
            await self._emit(batch_id, "graph.error", {"message": str(e)})
            try:
                async with self._sf() as session:
                    await session.execute(
                        update(TopicBatch)
                        .where(TopicBatch.batch_id == batch_id)
                        .values(status="failed", last_error=str(e))
                    )
                    await session.commit()
            except Exception:
                logger.exception("failed to persist failed batch status")


async def _batch_sse_stream(
    executor: TopicBatchExecutor, batch_id: UUID
) -> AsyncIterator[dict[str, str]]:
    q = executor.subscribe(batch_id)
    try:
        while True:
            data = await q.get()
            yield {"event": "message", "data": data}
    finally:
        executor.unsubscribe(batch_id, q)


def _batch_to_out(batch: TopicBatch) -> TopicBatchOut:
    return TopicBatchOut(
        batch_id=batch.batch_id,
        status=batch.status,  # type: ignore[arg-type]
        created_by=batch.created_by,
        created_at=batch.created_at,
        updated_at=batch.updated_at,
        research_theme=batch.research_theme,
        target_audience=batch.target_audience,
        topic_count=batch.topic_count,
        keywords_per_topic=batch.keywords_per_topic,
        must_cover=list(batch.must_cover or []),
        must_avoid=list(batch.must_avoid or []),
        priority_focus=batch.priority_focus,
        notes=batch.notes,
        persona_default=batch.persona_default,
        acf_adv_id_default=batch.acf_adv_id_default,
        acf_widget_id_default=batch.acf_widget_id_default,
        cost_cents=batch.cost_cents,
        last_error=batch.last_error,
    )


def _candidate_to_out(row: TopicCandidate) -> TopicCandidateOut:
    return TopicCandidateOut(
        candidate_id=row.candidate_id,
        batch_id=row.batch_id,
        position=row.position,
        status=row.status,  # type: ignore[arg-type]
        topic=row.topic,
        keywords=list(row.keywords or []),
        original_topic=row.original_topic,
        original_keywords=list(row.original_keywords or []),
        existing=row.existing,  # type: ignore[arg-type]
        existing_note=row.existing_note,
        existing_url=row.existing_url,
        hot_topic=row.hot_topic,  # type: ignore[arg-type]
        hot_topic_note=row.hot_topic_note,
        persona_slug=row.persona_slug,
        acf_adv_id=row.acf_adv_id,
        acf_widget_id=row.acf_widget_id,
        operator_note=row.operator_note,
        promote_mode=row.promote_mode,  # type: ignore[arg-type]
        promoted_run_id=row.promoted_run_id,
        last_error=row.last_error,
        last_edited_by=row.last_edited_by,
        last_edited_at=row.last_edited_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _load_batch_or_404(session: AsyncSession, batch_id: UUID) -> TopicBatch:
    row = (
        await session.execute(
            select(TopicBatch).where(TopicBatch.batch_id == batch_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="topic batch not found")
    return row


async def _recompute_batch_status(session: AsyncSession, batch_id: UUID) -> str:
    """``done`` iff every candidate is ``promoted``/``skipped`` — else ``partially_promoted``."""
    rows = (
        await session.execute(
            select(TopicCandidate.status).where(TopicCandidate.batch_id == batch_id)
        )
    ).all()
    statuses = {r[0] for r in rows}
    if statuses and statuses.issubset({"promoted", "skipped"}):
        new_status = "done"
    else:
        new_status = "partially_promoted"
    await session.execute(
        update(TopicBatch).where(TopicBatch.batch_id == batch_id).values(status=new_status)
    )
    return new_status


@router.post("", response_model=TopicBatchCreateResponse)
async def create_topic_batch(
    payload: TopicBatchIn,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
    executor: TopicBatchExecutor = Depends(get_batch_executor),  # noqa: B008
) -> TopicBatchCreateResponse:
    """Insert a ``topic_batches`` row and kick off the topic-expansion graph."""
    async with sf() as session:
        batch = TopicBatch(
            created_by=payload.editor_email,
            status="pending",
            research_theme=payload.research_theme,
            target_audience=payload.target_audience,
            topic_count=payload.topic_count,
            keywords_per_topic=payload.keywords_per_topic,
            must_cover=list(payload.must_cover),
            must_avoid=list(payload.must_avoid),
            priority_focus=payload.priority_focus,
            notes=payload.notes,
            persona_default=payload.persona_default,
            acf_adv_id_default=payload.acf_adv_id_default,
            acf_widget_id_default=payload.acf_widget_id_default,
        )
        session.add(batch)
        await session.flush()
        batch_id = batch.batch_id
        await session.commit()

    await executor.start(batch_id, payload)
    return TopicBatchCreateResponse(batch_id=batch_id, status="pending")


@router.get("", response_model=list[TopicBatchOut])
async def list_topic_batches(
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[TopicBatchOut]:
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=422, detail="limit must be in [1, 200]")
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be >= 0")
    async with sf() as session:
        q = select(TopicBatch)
        if status:
            q = q.where(TopicBatch.status == status)
        q = q.order_by(TopicBatch.created_at.desc()).limit(limit).offset(offset)
        rows = (await session.execute(q)).scalars().all()
        return [_batch_to_out(r) for r in rows]


@router.get("/{batch_id}", response_model=TopicBatchOut)
async def get_topic_batch(
    batch_id: UUID,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> TopicBatchOut:
    async with sf() as session:
        batch = await _load_batch_or_404(session, batch_id)
        cands = (
            await session.execute(
                select(TopicCandidate)
                .where(TopicCandidate.batch_id == batch_id)
                .order_by(TopicCandidate.position.asc())
            )
        ).scalars().all()
    out = _batch_to_out(batch)
    out.candidates = [_candidate_to_out(c) for c in cands]
    return out


@router.get("/{batch_id}/events")
async def topic_batch_events(
    batch_id: UUID,
    executor: TopicBatchExecutor = Depends(get_batch_executor),  # noqa: B008
) -> EventSourceResponse:
    return EventSourceResponse(_batch_sse_stream(executor, batch_id))


@router.patch(
    "/{batch_id}/candidates/{candidate_id}", response_model=TopicCandidateOut
)
async def patch_candidate(
    batch_id: UUID,
    candidate_id: UUID,
    payload: PatchCandidateIn,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> TopicCandidateOut:
    """Partial-update a candidate row.

    409 if the parent batch is in a terminal state. Stamps ``last_edited_by``
    / ``last_edited_at`` whenever any editable field was passed in the body.
    """
    async with sf() as session:
        batch = await _load_batch_or_404(session, batch_id)
        if batch.status in _TERMINAL_STATUSES:
            raise HTTPException(
                status_code=409,
                detail=f"batch is in terminal status '{batch.status}'",
            )
        cand = (
            await session.execute(
                select(TopicCandidate).where(
                    TopicCandidate.candidate_id == candidate_id,
                    TopicCandidate.batch_id == batch_id,
                )
            )
        ).scalar_one_or_none()
        if cand is None:
            raise HTTPException(status_code=404, detail="candidate not found")

        provided = payload.model_dump(exclude_unset=True, exclude={"editor_email"})
        if provided:
            for key, value in provided.items():
                setattr(cand, key, value)
            cand.last_edited_by = payload.editor_email
            cand.last_edited_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(cand)
        return _candidate_to_out(cand)


@router.post("/{batch_id}/promote", response_model=PromoteResponse)
async def promote_candidates(
    batch_id: UUID,
    payload: PromoteRequest,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
    runner: Any = Depends(get_runner),  # noqa: ANN401, B008
) -> PromoteResponse:
    """Dispatch one ``runs`` row per promotion item and update candidates.

    Atomic validation: if ANY promotion can't be dispatched, the whole
    request is rejected (422) before a single run is created.
    """
    async with sf() as session:
        batch = await _load_batch_or_404(session, batch_id)
        if batch.status == "failed":
            raise HTTPException(
                status_code=409,
                detail="cannot promote candidates from a failed batch",
            )
        if batch.status in _TERMINAL_STATUSES:  # "done" only at this point
            raise HTTPException(
                status_code=409,
                detail=f"batch is in terminal status '{batch.status}'",
            )

        candidate_ids = [p.candidate_id for p in payload.promotions]
        rows = (
            await session.execute(
                select(TopicCandidate).where(
                    TopicCandidate.batch_id == batch_id,
                    TopicCandidate.candidate_id.in_(candidate_ids),
                )
            )
        ).scalars().all()
        by_id = {r.candidate_id: r for r in rows}

        missing = [cid for cid in candidate_ids if cid not in by_id]
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"candidate(s) not in this batch: {[str(m) for m in missing]}",
            )
        for item in payload.promotions:
            cand = by_id[item.candidate_id]
            if cand.existing is None or cand.hot_topic is None:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"candidate {cand.candidate_id} is not yet analysed "
                        "(existing/hot_topic still NULL)"
                    ),
                )
            if cand.status in ("promoted", "skipped"):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"candidate {cand.candidate_id} already resolved "
                        f"(status={cand.status})"
                    ),
                )
            if item.mode == "refresh" and not (cand.existing_url or "").strip():
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"candidate {cand.candidate_id} cannot be promoted "
                        "in refresh mode: existing_url is blank"
                    ),
                )

        results: list[PromoteResponseItem] = []
        for item in payload.promotions:
            cand = by_id[item.candidate_id]
            persona = cand.persona_slug or batch.persona_default or "bowtie-editor"
            # Null-aware: a candidate with no acf id inherits the batch default,
            # but an explicit 0 ("no element") is honoured, not overridden.
            adv_id = cand.acf_adv_id if cand.acf_adv_id is not None else batch.acf_adv_id_default
            adv_id = adv_id if adv_id is not None else 0
            widget_id = (
                cand.acf_widget_id
                if cand.acf_widget_id is not None
                else batch.acf_widget_id_default
            )
            widget_id = widget_id if widget_id is not None else 0
            run_payload_kwargs: dict[str, Any] = {
                "topic": cand.topic,
                "keywords": list(cand.keywords or []),
                "mode": "auto",
                "acf_adv_id": adv_id,
                "acf_widget_id": widget_id,
                "persona": persona,
                "editor_email": payload.editor_email,
                "start_mode": item.mode,
                "topic_candidate_id": cand.candidate_id,
                "target_audience": batch.target_audience,
                "edit_note": (cand.operator_note or "").strip() or None,
            }
            if item.mode == "refresh":
                run_payload_kwargs["article_url"] = cand.existing_url
            run_payload = CreateRunRequest(**run_payload_kwargs)
            row = await create_run_row(session, run_payload)
            cand.promoted_run_id = row.run_id
            cand.promote_mode = item.mode
            cand.status = "promoted"
            results.append(
                PromoteResponseItem(
                    candidate_id=cand.candidate_id, run_id=row.run_id, mode=item.mode
                )
            )

        new_status = await _recompute_batch_status(session, batch_id)
        await session.commit()

    for item in results:
        await runner.start(item.run_id)

    return PromoteResponse(items=results, batch_status=new_status)  # type: ignore[arg-type]


@router.post(
    "/{batch_id}/candidates/{candidate_id}/skip", response_model=TopicCandidateOut
)
async def skip_candidate(
    batch_id: UUID,
    candidate_id: UUID,
    payload: SkipCandidateRequest,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> TopicCandidateOut:
    async with sf() as session:
        batch = await _load_batch_or_404(session, batch_id)
        if batch.status in _TERMINAL_STATUSES:
            raise HTTPException(
                status_code=409,
                detail=f"batch is in terminal status '{batch.status}'",
            )
        cand = (
            await session.execute(
                select(TopicCandidate).where(
                    TopicCandidate.candidate_id == candidate_id,
                    TopicCandidate.batch_id == batch_id,
                )
            )
        ).scalar_one_or_none()
        if cand is None:
            raise HTTPException(status_code=404, detail="candidate not found")
        if cand.status in ("promoted", "skipped"):
            raise HTTPException(
                status_code=409,
                detail=f"candidate already resolved (status={cand.status})",
            )
        cand.status = "skipped"
        cand.last_edited_by = payload.editor_email
        cand.last_edited_at = datetime.now(UTC)
        await _recompute_batch_status(session, batch_id)
        await session.commit()
        await session.refresh(cand)
        return _candidate_to_out(cand)


@router.delete("/{batch_id}")
async def delete_topic_batch(
    batch_id: UUID,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
    executor: TopicBatchExecutor = Depends(get_batch_executor),  # noqa: B008
) -> dict[str, bool]:
    """Hard-delete a topic batch and its candidates.

    Candidates fall away via ``ON DELETE CASCADE``. Runs promoted from this
    batch are *kept* — their soft back-reference ``runs.topic_candidate_id`` is
    cleared first so the candidate rows can be removed without violating the FK.
    Any in-flight generation task is cancelled before the rows are touched.
    """
    from sqlalchemy import delete

    from content_tool.db.models import Run

    # Stop the generator before touching rows — no-op when there's no live task.
    await executor.cancel(batch_id)

    async with sf() as session:
        await _load_batch_or_404(session, batch_id)
        candidate_ids = select(TopicCandidate.candidate_id).where(
            TopicCandidate.batch_id == batch_id
        )
        await session.execute(
            update(Run)
            .where(Run.topic_candidate_id.in_(candidate_ids))
            .values(topic_candidate_id=None)
        )
        await session.execute(delete(TopicBatch).where(TopicBatch.batch_id == batch_id))
        await session.commit()
    return {"ok": True}


@router.post("/{batch_id}/close", response_model=TopicBatchOut)
async def close_batch(
    batch_id: UUID,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> TopicBatchOut:
    async with sf() as session:
        batch = await _load_batch_or_404(session, batch_id)
        if batch.status in _TERMINAL_STATUSES:
            raise HTTPException(
                status_code=409,
                detail=f"batch already terminal (status={batch.status})",
            )
        batch.status = "done"
        await session.commit()
        await session.refresh(batch)
        return _batch_to_out(batch)
