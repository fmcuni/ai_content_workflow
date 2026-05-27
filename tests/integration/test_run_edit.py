from datetime import date
from uuid import uuid4

import pytest
import respx
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import select

from content_tool.api.routes.runs import router as runs_router
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Draft, FetchedArticle, OutlineRow, Render, Run
from content_tool.wordpress.client import WordPressClient


async def _seed_finished_run(sf, run_id, *, start_mode="refresh", wp_post_id=98785):
    """A published refresh run with outline + draft + render rows."""
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="published",
            article_url="https://www.bowtie.com.hk/blog/x", topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 27), chosen_route="small_refresh",
            wp_publish_status="draft", wp_category_ids=[42], start_mode=start_mode,
            wp_pushed_post_id=wp_post_id,
        ))
        await s.commit()
    async with sf() as s:
        if start_mode == "refresh":
            s.add(FetchedArticle(
                run_id=run_id, wp_post_id=wp_post_id, wp_categories=[], markdown="x"
            ))
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


@pytest.mark.asyncio
async def test_edit_outline_persists_human_edits(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_finished_run(sf, run_id)
    app = _make_app(sf)

    new_outline = {"h1": "New headline", "sections": [{"heading_text": "Intro"}]}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.put(f"/runs/{run_id}/outline", json={"outline": new_outline})
        assert r.status_code == 200
        got = await ac.get(f"/runs/{run_id}/outline")

    assert got.status_code == 200
    body = got.json()
    assert body["edited_by_human"] is True
    assert body["human_edits"] == new_outline
    await engine.dispose()


@pytest.mark.asyncio
async def test_edit_article_updates_render_and_run(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_finished_run(sf, run_id)
    app = _make_app(sf)

    payload = {
        "html_body": "<p>brand new body</p>",
        "seo_title": "Fresh title",
        "meta_description": "fresh meta",
        "wp_slug": "fresh-slug",
        "wp_publish_status": "publish",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.put(f"/runs/{run_id}/article", json=payload)
        assert r.status_code == 200
        render = await ac.get(f"/runs/{run_id}/render")

    assert render.json()["html_body"] == "<p>brand new body</p>"
    assert render.json()["seo_title"] == "Fresh title"
    async with sf() as s:
        run = (await s.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        assert run.wp_slug == "fresh-slug"
        assert run.wp_publish_status == "publish"
    await engine.dispose()


@pytest.mark.asyncio
async def test_republish_pushes_to_existing_post(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_finished_run(sf, run_id, wp_post_id=98785)
    app = _make_app(sf)

    with respx.mock(assert_all_called=True) as router:
        route = router.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json={
                "id": 98785,
                "link": "https://wp.example.com/?p=98785",
                "status": "draft",
                "modified_gmt": "2026-05-27T00:00:00",
                "slug": "fresh-slug",
            })
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            r = await ac.post(f"/runs/{run_id}/republish")

    assert route.called
    assert r.status_code == 200
    assert r.json() == {
        "wp_post_id": 98785,
        "link": "https://wp.example.com/?p=98785",
        "status": "draft",
    }
    async with sf() as s:
        run = (await s.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        assert run.status == "published"
        assert run.wp_pushed_post_id == 98785
    await engine.dispose()
