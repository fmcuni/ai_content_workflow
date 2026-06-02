"""Integration tests for the persisted verbose event log.

Covers the ``RunEventLogWriter`` inserting against a real DB, the
``GET /runs/{id}/logs`` read API (ordering, since_seq, level filter), and that
deleting a run removes its logs.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from content_tool.api.main import create_app
from content_tool.observability.event_log import RunEventLogWriter


def _envelope(event: str, *, seconds: int, payload: dict | None = None) -> dict:
    ts = datetime(2026, 6, 3, 0, 0, seconds, tzinfo=UTC).isoformat()
    return {"event": event, "timestamp": ts, "payload": payload or {}}


async def _seed_run(sf, run_id: uuid.UUID) -> None:
    async with sf() as session:
        await session.execute(
            text(
                """
                INSERT INTO content_tool.runs
                    (run_id, created_by, status, topic, keywords, mode,
                     acf_adv_id, acf_widget_id, persona, today_date, start_mode)
                VALUES
                    (:rid, 'tester@test', 'pending', 't', '["k"]'::jsonb,
                     'small_refresh', 1, 2, 'p', CURRENT_DATE, 'create')
                """
            ),
            {"rid": str(run_id)},
        )
        await session.commit()


async def test_writer_inserts_rows(pg_session_factory) -> None:
    run_id = uuid.uuid4()
    await _seed_run(pg_session_factory, run_id)

    writer = RunEventLogWriter(pg_session_factory)
    writer.enqueue(str(run_id), "run", _envelope("strategy.fetch_article.start", seconds=0))
    writer.enqueue(str(run_id), "run", _envelope("strategy.fetch_article.done", seconds=2))
    writer.enqueue(str(run_id), "run", _envelope("graph.completed", seconds=3))
    await writer.flush()

    async with pg_session_factory() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT seq, event, level, step, duration_ms "
                    "FROM content_tool.run_event_logs "
                    "WHERE stream_id = :rid ORDER BY seq"
                ),
                {"rid": str(run_id)},
            )
        ).all()

    assert [r.seq for r in rows] == [0, 1, 2]
    assert rows[0].event == "strategy.fetch_article.start"
    assert rows[0].step == "fetch_article"
    assert rows[1].duration_ms == 2000  # start@0s -> done@2s
    assert rows[2].level == "info"


async def test_get_logs_ordering_since_seq_and_level(
    api_client, pg_session_factory
) -> None:
    run_id = uuid.uuid4()
    await _seed_run(pg_session_factory, run_id)

    writer = RunEventLogWriter(pg_session_factory)
    writer.enqueue(str(run_id), "run", _envelope("strategy.outline.start", seconds=0))
    writer.enqueue(str(run_id), "run", _envelope("strategy.outline.done", seconds=1))
    writer.enqueue(
        str(run_id), "run", _envelope("graph.error", seconds=2, payload={"message": "boom"})
    )
    await writer.flush()

    # Full list, ordered by seq ASC.
    resp = await api_client.get(f"/runs/{run_id}/logs")
    assert resp.status_code == 200
    body = resp.json()
    assert [e["seq"] for e in body] == [0, 1, 2]
    assert body[0]["event"] == "strategy.outline.start"

    # since_seq returns only seq > N.
    resp2 = await api_client.get(f"/runs/{run_id}/logs", params={"since_seq": 0})
    assert [e["seq"] for e in resp2.json()] == [1, 2]

    # level equality filter.
    resp3 = await api_client.get(f"/runs/{run_id}/logs", params={"level": "error"})
    err = resp3.json()
    assert len(err) == 1
    assert err[0]["event"] == "graph.error"
    assert err[0]["level"] == "error"

    # A valid level returns 200; an unknown level is rejected with 400.
    resp_ok = await api_client.get(f"/runs/{run_id}/logs", params={"level": "info"})
    assert resp_ok.status_code == 200
    resp_bad = await api_client.get(f"/runs/{run_id}/logs", params={"level": "bogus"})
    assert resp_bad.status_code == 400


async def test_delete_run_removes_logs(pg_session_factory) -> None:
    run_id = uuid.uuid4()
    await _seed_run(pg_session_factory, run_id)

    writer = RunEventLogWriter(pg_session_factory)
    writer.enqueue(str(run_id), "run", _envelope("graph.completed", seconds=0))
    await writer.flush()

    # The DELETE route cancels the run's executor first; a no-op stub avoids
    # touching the real checkpointer/Gemini wiring in this focused test.
    class _StubRunner:
        async def cancel(self, _run_id: uuid.UUID) -> None:
            return None

    app = create_app()
    app.state.session_factory = pg_session_factory
    app.state.run_executor = _StubRunner()

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        # Pre-condition: a row exists.
        pre = await client.get(f"/runs/{run_id}/logs")
        assert len(pre.json()) == 1

        resp = await client.delete(f"/runs/{run_id}")
        assert resp.status_code == 200

    async with pg_session_factory() as session:
        remaining = (
            await session.execute(
                text(
                    "SELECT count(*) FROM content_tool.run_event_logs "
                    "WHERE stream_id = :rid"
                ),
                {"rid": str(run_id)},
            )
        ).scalar_one()
    assert remaining == 0
