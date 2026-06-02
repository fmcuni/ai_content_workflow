"""Verbose, persisted per-step event log.

Every SSE event that flows through a run/batch emit choke point is mirrored
into ``content_tool.run_event_logs`` so a finished or failed stream can be
debugged after the fact (the live SSE history is in-memory only and lost on
restart).

This module owns two things:

1. The PURE derivation helpers (``derive_step``, ``derive_level``,
   ``cap_payload``, ``derive_duration_ms``) that turn an SSE envelope into a
   table row. They are unit-tested directly and MUST stay byte-compatible with
   the Workers-native port (the frontend reads the same row shape from both).
2. ``RunEventLogWriter`` — an async, batched, fire-and-forget writer. It is a
   pure side-channel: a DB failure is logged and the row dropped, never raised
   into the emit path, so persistence can never break streaming.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, cast
from uuid import uuid4

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = structlog.get_logger(__name__)

# Event-string verbs whose trailing segment is a lifecycle marker, not a step
# name. ``segments[:-1][-1]`` then yields the step.
_VERBS: frozenset[str] = frozenset(
    {"start", "done", "error", "thinking", "completed", "interrupted"}
)

# Payload size guards (bytes). Mirror the Workers port exactly.
MAX_BYTES = 16384
MAX_FIELD = 2048

# Batched-write tuning.
_FLUSH_THRESHOLD = 50
_FLUSH_INTERVAL_S = 0.5

SessionFactory = Callable[[], Any]


def derive_step(event: str) -> str | None:
    """Derive the ``step`` column from an event string per the shared contract."""
    segments = event.split(".")
    if segments and segments[-1] in _VERBS:
        return segments[:-1][-1] if len(segments) > 1 else None
    return segments[-1] if segments else None


def derive_level(event: str) -> str:
    """Derive the ``level`` column from an event string per the shared contract."""
    if event.endswith(".thinking"):
        return "thinking"
    if event.endswith(".error") or event == "graph.error":
        return "error"
    if event == "hitl.interrupted" or event.endswith(".gate"):
        return "gate"
    return "info"


def cap_payload(
    payload: dict[str, Any],
    max_bytes: int = MAX_BYTES,
    max_field: int = MAX_FIELD,
) -> dict[str, Any]:
    """Bound a payload's serialized size.

    Three tiers: return unchanged if it already fits; else truncate any oversize
    string field to a ``{_truncated, _bytes}`` stub; if that still overflows,
    collapse to a single summary stub. Mirrors the Workers port exactly.
    """
    if len(json.dumps(payload).encode()) <= max_bytes:
        return payload

    capped: dict[str, Any] = {}
    for key, value in payload.items():
        if isinstance(value, str) and len(value.encode()) > max_field:
            capped[key] = {"_truncated": True, "_bytes": len(value.encode())}
        else:
            capped[key] = value

    if len(json.dumps(capped).encode()) <= max_bytes:
        return capped

    return {
        "_truncated": True,
        "_bytes": len(json.dumps(payload).encode()),
        "_keys": sorted(payload.keys()),
    }


def derive_duration_ms(
    *,
    event: str,
    step: str | None,
    recorded_at_ms: float,
    last_start_ms: float | None,
) -> int | None:
    """Milliseconds between a ``.done`` event and the most recent matching
    ``.start`` for the same ``(stream_id, step)``.

    Only ``.done`` events carry a duration; everything else (incl. ``.start``
    and ``.thinking``) is ``None``. Returns ``None`` when no matching start was
    seen.
    """
    if not event.endswith(".done"):
        return None
    if last_start_ms is None:
        return None
    return round(recorded_at_ms - last_start_ms)


def persist_thinking_enabled() -> bool:
    """Read the ``PERSIST_THINKING`` toggle (default ON)."""
    raw = os.environ.get("PERSIST_THINKING")
    if raw is None:
        return True
    return raw.strip().lower() in ("1", "true", "on")


def _parse_timestamp_ms(value: object) -> float:
    """Parse an ISO-8601 envelope timestamp into epoch milliseconds.

    Accepts a trailing ``Z`` (RunExecutor emits ``...isoformat() + "Z"``) and
    falls back to ``now`` for an unparseable/missing value so a malformed
    timestamp never blocks persistence.
    """
    if isinstance(value, str) and value:
        normalized = value.replace("Z", "+00:00") if value.endswith("Z") else value
        try:
            return datetime.fromisoformat(normalized).timestamp() * 1000.0
        except ValueError:
            pass
    return datetime.now(UTC).timestamp() * 1000.0


_INSERT_SQL = text(
    """
    INSERT INTO content_tool.run_event_logs
        (log_id, stream_id, stream_kind, seq, event, level, step,
         iteration, duration_ms, payload, recorded_at)
    VALUES
        (:log_id, :stream_id, :stream_kind, :seq, :event, :level, :step,
         :iteration, :duration_ms, CAST(:payload AS jsonb), :recorded_at)
    """
)

_MAX_SEQ_SQL = text(
    "SELECT COALESCE(MAX(seq), -1) FROM content_tool.run_event_logs "
    "WHERE stream_id = CAST(:stream_id AS uuid)"
)


class RunEventLogWriter:
    """Async, batched, fire-and-forget event-log writer.

    Rows are enqueued non-blockingly; a background drain task bulk-inserts when
    the queue reaches ``_FLUSH_THRESHOLD`` or every ``_FLUSH_INTERVAL_S``. Per
    stream the ``seq`` counter is seeded lazily from
    ``COALESCE(MAX(seq), -1) + 1``. A ``.start`` event's recorded time is
    tracked per ``(stream_id, step)`` so the matching ``.done`` can compute
    ``duration_ms``.
    """

    def __init__(self, session_factory: SessionFactory) -> None:
        self._sf = session_factory
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._seq: dict[str, int] = {}
        self._last_start_ms: dict[tuple[str, str], float] = {}
        self._task: asyncio.Task[None] | None = None
        # Serializes flush()/_write_batch so the background drain task and a
        # run's finally-flush cannot race on the shared _seq / _last_start_ms
        # dicts (one writer instance is shared across all concurrent runs).
        # Created lazily so it binds to the running loop, not import-time.
        self._flush_lock: asyncio.Lock | None = None

    def _get_flush_lock(self) -> asyncio.Lock:
        if self._flush_lock is None:
            self._flush_lock = asyncio.Lock()
        return self._flush_lock

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        """Start the background drain task (idempotent)."""
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._drain_loop())

    async def aclose(self) -> None:
        """Flush remaining rows and stop the drain task."""
        await self.flush()
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    # Alias kept for callers that expect ``close`` (parity with other writers).
    async def close(self) -> None:
        await self.aclose()

    # -- enqueue -----------------------------------------------------------
    def enqueue(self, stream_id: str, stream_kind: str, event_envelope: dict[str, Any]) -> None:
        """Non-blocking enqueue of one SSE envelope for persistence.

        Respects ``PERSIST_THINKING``: a thinking event is dropped here when the
        toggle is off (it is still streamed live by the caller). Any error in
        building/queuing the row is swallowed — persistence must never break the
        emit path.
        """
        try:
            event = str(event_envelope.get("event", ""))
            level = derive_level(event)
            if level == "thinking" and not persist_thinking_enabled():
                return
            self._queue.put_nowait(
                {
                    "stream_id": stream_id,
                    "stream_kind": stream_kind,
                    "event": event,
                    "level": level,
                    "envelope": event_envelope,
                }
            )
        except Exception:
            logger.warning("event_log_enqueue_failed", event=event_envelope.get("event"))

    # -- draining ----------------------------------------------------------
    async def _drain_loop(self) -> None:
        while True:
            await asyncio.sleep(_FLUSH_INTERVAL_S)
            if not self._queue.empty():
                await self.flush()

    async def flush(self) -> None:
        """Drain everything currently queued and bulk-insert it.

        Guarded by ``_flush_lock`` so the background drain and a run's
        finally-flush serialize their access to the shared ``_seq`` /
        ``_last_start_ms`` state. DB errors are logged and the batch dropped —
        never raised into the caller.
        """
        async with self._get_flush_lock():
            batch: list[dict[str, Any]] = []
            while not self._queue.empty():
                try:
                    batch.append(self._queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            if not batch:
                return
            try:
                await self._write_batch(batch)
            except Exception:
                logger.warning("event_log_flush_failed", count=len(batch))

    async def _seed_seq(self, session: AsyncSession, stream_id: str) -> None:
        if stream_id in self._seq:
            return
        result = await session.execute(_MAX_SEQ_SQL, {"stream_id": stream_id})
        max_seq = result.scalar_one()
        self._seq[stream_id] = int(max_seq) + 1

    async def _write_batch(self, batch: list[dict[str, Any]]) -> None:
        rows: list[dict[str, Any]] = []
        async with self._sf() as session:
            for item in batch:
                stream_id = item["stream_id"]
                await self._seed_seq(session, stream_id)
                rows.append(self._build_row(item))
            await session.execute(_INSERT_SQL, rows)
            await session.commit()

    def _build_row(self, item: dict[str, Any]) -> dict[str, Any]:
        stream_id: str = item["stream_id"]
        event: str = item["event"]
        envelope: dict[str, Any] = item["envelope"]
        step = derive_step(event)
        recorded_at_ms = _parse_timestamp_ms(envelope.get("timestamp"))

        last_start = self._last_start_ms.get((stream_id, step)) if step else None
        duration_ms = derive_duration_ms(
            event=event,
            step=step,
            recorded_at_ms=recorded_at_ms,
            last_start_ms=last_start,
        )
        if event.endswith(".start") and step is not None:
            self._last_start_ms[(stream_id, step)] = recorded_at_ms

        iteration = envelope.get("iteration")
        raw_payload = envelope.get("payload")
        payload: dict[str, Any] = (
            cast("dict[str, Any]", raw_payload) if isinstance(raw_payload, dict) else {}
        )
        seq = self._seq[stream_id]
        self._seq[stream_id] = seq + 1

        return {
            "log_id": str(uuid4()),
            "stream_id": stream_id,
            "stream_kind": item["stream_kind"],
            "seq": seq,
            "event": event,
            "level": item["level"],
            "step": step,
            "iteration": int(iteration) if isinstance(iteration, int) else None,
            "duration_ms": duration_ms,
            "payload": json.dumps(cap_payload(payload), ensure_ascii=False),
            "recorded_at": datetime.fromtimestamp(recorded_at_ms / 1000.0),
        }


# Emitter ContextVar -------------------------------------------------------
# Mirrors ``content_tool.gemini.streaming.set_thought_emitter`` so a node
# wrapper can emit lifecycle events (``*.start`` / ``*.error``) through whatever
# transport the executor bound, without threading the executor through the graph.
EventEmitter = Callable[[str, dict[str, Any]], Awaitable[None]]

_event_emitter: ContextVar[EventEmitter | None] = ContextVar(
    "content_tool_event_emitter", default=None
)


def set_event_emitter(emitter: EventEmitter | None) -> None:
    _event_emitter.set(emitter)


def get_event_emitter() -> EventEmitter | None:
    return _event_emitter.get()


def logged_node[NodeFn: Callable[..., Awaitable[dict[str, Any]]]](
    phase: str,
    name: str,
    node: NodeFn,
) -> NodeFn:
    """Wrap a LangGraph node coroutine to emit lifecycle markers.

    Emits ``f"{phase}.{name}.start"`` before running ``node`` and, on exception,
    ``f"{phase}.{name}.error"`` with ``{error_type, message}`` before re-raising.
    The existing ``*.done`` events (driven by the astream updates loop in the
    executor) are intentionally left intact.

    The wrapper is typed to return the SAME callable type it received so the
    graph builders' ``add_node`` calls typecheck exactly as they did before
    (the wrapper is transparent to pyright).
    """

    async def _wrapped(state: object) -> dict[str, Any]:
        emitter = get_event_emitter()
        if emitter is not None:
            await emitter(f"{phase}.{name}.start", {})
        try:
            return await node(state)
        except Exception as exc:
            if emitter is not None:
                await emitter(
                    f"{phase}.{name}.error",
                    {"error_type": type(exc).__name__, "message": str(exc)},
                )
            raise

    return cast("NodeFn", _wrapped)
