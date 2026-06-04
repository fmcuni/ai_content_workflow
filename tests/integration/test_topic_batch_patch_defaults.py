"""Tests for ``PATCH /topic-batches/{batch_id}`` — Ledger band default edits.

Partial update of a batch's promotion defaults (persona/adv/widget/auto-H1).
A default only affects runs promoted *after* the change, so these are plain
record updates with no version guard.
"""
from __future__ import annotations

from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from content_tool.api.main import create_app
from content_tool.db.models import TopicBatch
from content_tool.gemini.fake import FakeGeminiClient


@pytest_asyncio.fixture
async def api_client(pg_session_factory):
    app = create_app()
    app.state.session_factory = pg_session_factory
    app.state.run_executor = type("R", (), {"start": None})
    app.state.gemini_client = FakeGeminiClient(canned_responses={})
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac, pg_session_factory


async def _seed_batch(sf, **overrides):
    fields = dict(
        created_by="t@bowtie", status="ready_for_review",
        research_theme="保險新手", target_audience="香港 25-35",
        topic_count=3, keywords_per_topic=2, must_cover=[], must_avoid=[],
        persona_default="bowtie-editor", acf_adv_id_default=11,
        acf_widget_id_default=22, auto_accept_hitl1_default=False,
    )
    fields.update(overrides)
    async with sf() as session:
        batch = TopicBatch(**fields)
        session.add(batch)
        await session.flush()
        bid = batch.batch_id
        await session.commit()
    return bid


@pytest.mark.asyncio
async def test_patch_updates_only_provided_defaults(api_client):
    ac, sf = api_client
    bid = await _seed_batch(sf)

    r = await ac.patch(f"/topic-batches/{bid}", json={
        "persona_default": "dr-wong",
        "acf_adv_id_default": 99,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["persona_default"] == "dr-wong"
    assert body["acf_adv_id_default"] == 99
    # Untouched defaults are preserved.
    assert body["acf_widget_id_default"] == 22
    assert body["auto_accept_hitl1_default"] is False


@pytest.mark.asyncio
async def test_patch_can_toggle_auto_accept_and_clear_persona(api_client):
    ac, sf = api_client
    bid = await _seed_batch(sf)

    r = await ac.patch(f"/topic-batches/{bid}", json={
        "auto_accept_hitl1_default": True,
        "persona_default": None,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["auto_accept_hitl1_default"] is True
    assert body["persona_default"] is None


@pytest.mark.asyncio
async def test_patch_empty_body_is_noop(api_client):
    ac, sf = api_client
    bid = await _seed_batch(sf)

    r = await ac.patch(f"/topic-batches/{bid}", json={})
    assert r.status_code == 200, r.text
    assert r.json()["acf_adv_id_default"] == 11


@pytest.mark.asyncio
async def test_patch_missing_batch_404s(api_client):
    ac, _sf = api_client
    r = await ac.patch(f"/topic-batches/{uuid4()}", json={"acf_adv_id_default": 1})
    assert r.status_code == 404
