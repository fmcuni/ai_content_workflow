from datetime import date
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from content_tool.agents.apply_edits import build_user_prompt
from content_tool.api.routes.runs import router as runs_router
from content_tool.api.schemas import Hitl2Comment
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Draft, FetchedArticle, OutlineRow, Render, Run
from content_tool.gemini.fake import FakeGeminiClient


async def _seed_finished_run(sf, run_id):
    """A published refresh run with outline + draft + render rows."""
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="published",
            article_url="https://www.bowtie.com.hk/blog/x", topic="自願醫保", keywords=["醫保"],
            mode="auto", acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 27), chosen_route="small_refresh",
            wp_publish_status="draft", wp_category_ids=[42], start_mode="refresh",
            wp_pushed_post_id=98785,
        ))
        await s.commit()
    async with sf() as s:
        s.add(FetchedArticle(run_id=run_id, wp_post_id=98785, wp_categories=[], markdown="x"))
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


def _make_app(sf, gemini):
    app = FastAPI()
    app.include_router(runs_router)
    app.state.session_factory = sf
    app.state.gemini_client = gemini
    app.state.run_executor = type("R", (), {"start": None})
    return app


def _comment(anchor: str, body: str) -> Hitl2Comment:
    return Hitl2Comment(id="c-1", anchor_text=anchor, body=body)


def test_build_user_prompt_includes_comment_and_overall_note():
    prompt = build_user_prompt(
        html_body="<p>原文段落</p>",
        comments=[_comment("原文段落", "請寫得更簡潔")],
        notes="整體要更貼地",
    )
    assert "<p>原文段落</p>" in prompt
    assert "原文段落" in prompt
    assert "請寫得更簡潔" in prompt
    assert "整體要更貼地" in prompt


def test_build_user_prompt_omits_absent_sections():
    only_notes = build_user_prompt(html_body="<p>x</p>", comments=[], notes="整體調整")
    assert "comments" not in only_notes
    assert "整體調整" in only_notes

    only_comments = build_user_prompt(
        html_body="<p>x</p>",
        comments=[_comment("x", "改")],
        notes=None,
    )
    assert "overall note" not in only_comments
    assert "改" in only_comments


@pytest.mark.asyncio
async def test_apply_edits_returns_revised_html(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_finished_run(sf, run_id)
    gemini = FakeGeminiClient({
        "apply_edits": {"html_body": "<p>修改後段落</p>", "diagnose": "縮短咗 lede"},
    })
    app = _make_app(sf, gemini)

    payload = {
        "html_body": '<p><span data-comment-id="c-1">原文段落</span></p>',
        "comments": [{"id": "c-1", "anchor_text": "原文段落", "body": "請寫得更簡潔"}],
        "notes": None,
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(f"/runs/{run_id}/apply-edits", json=payload)

    assert r.status_code == 200
    assert r.json() == {"html_body": "<p>修改後段落</p>"}
    # The agent was called once, with the anchor text + instruction in the prompt.
    assert len(gemini.calls) == 1
    call = gemini.calls[0]
    assert call["agent"] == "apply_edits"
    assert "請寫得更簡潔" in call["user_prompt"]
    assert "原文段落" in call["user_prompt"]
    await engine.dispose()


@pytest.mark.asyncio
async def test_apply_edits_rejects_empty_feedback(postgres_url):
    # The empty-feedback guard runs before any DB fetch, so no seed is needed.
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    app = _make_app(sf, FakeGeminiClient({"apply_edits": {"html_body": "x"}}))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{uuid4()}/apply-edits",
            json={"html_body": "<p>x</p>", "comments": [], "notes": None},
        )
    assert r.status_code == 400
    await engine.dispose()


@pytest.mark.asyncio
async def test_apply_edits_503_when_gemini_unconfigured(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    app = _make_app(sf, None)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{uuid4()}/apply-edits",
            json={"html_body": "<p>x</p>", "notes": "改一改"},
        )
    assert r.status_code == 503
    await engine.dispose()


@pytest.mark.asyncio
async def test_apply_edits_unknown_run_404(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    app = _make_app(sf, FakeGeminiClient({"apply_edits": {"html_body": "x"}}))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{uuid4()}/apply-edits",
            json={"html_body": "<p>x</p>", "notes": "改一改"},
        )
    assert r.status_code == 404
    await engine.dispose()
