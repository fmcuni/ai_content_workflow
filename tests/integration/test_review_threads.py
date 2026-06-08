from datetime import date
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from content_tool.api.routes.runs import router as runs_router
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Run, RunEventLog


async def _seed_run(sf, run_id) -> None:
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="hitl_2",
            article_url="https://www.bowtie.com.hk/blog/x", topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 27),
        ))
        await s.commit()


def _make_app(sf) -> FastAPI:
    app = FastAPI()
    app.include_router(runs_router)
    app.state.session_factory = sf
    return app


@pytest.mark.asyncio
async def test_create_and_list_round_trip(postgres_url: str):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        created = await ac.post(
            f"/runs/{run_id}/review-threads",
            json={
                "anchor_id": "r-1",
                "anchor_text": "the lede",
                "body": "needs a citation",
                "editor_email": "ann@bowtie.com.hk",
                "editor_name": "Ann Editor",
            },
        )
        assert created.status_code == 200
        body = created.json()
        assert body["status"] == "open"
        assert body["anchor_id"] == "r-1"
        assert body["created_by"] == "ann@bowtie.com.hk"
        assert body["created_by_name"] == "Ann Editor"
        assert len(body["messages"]) == 1
        assert body["messages"][0]["body"] == "needs a citation"
        assert body["messages"][0]["author_name"] == "Ann Editor"

        listed = await ac.get(f"/runs/{run_id}/review-threads")

    assert listed.status_code == 200
    rows = listed.json()
    assert len(rows) == 1
    assert rows[0]["thread_id"] == body["thread_id"]
    await engine.dispose()


@pytest.mark.asyncio
async def test_create_404_for_missing_run(postgres_url: str):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    app = _make_app(sf)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{uuid4()}/review-threads",
            json={"anchor_id": "r-1", "body": "x"},
        )
    assert r.status_code == 404
    await engine.dispose()


@pytest.mark.asyncio
async def test_reply_appends_a_message(postgres_url: str):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        created = (await ac.post(
            f"/runs/{run_id}/review-threads",
            json={"anchor_id": "r-1", "body": "first", "editor_name": "Ann"},
        )).json()
        tid = created["thread_id"]
        replied = await ac.post(
            f"/runs/{run_id}/review-threads/{tid}/replies",
            json={"body": "second", "editor_email": "bob@bowtie.com.hk", "editor_name": "Bob"},
        )

    assert replied.status_code == 200
    msgs = replied.json()["messages"]
    assert [m["body"] for m in msgs] == ["first", "second"]
    assert msgs[1]["author_name"] == "Bob"
    await engine.dispose()


@pytest.mark.asyncio
async def test_reply_404_for_missing_thread(postgres_url: str):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{run_id}/review-threads/{uuid4()}/replies",
            json={"body": "x"},
        )
    assert r.status_code == 404
    await engine.dispose()


@pytest.mark.asyncio
async def test_resolve_and_reopen(postgres_url: str):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        tid = (await ac.post(
            f"/runs/{run_id}/review-threads",
            json={"anchor_id": "r-1", "body": "x"},
        )).json()["thread_id"]

        resolved = await ac.post(
            f"/runs/{run_id}/review-threads/{tid}/resolve",
            json={"resolved": True, "editor_email": "carol@bowtie.com.hk", "editor_name": "Carol"},
        )
        assert resolved.status_code == 200
        rbody = resolved.json()
        assert rbody["status"] == "resolved"
        assert rbody["resolved_by"] == "carol@bowtie.com.hk"
        assert rbody["resolved_by_name"] == "Carol"
        assert rbody["resolved_at"] is not None

        reopened = await ac.post(
            f"/runs/{run_id}/review-threads/{tid}/resolve",
            json={"resolved": False},
        )
        assert reopened.status_code == 200
        obody = reopened.json()
        assert obody["status"] == "open"
        assert obody["resolved_by"] is None
        assert obody["resolved_at"] is None

    # Resolve + reopen each write a run_event_logs audit breadcrumb.
    async with sf() as s:
        n = (await s.execute(
            select(func.count()).select_from(RunEventLog).where(
                RunEventLog.stream_id == run_id,
                RunEventLog.event.like("review.thread.%"),
            )
        )).scalar_one()
    assert n >= 2
    await engine.dispose()


@pytest.mark.asyncio
async def test_delete_removes_thread(postgres_url: str):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        tid = (await ac.post(
            f"/runs/{run_id}/review-threads",
            json={"anchor_id": "r-1", "body": "x"},
        )).json()["thread_id"]
        deleted = await ac.delete(f"/runs/{run_id}/review-threads/{tid}")
        assert deleted.status_code == 204
        remaining = (await ac.get(f"/runs/{run_id}/review-threads")).json()

    assert remaining == []
    await engine.dispose()
