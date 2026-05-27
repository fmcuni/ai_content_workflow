from datetime import UTC, date, datetime
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from content_tool.api.routes.runs import _HITL2_SNAPSHOT_KEEP
from content_tool.api.routes.runs import router as runs_router
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Hitl2Snapshot, Run


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
async def test_snapshot_save_and_list_round_trip(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    payload = {
        "trigger": "interval",
        "html_body": "<p>working draft</p>",
        "seo_title": "Title",
        "meta_description": "meta",
        "notes": "punch up the lede",
        "comments": [{"id": "c1", "anchor_text": "surgery", "body": "verify this"}],
        "wp_publish_status": "draft",
        "wp_slug": "draft-slug",
        "wp_category_ids": [42],
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        first = await ac.post(f"/runs/{run_id}/hitl2-snapshots", json=payload)
        assert first.status_code == 200
        body = first.json()
        assert body["html_body"] == "<p>working draft</p>"
        assert body["trigger"] == "interval"
        assert body["comments"][0]["body"] == "verify this"
        assert "snapshot_id" in body and "created_at" in body

        await ac.post(
            f"/runs/{run_id}/hitl2-snapshots",
            json={**payload, "trigger": "manual", "html_body": "<p>v2</p>"},
        )
        listed = await ac.get(f"/runs/{run_id}/hitl2-snapshots")

    assert listed.status_code == 200
    rows = listed.json()
    assert len(rows) == 2
    # Newest first.
    assert rows[0]["html_body"] == "<p>v2</p>"
    assert rows[1]["html_body"] == "<p>working draft</p>"
    await engine.dispose()


@pytest.mark.asyncio
async def test_snapshot_save_404_for_missing_run(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    app = _make_app(sf)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{uuid4()}/hitl2-snapshots",
            json={"trigger": "manual", "html_body": "<p>x</p>"},
        )
    assert r.status_code == 404
    await engine.dispose()


@pytest.mark.asyncio
async def test_snapshot_prunes_to_retention_cap(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    # Pre-seed exactly the retention cap, with strictly increasing timestamps so
    # ordering (and thus which rows get pruned) is deterministic.
    base = datetime(2026, 5, 27, tzinfo=UTC)
    async with sf() as s:
        for i in range(_HITL2_SNAPSHOT_KEEP):
            s.add(Hitl2Snapshot(
                snapshot_id=uuid4(), run_id=run_id, trigger="interval",
                html_body=f"<p>old {i}</p>",
                created_at=base.replace(minute=i % 60, second=i // 60),
            ))
        await s.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{run_id}/hitl2-snapshots",
            json={"trigger": "manual", "html_body": "<p>newest</p>"},
        )
        assert r.status_code == 200

    async with sf() as s:
        count = (await s.execute(
            select(func.count()).select_from(Hitl2Snapshot).where(Hitl2Snapshot.run_id == run_id)
        )).scalar_one()
        newest = (await s.execute(
            select(Hitl2Snapshot.html_body)
            .where(Hitl2Snapshot.run_id == run_id)
            .order_by(Hitl2Snapshot.created_at.desc())
            .limit(1)
        )).scalar_one()
    assert count == _HITL2_SNAPSHOT_KEEP
    assert newest == "<p>newest</p>"
    await engine.dispose()
