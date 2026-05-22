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
from content_tool.db.models import Run
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_create_run_then_resume(postgres_url, monkeypatch):
    monkeypatch.setenv("POSTGRES_URL", postgres_url)
    monkeypatch.setenv("GEMINI_API_KEY", "fake")

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
            # Slug-based fetch via WordPressClient (wp_base_url = staging.bowtie.com.hk)
            router.get("https://staging.bowtie.com.hk/wp-json/wp/v2/posts").mock(
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
