"""Tests for the publish-target pin (issue #15): Python mirror of the TS
target pin in deploy/cloudflare-workers/src/routes/runs.ts +
src/workflows/production.ts. Covers the HITL_2 approve mismatch guard, the
publish-time assertion (agents/publish.py), and the /republish re-push gate.
"""

from datetime import date
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from content_tool.agents.publish import PublishTargetMismatchError, publish_to_wordpress
from content_tool.api.routes.runs import router
from content_tool.config import get_settings
from content_tool.db.models import Draft, FetchedArticle, Render, Run
from content_tool.wordpress.client import PublishResult

# publish_to_wordpress resolves its default label via get_settings().wp_target
# (not app.state), so tests that exercise it use this actual value rather than
# a hardcoded guess — avoids drift against whatever WP_TARGET is set locally.
_DEFAULT_LABEL = get_settings().wp_target


def _make_app(session_factory, *, wp_client=None, wp_target: str = "staging") -> FastAPI:
    app = FastAPI()
    app.state.session_factory = session_factory
    app.state.wp_client = wp_client if wp_client is not None else AsyncMock()
    app.state.wp_target = wp_target

    class _StubExecutor:
        async def resume(self, run_id, update):
            return None

    app.state.run_executor = _StubExecutor()
    app.include_router(router)
    return app


async def _seed_run(
    session_factory,
    *,
    start_mode: str = "refresh",
    wp_pushed_post_id: int | None = None,
    wp_slug: str | None = None,
    article_url: str = "https://www.bowtie.com.hk/blog/old-slug/",
    approved_target_kind: str | None = None,
    approved_post_id: str | None = None,
    approved_target_label: str | None = None,
    hitl_2_decision: str | None = None,
    fetched_wp_post_id: int | None = 100,
    with_render: bool = False,
) -> "uuid4":
    run_id = uuid4()
    async with session_factory() as session:
        session.add(Run(
            run_id=run_id, created_by="x", status="hitl_2",
            article_url=article_url, topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 7, 6), start_mode=start_mode,
            wp_pushed_post_id=wp_pushed_post_id, wp_slug=wp_slug,
            approved_target_kind=approved_target_kind,
            approved_post_id=approved_post_id,
            approved_target_label=approved_target_label,
            hitl_2_decision=hitl_2_decision,
        ))
        await session.commit()
        if start_mode == "refresh":
            session.add(FetchedArticle(
                run_id=run_id, wp_post_id=fetched_wp_post_id,
                raw_html="<p>x</p>", markdown="x",
            ))
            await session.commit()
        if with_render:
            draft_id = uuid4()
            session.add(Draft(
                draft_id=draft_id, run_id=run_id, iteration=0,
                diagnose="d", markup_raw="<p>orig</p>", citation_intents=[],
            ))
            await session.commit()
            session.add(Render(
                draft_id=draft_id, seo_title="t", meta_description="m", html_body="<p>x</p>",
            ))
            await session.commit()
    return run_id


# ---------------------------------------------------------------------------
# HITL_2 approve — target-mismatch guard (cases a-c)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hitl2_approve_refresh_without_confirmed_target_refused(pg_session_factory):
    # Arrange: refresh run at the gate, no confirmed_target on the request.
    run_id = await _seed_run(pg_session_factory)
    app = _make_app(pg_session_factory)

    # Act
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/hitl-2", json={"decision": "approve"})

    # Assert: refused, decision not recorded.
    assert r.status_code == 409
    assert "expected_target" in r.json()["detail"]
    async with pg_session_factory() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert row.hitl_2_decision is None
    assert row.approved_target_kind is None


@pytest.mark.asyncio
async def test_hitl2_approve_refresh_with_stale_post_id_refused(pg_session_factory):
    # Arrange: the reviewer's preview named post 999, but the fetched post is 100.
    run_id = await _seed_run(pg_session_factory, fetched_wp_post_id=100)
    app = _make_app(pg_session_factory)

    # Act
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(
            f"/runs/{run_id}/hitl-2",
            json={
                "decision": "approve",
                "confirmed_target": {"kind": "wordpress", "post_id": "999", "label": "staging"},
            },
        )

    # Assert
    assert r.status_code == 409
    async with pg_session_factory() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert row.hitl_2_decision is None


@pytest.mark.asyncio
async def test_hitl2_approve_refresh_with_matching_target_persists_pin(pg_session_factory):
    # Arrange: confirmed_target matches what the server will resolve (fetched
    # post 100, default label "staging", unchanged slug).
    run_id = await _seed_run(pg_session_factory, fetched_wp_post_id=100)
    app = _make_app(pg_session_factory, wp_target="staging")

    # Act
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(
            f"/runs/{run_id}/hitl-2",
            json={
                "decision": "approve",
                "editor_email": "ed@bowtie.com.hk",
                "confirmed_target": {"kind": "wordpress", "post_id": "100", "label": "staging"},
            },
        )

    # Assert: approved and pin persisted.
    assert r.status_code == 200
    async with pg_session_factory() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert row.hitl_2_decision == "approve"
    assert row.approved_target_kind == "wordpress"
    assert row.approved_post_id == "100"
    assert row.approved_target_label == "staging"


@pytest.mark.asyncio
async def test_hitl2_create_mode_approve_needs_no_pin(pg_session_factory):
    # Arrange: create-mode approvals skip the target-pin check entirely.
    run_id = await _seed_run(pg_session_factory, start_mode="create")
    app = _make_app(pg_session_factory)

    # Act
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/hitl-2", json={"decision": "approve"})

    # Assert
    assert r.status_code == 200
    async with pg_session_factory() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert row.hitl_2_decision == "approve"
    assert row.approved_target_kind is None


# ---------------------------------------------------------------------------
# publish_to_wordpress — publish-time pin assertion (cases d-f)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_publish_refuses_when_fetched_post_id_changed_since_approval(pg_session_factory):
    """The verification case: approved for post A, fetched_articles mutated to
    B before publish. Publish must refuse and void the approval WITHOUT
    calling WordPress."""
    # Arrange: approved pin = post "100" (A); fetched_articles now says 200 (B).
    run_id = await _seed_run(
        pg_session_factory,
        approved_target_kind="wordpress", approved_post_id="100",
        approved_target_label="staging",
        hitl_2_decision="approve",
        fetched_wp_post_id=200,
        with_render=True,
    )
    wp_client = AsyncMock()

    # Act / Assert
    async with pg_session_factory() as session:
        with pytest.raises(PublishTargetMismatchError):
            await publish_to_wordpress(
                session=session, run_id=run_id, wp_client=wp_client,
                seo_plugin=None, if_unmodified_since=None,
            )
    wp_client.upsert.assert_not_called()

    # Approval voided.
    async with pg_session_factory() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert row.hitl_2_decision is None
    assert row.approved_at is None
    assert row.approved_by is None
    assert row.approved_target_kind is None
    assert row.approved_post_id is None
    assert row.approved_target_label is None


@pytest.mark.asyncio
async def test_publish_refuses_when_pin_missing(pg_session_factory):
    """A legacy approval that predates the pin columns (no pin at all) must
    also refuse — a missing pin is treated the same as a mismatched one."""
    # Arrange: no approved_target_* set at all.
    run_id = await _seed_run(
        pg_session_factory, hitl_2_decision="approve", fetched_wp_post_id=100,
        with_render=True,
    )
    wp_client = AsyncMock()

    # Act / Assert
    async with pg_session_factory() as session:
        with pytest.raises(PublishTargetMismatchError):
            await publish_to_wordpress(
                session=session, run_id=run_id, wp_client=wp_client,
                seo_plugin=None, if_unmodified_since=None,
            )
    wp_client.upsert.assert_not_called()


@pytest.mark.asyncio
async def test_publish_create_mode_unaffected_by_pin(pg_session_factory):
    """Create-mode publishes never had a fetched post to overwrite — no pin
    is required and the publish proceeds normally."""
    # Arrange
    run_id = await _seed_run(pg_session_factory, start_mode="create", with_render=True)
    wp_client = AsyncMock()
    wp_client.upsert.return_value = PublishResult(
        id=42, link="https://wp.example.com/p/42", status="draft",
        modified_gmt="2026-07-06T00:00:00", slug="new-post",
    )

    # Act
    async with pg_session_factory() as session:
        result = await publish_to_wordpress(
            session=session, run_id=run_id, wp_client=wp_client,
            seo_plugin=None, if_unmodified_since=None,
        )

    # Assert
    assert result["id"] == 42
    wp_client.upsert.assert_called_once()


@pytest.mark.asyncio
async def test_publish_matching_pin_proceeds(pg_session_factory):
    # Arrange: approved pin matches the currently-resolved target exactly.
    run_id = await _seed_run(
        pg_session_factory,
        approved_target_kind="wordpress", approved_post_id="100",
        approved_target_label=_DEFAULT_LABEL,
        hitl_2_decision="approve",
        fetched_wp_post_id=100,
        with_render=True,
    )
    wp_client = AsyncMock()
    wp_client.upsert.return_value = PublishResult(
        id=100, link="https://wp.example.com/p/100", status="publish",
        modified_gmt="2026-07-06T00:00:00", slug="old-slug",
    )

    # Act
    async with pg_session_factory() as session:
        result = await publish_to_wordpress(
            session=session, run_id=run_id, wp_client=wp_client,
            seo_plugin=None, if_unmodified_since=None,
        )

    # Assert
    assert result["id"] == 100
    wp_client.upsert.assert_called_once()


# ---------------------------------------------------------------------------
# /republish — never-pushed refresh re-push gate (scope addendum)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_republish_never_pushed_without_matching_pin_refused(pg_session_factory):
    # Arrange: wp_pushed_post_id is NULL (never pushed) and no matching pin.
    run_id = await _seed_run(
        pg_session_factory, wp_pushed_post_id=None, fetched_wp_post_id=100,
        with_render=True,
    )
    wp_client = AsyncMock()
    app = _make_app(pg_session_factory, wp_client=wp_client)

    # Act
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/republish")

    # Assert: refused, WordPress never called.
    assert r.status_code == 409
    wp_client.upsert.assert_not_called()


@pytest.mark.asyncio
async def test_republish_never_pushed_with_matching_pin_proceeds(pg_session_factory):
    # Arrange: wp_pushed_post_id is NULL, but the pin matches the fetched post.
    run_id = await _seed_run(
        pg_session_factory, wp_pushed_post_id=None, fetched_wp_post_id=100,
        approved_target_kind="wordpress", approved_post_id="100",
        approved_target_label=_DEFAULT_LABEL,
        with_render=True,
    )
    wp_client = AsyncMock()
    wp_client.upsert.return_value = PublishResult(
        id=100, link="https://wp.example.com/p/100", status="publish",
        modified_gmt="2026-07-06T00:00:00", slug="old-slug",
    )
    app = _make_app(pg_session_factory, wp_client=wp_client, wp_target=_DEFAULT_LABEL)

    # Act
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"/runs/{run_id}/republish")

    # Assert
    assert r.status_code == 200
    wp_client.upsert.assert_called_once()
