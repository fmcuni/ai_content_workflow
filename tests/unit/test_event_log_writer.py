"""Unit tests for ``RunEventLogWriter`` behaviour that does not need a real DB.

A fake session factory captures the rows the writer would INSERT so we can
assert seq monotonicity, PERSIST_THINKING gating, and duration_ms matching
without touching Postgres. The writer's SQL is exercised separately in the
integration suite.
"""

import asyncio
from typing import Any

import pytest

from content_tool.observability.event_log import RunEventLogWriter

_STREAM = "11111111-1111-1111-1111-111111111111"
_STREAM_B = "22222222-2222-2222-2222-222222222222"


class _FakeResult:
    def __init__(self, value: Any) -> None:
        self._value = value

    def scalar_one(self) -> Any:
        return self._value


class _FakeSession:
    """Captures executed statements; seeds MAX(seq) as -1 (empty stream)."""

    def __init__(self, sink: list[dict[str, Any]]) -> None:
        self._sink = sink

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(
        self, exc_type: object, exc_val: object, exc_tb: object
    ) -> None:
        return None

    async def execute(self, stmt: Any, params: Any = None) -> _FakeResult:
        sql = str(stmt)
        # The seq-seed SELECT returns COALESCE(MAX(seq), -1) = -1 for an empty
        # stream; the bulk INSERT carries the row dicts as a list param.
        if "INSERT" in sql and isinstance(params, list):
            self._sink.extend(params)
            return _FakeResult(None)
        return _FakeResult(-1)

    async def commit(self) -> None:
        return None


def _make_factory(sink: list[dict[str, Any]]):
    def _factory() -> _FakeSession:
        return _FakeSession(sink)

    return _factory


def _envelope(event: str, timestamp: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "event": event,
        "stream_id": _STREAM,
        "timestamp": timestamp,
        "payload": payload or {},
    }


@pytest.mark.asyncio
async def test_seq_monotonic_from_zero() -> None:
    sink: list[dict[str, Any]] = []
    writer = RunEventLogWriter(_make_factory(sink))
    for ev, ts in [
        ("strategy.fetch_article.start", "2026-06-03T00:00:00Z"),
        ("strategy.fetch_article.done", "2026-06-03T00:00:01Z"),
        ("graph.completed", "2026-06-03T00:00:02Z"),
    ]:
        writer.enqueue(_STREAM, "run", _envelope(ev, ts))
    await writer.flush()

    seqs = [r["seq"] for r in sink]
    assert seqs == [0, 1, 2]


@pytest.mark.asyncio
async def test_persist_thinking_off_drops_thinking(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PERSIST_THINKING", "off")
    sink: list[dict[str, Any]] = []
    writer = RunEventLogWriter(_make_factory(sink))
    writer.enqueue(_STREAM, "run", _envelope("writer.thinking", "2026-06-03T00:00:00Z"))
    writer.enqueue(_STREAM, "run", _envelope("production.writer.done", "2026-06-03T00:00:01Z"))
    await writer.flush()

    events = [r["event"] for r in sink]
    assert events == ["production.writer.done"]


@pytest.mark.asyncio
async def test_persist_thinking_on_keeps_thinking(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PERSIST_THINKING", "1")
    sink: list[dict[str, Any]] = []
    writer = RunEventLogWriter(_make_factory(sink))
    writer.enqueue(_STREAM, "run", _envelope("writer.thinking", "2026-06-03T00:00:00Z"))
    await writer.flush()

    assert [r["event"] for r in sink] == ["writer.thinking"]
    assert sink[0]["level"] == "thinking"


@pytest.mark.asyncio
async def test_duration_ms_computed_on_done() -> None:
    sink: list[dict[str, Any]] = []
    writer = RunEventLogWriter(_make_factory(sink))
    writer.enqueue(
        _STREAM, "run", _envelope("production.writer.start", "2026-06-03T00:00:00Z")
    )
    writer.enqueue(
        _STREAM, "run", _envelope("production.writer.done", "2026-06-03T00:00:02.500Z")
    )
    await writer.flush()

    by_event = {r["event"]: r for r in sink}
    assert by_event["production.writer.start"]["duration_ms"] is None
    assert by_event["production.writer.done"]["duration_ms"] == 2500


class _SlowSession(_FakeSession):
    """Like ``_FakeSession`` but yields control between the seq-seed SELECT and
    the INSERT so that two concurrent ``flush()`` calls actually interleave,
    surfacing any race on the writer's shared ``_seq`` dict.
    """

    async def execute(self, stmt: Any, params: Any = None) -> _FakeResult:
        await asyncio.sleep(0)
        return await super().execute(stmt, params)


@pytest.mark.asyncio
async def test_concurrent_flushes_keep_seq_monotonic_per_stream() -> None:
    """Two flush() calls racing on one shared writer must not corrupt seq.

    Events for two distinct streams are enqueued, then two concurrent flushes
    are driven via ``asyncio.gather``. Per stream the persisted ``seq`` values
    must be a contiguous monotonic run from 0 with no duplicates, and no
    exception must escape.
    """
    sink: list[dict[str, Any]] = []

    def _slow_factory() -> _SlowSession:
        return _SlowSession(sink)

    writer = RunEventLogWriter(_slow_factory)

    total_per_stream = 25
    for i in range(total_per_stream):
        ts = f"2026-06-03T00:00:{i:02d}Z"
        writer.enqueue(_STREAM, "run", _envelope(f"strategy.step{i}.start", ts))
        writer.enqueue(_STREAM_B, "run", _envelope(f"strategy.step{i}.start", ts))

    await asyncio.gather(writer.flush(), writer.flush())

    for stream in (_STREAM, _STREAM_B):
        seqs = sorted(r["seq"] for r in sink if r["stream_id"] == stream)
        assert seqs == list(range(total_per_stream)), (
            f"stream {stream} seq corrupted: {seqs}"
        )
