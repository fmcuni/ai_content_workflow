"""Tests for ``PATCH /runs/{run_id}`` — the Ledger board's inline-edit endpoint.

Partial WordPress/brief metadata updates on a run, with the same optimistic
``expected_version`` 409 contract as ``PUT /article`` (the latest Render's
version is the shared token). Slug input is canonicalized (decode-then-encode).
"""
from datetime import date
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.api.routes.runs import router as runs_router
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Draft, Render, Run
from content_tool.wordpress.client import WordPressClient


async def _seed_run(sf, run_id, *, with_render=True):
    """A finished create run, optionally with a draft + render at version 0."""
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="persisted",
            article_url=None, topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 6, 4), chosen_route="small_refresh",
            wp_publish_status="draft", start_mode="create",
        ))
        await s.commit()
    if with_render:
        async with sf() as s:
            d = Draft(
                run_id=run_id, iteration=0, diagnose="d",
                markup_raw="x", final_markup="x", citation_intents=[],
            )
            s.add(d)
            await s.commit()
            await s.refresh(d)
            s.add(Render(draft_id=d.draft_id, seo_title="T", meta_description="m",
                         html_body="<p>x</p>", excerpt_suggestion="e"))
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


@pytest.mark.asyncio
async def test_patch_updates_only_provided_fields(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.patch(f"/runs/{run_id}", json={
            "wp_author_id": 7,
            "wp_category_ids": [3, 9],
            "wp_publish_status": "publish",
        })
        assert r.status_code == 200, r.text
        got = await ac.get(f"/runs/{run_id}")
    body = got.json()
    assert body["wp_author_id"] == 7
    assert body["wp_category_ids"] == [3, 9]
    assert body["wp_publish_status"] == "publish"
    # Untouched fields keep their seeded values.
    assert body["acf_adv_id"] == 1
    assert body["acf_widget_id"] == 2
    await engine.dispose()


@pytest.mark.asyncio
async def test_patch_canonicalizes_slug(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # Decoded CJK in → canonical percent-encoded stored.
        r = await ac.patch(f"/runs/{run_id}", json={"wp_slug": "手足口病"})
        assert r.status_code == 200, r.text
        got = await ac.get(f"/runs/{run_id}")
    assert got.json()["wp_slug"] == "%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85"
    await engine.dispose()


@pytest.mark.asyncio
async def test_patch_slug_already_encoded_is_idempotent(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    encoded = "%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.patch(f"/runs/{run_id}", json={"wp_slug": encoded})
        assert r.status_code == 200, r.text
        got = await ac.get(f"/runs/{run_id}")
    assert got.json()["wp_slug"] == encoded
    await engine.dispose()


@pytest.mark.asyncio
async def test_patch_bumps_render_version(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.patch(f"/runs/{run_id}", json={"acf_adv_id": 42, "expected_version": 0})
        assert r.status_code == 200, r.text
        assert r.json()["version"] == 1
        render = await ac.get(f"/runs/{run_id}/render")
    assert render.json()["version"] == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_patch_rejects_stale_version(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        a = await ac.patch(f"/runs/{run_id}", json={"wp_author_id": 5, "expected_version": 0})
        assert a.status_code == 200
        # B still holds version 0 → rejected; A's write preserved.
        b = await ac.patch(f"/runs/{run_id}", json={"wp_author_id": 99, "expected_version": 0})
        assert b.status_code == 409
        detail = b.json()["detail"]
        assert detail["error"] == "stale_version"
        assert detail["current_version"] == 1
        got = await ac.get(f"/runs/{run_id}")
    assert got.json()["wp_author_id"] == 5
    await engine.dispose()


@pytest.mark.asyncio
async def test_patch_without_version_is_last_write_wins(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        a = await ac.patch(f"/runs/{run_id}", json={"wp_author_id": 1})
        b = await ac.patch(f"/runs/{run_id}", json={"wp_author_id": 2})
        assert a.status_code == 200
        assert b.status_code == 200
        # Each successful write still advances the shared render token (0→1→2).
        assert b.json()["version"] == 2
        got = await ac.get(f"/runs/{run_id}")
    assert got.json()["wp_author_id"] == 2
    await engine.dispose()


@pytest.mark.asyncio
async def test_patch_run_without_render_skips_version(postgres_url):
    """A still-generating run (no draft/render) can still take destination edits."""
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id, with_render=False)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.patch(f"/runs/{run_id}", json={"acf_widget_id": 88})
        assert r.status_code == 200, r.text
        assert r.json()["version"] is None
        got = await ac.get(f"/runs/{run_id}")
    assert got.json()["acf_widget_id"] == 88
    await engine.dispose()


@pytest.mark.asyncio
async def test_patch_version_guard_without_render_404s(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id, with_render=False)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.patch(f"/runs/{run_id}", json={"acf_widget_id": 1, "expected_version": 0})
        assert r.status_code == 404
    await engine.dispose()


@pytest.mark.asyncio
async def test_list_runs_exposes_wp_fields_for_the_board(postgres_url):
    """The Ledger reads WORDPRESS columns from the list — they must round-trip."""
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_run(sf, run_id)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        await ac.patch(f"/runs/{run_id}", json={
            "wp_author_id": 4, "wp_category_ids": [6], "wp_slug": "手足口病",
            "wp_publish_status": "publish",
        })
        listed = await ac.get("/runs")
    row = next(r for r in listed.json() if r["run_id"] == str(run_id))
    assert row["wp_author_id"] == 4
    assert row["wp_category_ids"] == [6]
    assert row["wp_slug"] == "%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85"
    assert row["wp_publish_status"] == "publish"
    await engine.dispose()


@pytest.mark.asyncio
async def test_patch_missing_run_404s(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    app = _make_app(sf)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.patch(f"/runs/{uuid4()}", json={"wp_author_id": 1})
        assert r.status_code == 404
    await engine.dispose()
