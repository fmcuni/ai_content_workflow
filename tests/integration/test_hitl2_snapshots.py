from datetime import UTC, date, datetime
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from content_tool.api.routes.runs import _HITL2_SNAPSHOT_KEEP
from content_tool.api.routes.runs import router as runs_router
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Draft, Hitl2Snapshot, Render, Run


async def _seed_run(sf, run_id) -> None:
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="hitl_2",
            article_url="https://www.bowtie.com.hk/blog/x", topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 27),
        ))
        await s.commit()


async def _seed_render(sf, run_id, *, iteration: int, html_body: str) -> None:
    """Seed a Draft + its Render so the run has 'live' published content."""
    async with sf() as s:
        draft_id = uuid4()
        s.add(Draft(
            draft_id=draft_id, run_id=run_id, iteration=iteration,
            diagnose="d", markup_raw=html_body, citation_intents=[],
        ))
        s.add(Render(
            draft_id=draft_id, seo_title="Gen Title",
            meta_description="gen meta", html_body=html_body,
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


@pytest.mark.asyncio
async def test_snapshot_stamps_editor_email_as_created_by(postgres_url):
    """The snapshot's created_by must reflect the supplied editor identity (email),
    not a hardcoded placeholder."""
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{run_id}/hitl2-snapshots",
            json={
                "trigger": "manual",
                "editor_email": "author@bowtie.com.hk",
                "html_body": "<p>draft</p>",
            },
        )
    assert r.status_code == 200
    assert r.json()["created_by"] == "author@bowtie.com.hk"
    await engine.dispose()


@pytest.mark.asyncio
async def test_list_stamps_version_number_and_is_current(postgres_url):
    """version_number is oldest=1; is_current flags the snapshot matching the
    live render body."""
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    # Live published content is "<p>v2</p>" — the second snapshot below.
    await _seed_render(sf, run_id, iteration=1, html_body="<p>v2</p>")
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.post(
            f"/runs/{run_id}/hitl2-snapshots",
            json={"trigger": "interval", "html_body": "<p>v1</p>"},
        )
        await ac.post(
            f"/runs/{run_id}/hitl2-snapshots",
            json={"trigger": "manual", "html_body": "<p>v2</p>"},
        )
        rows = (await ac.get(f"/runs/{run_id}/hitl2-snapshots")).json()

    # Newest-first: a 'generated' baseline (from the render) plus the two saves.
    # The baseline shares the render body "<p>v2</p>" with the manual save, so
    # key the saves by body and pick the baseline out by trigger.
    generated = [r for r in rows if r["trigger"] == "generated"]
    by_body = {r["html_body"]: r for r in rows if r["trigger"] != "generated"}
    # Stable numbering, oldest = 1. The generated baseline is the oldest row
    # even though it was lazily seeded after the saves (backdated on insert).
    assert len(generated) == 1
    assert generated[0]["version_number"] == 1
    assert by_body["<p>v1</p>"]["version_number"] == 2
    assert by_body["<p>v2</p>"]["version_number"] == 3
    # Only the newest snapshot whose body equals the live render is flagged
    # current.
    assert by_body["<p>v2</p>"]["is_current"] is True
    assert by_body["<p>v1</p>"]["is_current"] is False
    assert generated[0]["is_current"] is False
    await engine.dispose()


@pytest.mark.asyncio
async def test_generated_baseline_seeded_from_render(postgres_url):
    """A run with a render but no manual snapshots still lists exactly one
    'generated' baseline (v1) carrying the render body — idempotent across GETs."""
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    await _seed_render(sf, run_id, iteration=1, html_body="<p>the AI draft</p>")
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        first = (await ac.get(f"/runs/{run_id}/hitl2-snapshots")).json()
        second = (await ac.get(f"/runs/{run_id}/hitl2-snapshots")).json()

    assert len(first) == 1
    base = first[0]
    assert base["trigger"] == "generated"
    assert base["html_body"] == "<p>the AI draft</p>"
    assert base["version_number"] == 1
    assert base["is_current"] is True
    assert base["created_by"] == "system:generated"
    # Idempotent: a second GET does not create a duplicate baseline.
    assert len(second) == 1

    async with sf() as s:
        n = (await s.execute(
            select(func.count()).select_from(Hitl2Snapshot).where(
                Hitl2Snapshot.run_id == run_id, Hitl2Snapshot.trigger == "generated"
            )
        )).scalar_one()
    assert n == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_list_drafts_returns_iterations_newest_first(postgres_url):
    """GET /{run_id}/drafts returns every iteration that produced a render,
    newest-first, with the render body + SEO metadata (unified-timeline source)."""
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    await _seed_render(sf, run_id, iteration=1, html_body="<p>draft one</p>")
    await _seed_render(sf, run_id, iteration=2, html_body="<p>draft two</p>")
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get(f"/runs/{run_id}/drafts")

    assert resp.status_code == 200
    rows = resp.json()
    assert [r["iteration"] for r in rows] == [2, 1]
    assert rows[0]["html_body"] == "<p>draft two</p>"
    assert rows[1]["html_body"] == "<p>draft one</p>"
    # Render metadata rides along so a draft is restorable from the timeline.
    assert rows[0]["seo_title"] == "Gen Title"
    assert rows[0]["meta_description"] == "gen meta"
    assert {"draft_id", "iteration", "created_at"} <= rows[0].keys()
    await engine.dispose()


@pytest.mark.asyncio
async def test_list_drafts_empty_for_run_without_render(postgres_url):
    """A run with no render yields an empty list (parity: both backends return [])."""
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get(f"/runs/{run_id}/drafts")

    assert resp.status_code == 200
    assert resp.json() == []
    await engine.dispose()
