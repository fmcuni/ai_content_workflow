import asyncio
import json
from pathlib import Path
from uuid import UUID

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response

from content_tool.api.main import create_app
from content_tool.api.sse import RunExecutor
from content_tool.db.connection import make_engine, make_session_factory
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
            router.get("https://www.bowtie.com.hk/blog/zh/cancer-screening/").mock(
                return_value=Response(
                    200,
                    headers={"Link": "<https://www.bowtie.com.hk/blog/?p=98785>; rel=shortlink"},
                    text="x",
                )
            )
            router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/posts/98785").mock(
                return_value=Response(
                    200,
                    json={
                        "id": 98785,
                        "slug": "x",
                        "categories": [42],
                        "link": "x",
                        "title": {"rendered": "x"},
                        "status": "publish",
                        "author": 5,
                        "modified_gmt": "2026-04-12T08:30:00",
                        "content": {"rendered": "<p>x</p>"},
                    },
                )
            )
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
