import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
import respx
from httpx import Response
from sqlalchemy import select

from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import OutlineRow, Run
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.strategy import build_strategy_graph


@pytest.mark.asyncio
async def test_strategy_subgraph_end_to_end(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)

    # Seed run
    run_id = uuid4()
    async with sf() as s:
        s.add(
            Run(
                run_id=run_id,
                created_by="x",
                status="pending",
                article_url="https://www.bowtie.com.hk/blog/zh/cancer-screening/",
                topic="大腸癌",
                keywords=["大腸癌"],
                mode="auto",
                acf_adv_id=1,
                acf_widget_id=2,
                persona="bowtie-editor",
                today_date=date(2026, 5, 21),
            )
        )
        await s.commit()

    canned = {
        "gap_analysis": json.loads(
            Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
        ),
        "outline": json.loads(
            Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
        ),
    }
    gemini = FakeGeminiClient(canned_responses=canned)

    with respx.mock(assert_all_called=True) as router:
        # Slug-based fetch via WordPressClient (wp_base_url = staging.bowtie.com.hk)
        router.get("https://staging.bowtie.com.hk/wp-json/wp/v2/posts").mock(
            return_value=Response(
                200,
                json=[
                    {
                        "id": 98785,
                        "slug": "cancer-screening",
                        "categories": [42],
                        "link": "https://example.com",
                        "title": {"rendered": "x"},
                        "status": "publish",
                        "author": 5,
                        "modified_gmt": "2026-04-12T08:30:00",
                        "content": {"rendered": "<h2>大腸癌</h2><p>內容</p>"},
                    }
                ],
            )
        )
        # Categories via _WP_BASE_DEFAULT
        router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/categories").mock(
            return_value=Response(200, json=[{"id": 42, "name": "癌症", "slug": "cancer"}])
        )

        async with make_checkpointer(postgres_url) as cp:
            graph = build_strategy_graph(session_factory=sf, gemini=gemini).compile(checkpointer=cp)
            config = {"configurable": {"thread_id": str(run_id)}}
            initial: dict = {
                "run_id": str(run_id),
                "article_url": "https://www.bowtie.com.hk/blog/zh/cancer-screening/",
                "topic": "大腸癌",
                "keywords": ["大腸癌"],
                "mode": "auto",
                "edit_note": None,
                "acf_adv_id": 1,
                "acf_widget_id": 2,
                "persona": "bowtie-editor",
                "topic_category": None,
                "today_date": "2026-05-21",
                "existing_article_markdown": None,
                "wp_post_id": None,
                "wp_categories": None,
                "gap_analysis": None,
                "outline": None,
                "chosen_route": None,
                "writer_output": None,
                "grounding_chunks": None,
                "citations": None,
                "render": None,
                "final_markup": None,
                "audit_findings": None,
                "iteration": 0,
                "hitl_1_decision": None,
                "hitl_1_edits": None,
                "hitl_2_decision": None,
                "hitl_2_notes": None,
                "status": "pending",
                "error": None,
            }
            final = await graph.ainvoke(initial, config=config)

    assert final["chosen_route"] == "small_refresh"
    assert final["outline"]["h1"].startswith("大腸癌")

    async with sf() as s:
        row = (await s.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))).scalar_one()
        assert row.payload["h1"] == final["outline"]["h1"]

    await engine.dispose()
