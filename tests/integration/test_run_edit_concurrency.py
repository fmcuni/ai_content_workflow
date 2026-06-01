"""Optimistic-concurrency tests for the post-hoc edit endpoints.

Two reviewers editing the same finished run must not silently clobber each
other. ``PUT /runs/{id}/article`` and ``PUT /runs/{id}/outline`` accept an
``expected_version``; a stale value is rejected with 409 and the server state is
left untouched. Omitting ``expected_version`` keeps the legacy last-write-wins
behaviour (single-user sidecar) but still advances the counter.
"""
from datetime import date
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.api.routes.runs import router as runs_router
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Draft, OutlineRow, Render, Run
from content_tool.wordpress.client import WordPressClient


async def _seed_finished_run(sf, run_id):
    """A published create run with an outline + draft + render at version 0."""
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="published",
            article_url=None, topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 27), chosen_route="small_refresh",
            wp_publish_status="draft", start_mode="create",
        ))
        await s.commit()
    async with sf() as s:
        s.add(OutlineRow(run_id=run_id, payload={"h1": "Old", "sections": []}))
        d = Draft(
            run_id=run_id, iteration=0, diagnose="d",
            markup_raw="x", final_markup="x", citation_intents=[],
        )
        s.add(d)
        await s.commit()
        await s.refresh(d)
        s.add(Render(draft_id=d.draft_id, seo_title="Old title", meta_description="old meta",
                     html_body="<p>old</p>", excerpt_suggestion="e"))
        await s.commit()


def _make_app(sf):
    app = FastAPI()
    app.include_router(runs_router)
    app.state.session_factory = sf
    app.state.wp_client = WordPressClient("https://wp.example.com", username="u", app_password="p")  # noqa: S106
    app.state.wp_target = "staging"
    app.state.seo_plugin = "yoast"
    app.state.run_executor = type("R", (), {"start": None})
    return app


def _article_payload(body, **extra):
    return {"html_body": body, "seo_title": "T", "meta_description": "M", **extra}


@pytest.mark.asyncio
async def test_render_get_exposes_version(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_finished_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        render = await ac.get(f"/runs/{run_id}/render")
    assert render.status_code == 200
    assert render.json()["version"] == 0
    await engine.dispose()


@pytest.mark.asyncio
async def test_edit_article_bumps_version(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_finished_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.put(f"/runs/{run_id}/article", json=_article_payload("<p>v1</p>"))
        assert r.status_code == 200
        render = await ac.get(f"/runs/{run_id}/render")
    assert render.json()["html_body"] == "<p>v1</p>"
    assert render.json()["version"] == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_edit_article_rejects_stale_version(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_finished_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # Reviewer A saves against version 0 → succeeds, render now at version 1.
        a = await ac.put(f"/runs/{run_id}/article",
                         json=_article_payload("<p>from A</p>", expected_version=0))
        assert a.status_code == 200
        # Reviewer B still holds version 0 → rejected, A's content preserved.
        b = await ac.put(f"/runs/{run_id}/article",
                         json=_article_payload("<p>from B</p>", expected_version=0))
        assert b.status_code == 409
        body = b.json()["detail"]
        assert body["error"] == "stale_version"
        assert body["current_version"] == 1
        render = await ac.get(f"/runs/{run_id}/render")

    assert render.json()["html_body"] == "<p>from A</p>"
    assert render.json()["version"] == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_edit_article_without_version_is_last_write_wins(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_finished_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        a = await ac.put(f"/runs/{run_id}/article", json=_article_payload("<p>A</p>"))
        b = await ac.put(f"/runs/{run_id}/article", json=_article_payload("<p>B</p>"))
        assert a.status_code == 200
        assert b.status_code == 200
        render = await ac.get(f"/runs/{run_id}/render")
    assert render.json()["html_body"] == "<p>B</p>"
    assert render.json()["version"] == 2
    await engine.dispose()


@pytest.mark.asyncio
async def test_edit_outline_rejects_stale_version(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_finished_run(sf, run_id)
    app = _make_app(sf)

    new_outline = {"h1": "New", "sections": []}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        a = await ac.put(f"/runs/{run_id}/outline",
                         json={"outline": new_outline, "expected_version": 0})
        assert a.status_code == 200
        b = await ac.put(f"/runs/{run_id}/outline",
                         json={"outline": {"h1": "Other"}, "expected_version": 0})
        assert b.status_code == 409
        assert b.json()["detail"]["error"] == "stale_version"
        got = await ac.get(f"/runs/{run_id}/outline")

    assert got.json()["human_edits"] == new_outline
    assert got.json()["version"] == 1
    await engine.dispose()
