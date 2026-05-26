"""Integration-test-only fixtures for the /refresh API routes."""
from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import date
from uuid import uuid4

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.api.main import create_app
from content_tool.db.models import (
    Citation,
    Draft,
    FetchedArticle,
    GapAnalysisRow,
    OutlineRow,
    Render,
    Run,
)
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.wordpress.client import WordPressClient


@pytest_asyncio.fixture
async def api_client_refresh(
    pg_session_factory: async_sessionmaker[AsyncSession],
    wp_client_mocked_ok: WordPressClient,
    fake_gemini: FakeGeminiClient,
) -> AsyncGenerator[AsyncClient]:
    """AsyncClient with session_factory, wp_client and gemini_client all wired to test doubles."""
    app = create_app()
    app.state.session_factory = pg_session_factory
    app.state.wp_client = wp_client_mocked_ok
    app.state.gemini_client = fake_gemini
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


def _base_run(run_id):
    return Run(
        run_id=run_id, created_by="t@bowtie", status="hitl_2",
        article_url="https://wp.test/example",
        topic="自願醫保 2026", keywords=["VHIS"], mode="auto", edit_note=None,
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        topic_category="insurance", today_date=date.today(),
        chosen_route="small_refresh", iteration_count=0,
    )


@pytest_asyncio.fixture
async def persisted_strategy_only_run(
    pg_session_factory: async_sessionmaker,
) -> str:
    run_id = uuid4()
    async with pg_session_factory() as s:
        s.add(_base_run(run_id))
        await s.flush()
        s.add(FetchedArticle(
            run_id=run_id, wp_post_id=42, raw_html="<p>old</p>",
            markdown="old markdown", wp_categories=[], wp_link=None,
        ))
        s.add(GapAnalysisRow(
            run_id=run_id, model="gemini-2.0-flash", thinking_level="low",
            payload={"chosen_route": "small_refresh", "update_plan": {}},
            tokens_in=0, tokens_out=0, thinking_tokens=0, latency_ms=0,
        ))
        s.add(OutlineRow(
            run_id=run_id, payload={"sections": []}, edited_by_human=False,
        ))
        await s.commit()
    return str(run_id)


@pytest_asyncio.fixture
async def persisted_full_run(
    pg_session_factory: async_sessionmaker,
) -> str:
    run_id = uuid4()
    async with pg_session_factory() as s:
        s.add(_base_run(run_id))
        await s.flush()
        s.add(FetchedArticle(
            run_id=run_id, wp_post_id=42, raw_html="<p>old</p>",
            markdown="old markdown", wp_categories=[], wp_link=None,
        ))
        s.add(GapAnalysisRow(
            run_id=run_id, model="gemini-2.0-flash", thinking_level="low",
            payload={"chosen_route": "small_refresh", "update_plan": {"must_add": []}},
            tokens_in=0, tokens_out=0, thinking_tokens=0, latency_ms=0,
        ))
        s.add(OutlineRow(
            run_id=run_id, payload={"sections": []}, edited_by_human=False,
        ))
        draft = Draft(
            run_id=run_id, iteration=0,
            diagnose="ok", markup_raw="# H1\nbody",
            citation_intents=[], grounding_chunks=[],
            tokens_in=0, tokens_out=0, thinking_tokens=0, latency_ms=0,
            final_markup="# H1\nbody",
        )
        s.add(draft)
        await s.flush()
        s.add(Render(
            draft_id=draft.draft_id, seo_title="t",
            meta_description="m", html_body="<h1>H1</h1>",
            faq_schema_jsonld=None, excerpt_suggestion="e", slug_suggestion="s",
        ))
        s.add(Citation(
            draft_id=draft.draft_id, domain="example.com",
            vertex_uri="https://vertexaisearch.cloud.google.com/x",
            final_url="https://example.com", policy_decision="allowed",
            was_displayed=True, denied_reason=None,
        ))
        await s.commit()
    return str(run_id)
