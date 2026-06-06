"""Integration-test-only fixtures for the /refresh API routes."""
from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import date
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool import prompts_store
from content_tool.api.main import create_app
from content_tool.db.models import (
    Citation,
    Draft,
    FetchedArticle,
    GapAnalysisRow,
    OutlineRow,
    PromptTemplate,
    Render,
    Run,
)
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.wordpress.client import WordPressClient


@pytest.fixture(scope="session", autouse=True)
def _ensure_schema(apply_migrations):
    """Guarantee the testcontainers schema exists before any integration test.

    Several tests in this package depend only on `postgres_url` and build their
    own engine, so they never pull in `apply_migrations` directly. Without an
    explicit trigger, whichever of those runs first hits a schema-less database
    ("relation content_tool.runs does not exist"). This autouse session fixture
    forces `apply_migrations` to run once up front, independent of test order.
    """
    return None


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


_DEFAULT_TEST_VOICE = "bowtie-editor"


@pytest_asyncio.fixture
async def restore_template(
    pg_session_factory: async_sessionmaker[AsyncSession],
):
    """Snapshot per-voice prompt_templates rows and restore them after the test.

    PUT/revert API tests mutate the live ``(voice, template)`` row
    (body/sha256/bytes/updated_by), which would drift across tests and break sha
    assertions. The yielded callable snapshots a row by template_id for a voice
    (default ``bowtie-editor`` — the voice the API edits when ``?voice=`` is
    omitted); teardown writes the saved values back and busts the prompts_store
    cache so the next read reloads the restored row rather than the mutated one.
    """
    saved: dict[tuple[str, str], tuple[str, str, int, str | None]] = {}

    async def _snap(template_id: str, voice: str = _DEFAULT_TEST_VOICE) -> str:
        async with pg_session_factory() as s:
            row = (
                await s.execute(
                    select(PromptTemplate).where(
                        PromptTemplate.voice_slug == voice,
                        PromptTemplate.template_id == template_id,
                    )
                )
            ).scalar_one()
            saved[(voice, template_id)] = (row.body, row.sha256, row.bytes, row.updated_by)
        return template_id

    yield _snap

    for (voice, template_id), (body, sha256, num_bytes, updated_by) in saved.items():
        async with pg_session_factory() as s:
            row = (
                await s.execute(
                    select(PromptTemplate)
                    .where(
                        PromptTemplate.voice_slug == voice,
                        PromptTemplate.template_id == template_id,
                    )
                    .with_for_update()
                )
            ).scalar_one()
            row.body = body
            row.sha256 = sha256
            row.bytes = num_bytes
            row.updated_by = updated_by
            await s.commit()
    prompts_store.clear_cache()


async def _purge_voice(
    pg_session_factory: async_sessionmaker[AsyncSession], slug: str
) -> None:
    """Delete every per-voice row for ``slug`` (templates, versions, policy,
    policy versions, persona) and bust the in-process caches.

    Used by the ``duplicated_voice`` fixture to leave the DB exactly as it found
    it — the per-test truncate in ``pg_session_factory`` does not cover these
    tables.
    """
    from sqlalchemy import text

    from content_tool import source_policy_store

    async with pg_session_factory() as s:
        for table, col in (
            ("prompt_versions", "voice_slug"),
            ("prompt_templates", "voice_slug"),
            ("source_policy_versions", "voice_slug"),
            ("source_policy", "voice_slug"),
            ("personas", "slug"),
        ):
            # table/col are hard-coded literals from the loop above (no user
            # input); the slug is bound as a parameter.
            await s.execute(
                text(f"DELETE FROM content_tool.{table} WHERE {col} = :slug"),  # noqa: S608
                {"slug": slug},
            )
        await s.commit()
    prompts_store.clear_cache()
    source_policy_store.clear_cache()


@pytest_asyncio.fixture
async def duplicated_voice(
    api_client: AsyncClient,
    pg_session_factory: async_sessionmaker[AsyncSession],
):
    """Create a throwaway voice (a duplicate of ``bowtie-editor``) for per-voice
    route tests, and purge all of its rows on teardown.

    Yields the new voice slug. The duplicate endpoint clones the source voice's
    agent/partial templates + source policy and seeds their history, so the new
    voice is independently editable.
    """
    slug = "dup-test-voice"
    await _purge_voice(pg_session_factory, slug)
    r = await api_client.post(
        "/personas/bowtie-editor/duplicate",
        json={"slug": slug, "name": "Dup Test Voice"},
    )
    assert r.status_code == 201, r.text
    yield slug
    await _purge_voice(pg_session_factory, slug)
