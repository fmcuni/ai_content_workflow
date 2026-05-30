from datetime import date
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.api.routes.runs import router as runs_router
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Render, Run
from content_tool.wordpress.client import WordPressClient


@pytest.mark.asyncio
async def test_dry_publish_returns_payload(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()

    # Commit Run first so FK children can reference it
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="hitl_2",
            article_url="x", topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 21), chosen_route="small_refresh",
            wp_publish_status="draft", wp_category_ids=[42],
        ))
        await s.commit()

    async with sf() as s:
        s.add(FetchedArticle(run_id=run_id, wp_post_id=98785, wp_categories=[], markdown="x"))
        s.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={}))
        s.add(OutlineRow(run_id=run_id, payload={}))
        d = Draft(
            run_id=run_id, iteration=0, diagnose="d",
            markup_raw="x", final_markup="x", citation_intents=[],
        )
        s.add(d)
        await s.commit()
        await s.refresh(d)
        s.add(Render(draft_id=d.draft_id, seo_title="標題", meta_description="m",
                     html_body="<p>x</p>", excerpt_suggestion="e"))
        await s.commit()

    app = FastAPI()
    app.include_router(runs_router)
    app.state.session_factory = sf
    app.state.wp_client = WordPressClient("https://wp.example.com", username="u", app_password="p")  # noqa: S106
    app.state.wp_target = "staging"
    app.state.seo_plugin = "yoast"
    app.state.run_executor = type("R", (), {"start": None})

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(f"/runs/{run_id}/dry-publish")

    assert r.status_code == 200
    data = r.json()
    assert data["request_method"] == "PUT"
    assert "/wp-json/wp/v2/posts/98785" in data["request_url"]
    assert data["request_body"]["status"] == "draft"
    assert data["request_body"]["meta"]["_yoast_wpseo_metadesc"] == "m"
    # Preview must surface the forced WP default page template ("" = default).
    assert data["request_body"]["template"] == ""
    await engine.dispose()
