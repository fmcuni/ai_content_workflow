import asyncio
import json
from datetime import date
from pathlib import Path
from uuid import UUID, uuid4

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import select

from content_tool.api.main import create_app
from content_tool.api.sse import RunExecutor
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import (
    AuditRun,
    Citation,
    Draft,
    OutlineRow,
    Render,
    Run,
)
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.wordpress.client import WordPressClient


@pytest.mark.asyncio
async def test_create_run_then_resume(postgres_url, monkeypatch):
    monkeypatch.setenv("POSTGRES_URL", postgres_url)
    monkeypatch.setenv("GEMINI_API_KEY", "fake")
    monkeypatch.setenv("WP_BASE_URL", "https://www.bowtie.com.hk/blog")

    app = create_app()

    # Override gemini + executor with fakes during lifespan
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        engine = make_engine(postgres_url)
        sf = make_session_factory(engine)
        canned = {
            "gap_analysis": json.loads(
                Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(  # noqa: ASYNC240
                    encoding="utf-8"
                )
            ),
            "outline": json.loads(
                Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(  # noqa: ASYNC240
                    encoding="utf-8"
                )
            ),
        }
        fake = FakeGeminiClient(canned_responses=canned)
        app.state.session_factory = sf
        app.state.run_executor = RunExecutor(
            postgres_url=postgres_url, session_factory=sf, gemini=fake
        )

        with respx.mock(assert_all_called=False) as router:
            # Slug-based fetch via WordPressClient (wp_base_url = www.bowtie.com.hk/blog)
            router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/posts").mock(
                return_value=Response(
                    200,
                    json=[
                        {
                            "id": 98785,
                            "slug": "cancer-screening",
                            "categories": [42],
                            "link": "x",
                            "title": {"rendered": "x"},
                            "status": "publish",
                            "author": 5,
                            "modified_gmt": "2026-04-12T08:30:00",
                            "content": {"rendered": "<p>x</p>"},
                        }
                    ],
                )
            )
            # Categories via _WP_BASE_DEFAULT
            router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/categories").mock(
                return_value=Response(200, json=[{"id": 42, "name": "x", "slug": "x"}])
            )

            create_resp = await ac.post(
                "/runs",
                json={
                    "article_url": "https://www.bowtie.com.hk/blog/zh/cancer-screening/",
                    "topic": "大腸癌",
                    "keywords": ["大腸癌"],
                    "mode": "auto",
                    "acf_adv_id": 1,
                    "acf_widget_id": 2,
                    "persona": "bowtie-editor",
                    "editor_email": "e@x.com",
                },
            )
            assert create_resp.status_code == 200
            run_id = UUID(create_resp.json()["run_id"])

            # Give the background task time to run and interrupt
            await asyncio.sleep(2.0)

            # Resume with approve
            resume_resp = await ac.post(f"/runs/{run_id}/resume", json={"decision": "approve"})
            assert resume_resp.status_code == 200

            # Eventually the run ends; check chosen_route
            await asyncio.sleep(1.0)
            state_resp = await ac.get(f"/runs/{run_id}")
            assert state_resp.json()["chosen_route"] == "small_refresh"

        await engine.dispose()


@pytest.mark.asyncio
async def test_create_run_create_mode_no_article_url(postgres_url, monkeypatch):
    """``start_mode='create'`` skips the article-URL upsert; the run row
    lands with ``article_url=None`` and the start_mode + target_audience
    persisted."""
    monkeypatch.setenv("POSTGRES_URL", postgres_url)
    monkeypatch.setenv("GEMINI_API_KEY", "fake")

    app = create_app()
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)

    class _StubExec:
        def __init__(self) -> None:
            self.started: list = []

        async def start(self, run_id):
            self.started.append(run_id)

    stub = _StubExec()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        app.state.session_factory = sf
        app.state.run_executor = stub
        resp = await ac.post(
            "/runs",
            json={
                "topic": "保險新手指南",
                "keywords": ["保險", "新手"],
                "mode": "auto",
                "acf_adv_id": 1,
                "acf_widget_id": 2,
                "persona": "bowtie-editor",
                "editor_email": "editor@bowtie",
                "start_mode": "create",
                "target_audience": "香港 25-35 歲首次買保險的上班族",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        run_id = UUID(body["run_id"])
        assert body.get("article_id") is None
        assert stub.started == [run_id]

        async with sf() as session:
            row = (
                await session.execute(select(Run).where(Run.run_id == run_id))
            ).scalar_one()
            assert row.start_mode == "create"
            assert row.article_url is None
            assert row.target_audience == "香港 25-35 歲首次買保險的上班族"
            assert row.article_id is None

    await engine.dispose()


@pytest.mark.asyncio
async def test_create_run_create_mode_rejects_article_url(postgres_url, monkeypatch):
    """Create-mode requests that carry ``article_url`` must be rejected;
    the URL is server-generated after draft publish."""
    monkeypatch.setenv("POSTGRES_URL", postgres_url)
    monkeypatch.setenv("GEMINI_API_KEY", "fake")

    app = create_app()
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)

    class _StubExec:
        async def start(self, run_id):  # pragma: no cover - never reached
            pass

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        app.state.session_factory = sf
        app.state.run_executor = _StubExec()
        resp = await ac.post(
            "/runs",
            json={
                "article_url": "https://wp.test/x",
                "topic": "x",
                "keywords": ["x"],
                "mode": "auto",
                "acf_adv_id": 1,
                "acf_widget_id": 2,
                "persona": "bowtie-editor",
                "editor_email": "e@x",
                "start_mode": "create",
            },
        )
        assert resp.status_code == 422, resp.text
        assert "article_url must be absent" in resp.text

    await engine.dispose()


@pytest.mark.asyncio
async def test_resume_persists_override_route(postgres_url, monkeypatch):
    """HITL_1 override_route must update Run.chosen_route so writer.py picks it up."""
    monkeypatch.setenv("POSTGRES_URL", postgres_url)
    monkeypatch.setenv("GEMINI_API_KEY", "fake")

    app = create_app()
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)

    # Pre-insert a Run row with chosen_route="small_refresh"
    run_id = uuid4()
    async with sf() as session:
        session.add(
            Run(
                run_id=run_id,
                created_by="e@x.com",
                status="awaiting_hitl_1",
                article_url="https://www.bowtie.com.hk/blog/zh/x/",
                topic="x",
                keywords=["x"],
                mode="auto",
                acf_adv_id=1,
                acf_widget_id=2,
                persona="bowtie-editor",
                today_date=date.today(),
                chosen_route="small_refresh",
            )
        )
        await session.commit()

    # Stub the runner so we don't trigger graph execution
    class _StubExecutor:
        def __init__(self) -> None:
            self.resume_calls: list = []

        async def resume(self, run_id, update):
            self.resume_calls.append((run_id, update))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        app.state.session_factory = sf
        app.state.run_executor = _StubExecutor()

        resp = await ac.post(
            f"/runs/{run_id}/resume",
            json={"decision": "override_route", "new_route": "full_rewrite"},
        )
        assert resp.status_code == 200

        # Re-read Run row to confirm DB write
        async with sf() as session:
            row = (
                await session.execute(select(Run).where(Run.run_id == run_id))
            ).scalar_one()
            assert row.chosen_route == "full_rewrite"

    await engine.dispose()


@pytest.mark.asyncio
async def test_clear_derived_rows_on_restart(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    draft_id = uuid4()

    async with sf() as session:
        session.add(
            Run(
                run_id=run_id,
                created_by="x",
                status="failed",
                article_url="https://e.com",
                topic="手腕受傷",
                keywords=["TFCC"],
                mode="auto",
                acf_adv_id=1,
                acf_widget_id=2,
                persona="bowtie-editor",
                today_date=date(2026, 5, 21),
                chosen_route="small_refresh",
            )
        )
        await session.commit()
        session.add(OutlineRow(run_id=run_id, payload={"h1": "x"}, edited_by_human=False))
        session.add(
            Draft(
                run_id=run_id,
                draft_id=draft_id,
                iteration=0,
                diagnose="d",
                markup_raw="<p>x</p>",
                citation_intents=[],
            )
        )
        await session.commit()
        # Two renders for one draft — the shape that breaks audit's scalar_one().
        session.add(
            Render(draft_id=draft_id, seo_title="t", meta_description="m", html_body="<p>x</p>")
        )
        session.add(
            Render(draft_id=draft_id, seo_title="t2", meta_description="m2", html_body="<p>y</p>")
        )
        session.add(Citation(draft_id=draft_id, vertex_uri="vtx://1", policy_decision="allow"))
        session.add(
            AuditRun(
                draft_id=draft_id,
                overall_pass=True,
                llm_findings={},
                deterministic_findings={},
            )
        )
        await session.commit()

    runner = RunExecutor(
        postgres_url=postgres_url, session_factory=sf, gemini=FakeGeminiClient(canned_responses={})
    )
    await runner._clear_derived_rows(run_id)

    async with sf() as session:

        async def gone(stmt) -> bool:
            return (await session.execute(stmt)).first() is None

        assert await gone(select(OutlineRow).where(OutlineRow.run_id == run_id))
        assert await gone(select(Draft).where(Draft.run_id == run_id))
        # draft_id children removed via ON DELETE CASCADE.
        assert await gone(select(Render).where(Render.draft_id == draft_id))
        assert await gone(select(Citation).where(Citation.draft_id == draft_id))
        assert await gone(select(AuditRun).where(AuditRun.draft_id == draft_id))
        # The run row itself survives so it can be re-executed.
        run_row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        assert run_row.run_id == run_id

    await engine.dispose()


@pytest.mark.asyncio
async def test_recover_orphaned_fails_in_flight_runs_only(postgres_url):
    """Startup recovery flips in-flight statuses to ``failed`` but leaves HITL
    pauses and terminal runs untouched."""
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)

    def _row(status: str) -> Run:
        return Run(
            run_id=uuid4(),
            created_by="x",
            status=status,
            article_url="https://e.com",
            topic="t",
            keywords=["k"],
            mode="auto",
            acf_adv_id=1,
            acf_widget_id=2,
            persona="bowtie-editor",
            today_date=date(2026, 5, 28),
        )

    in_flight = {
        s: _row(s)
        for s in ("pending", "fetching", "strategy", "production", "publishing")
    }
    untouched = {
        s: _row(s)
        for s in (
            "hitl_1", "hitl_2", "completed", "published",
            "rejected", "changes_requested", "failed",
        )
    }

    async with sf() as session:
        for r in (*in_flight.values(), *untouched.values()):
            session.add(r)
        await session.commit()

    runner = RunExecutor(
        postgres_url=postgres_url, session_factory=sf, gemini=FakeGeminiClient(canned_responses={})
    )
    recovered = await runner.recover_orphaned()

    # Other integration tests share this session-scoped DB and may leave their
    # own in-flight runs behind, so scope the assertion to this test's rows:
    # exactly the in-flight statuses (and none of the untouched ones) recover.
    my_ids = {r.run_id for r in (*in_flight.values(), *untouched.values())}
    assert set(recovered) & my_ids == {r.run_id for r in in_flight.values()}

    async with sf() as session:
        for status, r in in_flight.items():
            row = (await session.execute(select(Run).where(Run.run_id == r.run_id))).scalar_one()
            assert row.status == "failed", f"{status} should have been recovered"
            assert row.error is not None and row.error.get("type") == "OrphanedRun"
        for status, r in untouched.items():
            row = (await session.execute(select(Run).where(Run.run_id == r.run_id))).scalar_one()
            assert row.status == status, f"{status} must not be touched"

    # Idempotent on a clean DB.
    assert await runner.recover_orphaned() == []

    await engine.dispose()


@pytest.mark.asyncio
async def test_hitl2_approve_persists_edits_and_approver(postgres_url, monkeypatch):
    """Approving at HITL_2 must (a) persist the reviewer's inline edits onto the
    latest render so publish pushes them, and (b) stamp approved_by with the
    authenticated editor email (not a placeholder)."""
    monkeypatch.setenv("POSTGRES_URL", postgres_url)
    monkeypatch.setenv("GEMINI_API_KEY", "fake")

    app = create_app()
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)

    run_id = uuid4()
    draft_id = uuid4()
    async with sf() as session:
        session.add(
            Run(
                run_id=run_id,
                created_by="creator@bowtie.com.hk",
                status="hitl_2",
                article_url="https://www.bowtie.com.hk/blog/x",
                topic="x",
                keywords=["x"],
                mode="auto",
                acf_adv_id=1,
                acf_widget_id=2,
                persona="bowtie-editor",
                today_date=date.today(),
            )
        )
        await session.commit()
        session.add(
            Draft(
                draft_id=draft_id,
                run_id=run_id,
                iteration=0,
                diagnose="d",
                markup_raw="<p>orig</p>",
                citation_intents=[],
            )
        )
        await session.commit()
        session.add(
            Render(
                draft_id=draft_id,
                seo_title="orig title",
                meta_description="orig meta",
                html_body="<p>orig</p>",
            )
        )
        await session.commit()

    class _StubExecutor:
        async def resume(self, run_id, update):
            return None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        app.state.session_factory = sf
        app.state.run_executor = _StubExecutor()
        # lifespan() never ran under a bare ASGITransport, so app.state.wp_client
        # is unset — wire a minimal one directly (matches other route tests).
        app.state.wp_client = WordPressClient(
            "https://wp.example.com", username="u", app_password="p",  # noqa: S106
        )
        app.state.wp_target = "staging"

        # Target pin (issue #15): a refresh-run approve must echo back the
        # target the server will resolve. No FetchedArticle is seeded for this
        # run, so the expected post_id is None (create-new).
        resp = await ac.post(
            f"/runs/{run_id}/hitl-2",
            json={
                "decision": "approve",
                "editor_email": "approver@bowtie.com.hk",
                "edited_html_body": "<p>EDITED</p>",
                "edited_seo_title": "EDITED title",
                "edited_meta_description": "EDITED meta",
                "wp_publish_status": "draft",
                "confirmed_target": {
                    "kind": "wordpress",
                    "post_id": None,
                    "label": "staging",
                },
            },
        )
        assert resp.status_code == 200

        async with sf() as session:
            run_row = (
                await session.execute(select(Run).where(Run.run_id == run_id))
            ).scalar_one()
            assert run_row.approved_by == "approver@bowtie.com.hk"
            assert run_row.approved_at is not None

            render_row = (
                await session.execute(select(Render).where(Render.draft_id == draft_id))
            ).scalar_one()
            assert render_row.html_body == "<p>EDITED</p>"
            assert render_row.seo_title == "EDITED title"
            assert render_row.meta_description == "EDITED meta"

    await engine.dispose()
