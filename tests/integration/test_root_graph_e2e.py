import json
from datetime import date
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
import respx
from httpx import Response

from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Run
from content_tool.gemini.client import GeminiResult
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.root import build_root_graph

# Writer fixture that includes all 5 required artifacts (adv_panel, page_widget,
# editor__faq, FAQPage JSON-LD, <h2>資訊來源</h2>) so the deterministic audit
# checks pass cleanly. The shared writer_small_refresh_ok.json fixture omits
# "## 資訊來源" because resolve_citations is supposed to inject it from
# grounding_chunks — but in this test no grounding chunks are returned, so we
# inline the heading instead.
_WRITER_PAYLOAD: dict[str, Any] = {
    "diagnose": "test diagnose",
    "markup": (
        "# 大腸癌指南\n"
        "%%meta desc=描述%%\n\n"
        "首段。\n\n"
        "%%adv_panel id=1%%\n\n"
        "## 章節\n"
        "段落。\n\n"
        "%%page_widget id=2%%\n\n"
        "## 常見問題\n"
        "%%acf_faq type=q%%\nQ1\n%%acf_faq type=a%%\nA1\n%%end%%\n\n"
        "## 資訊來源\n"
    ),
    "citation_intents": [],
}


class WriterOverrideFake(FakeGeminiClient):
    """FakeGeminiClient that returns _WRITER_PAYLOAD for the writer agent and
    falls back to canned responses for other agents (gap_analysis, outline, audit).
    """

    async def generate(self, **kwargs: Any) -> GeminiResult:
        if kwargs["agent"] == "writer":
            self.calls.append(kwargs)
            return GeminiResult(
                parsed=_WRITER_PAYLOAD,
                raw_text=json.dumps(_WRITER_PAYLOAD, ensure_ascii=False),
                tokens_in=100,
                tokens_out=50,
                thinking_tokens=10,
                latency_ms=5,
            )
        return await super().generate(**kwargs)


@pytest.mark.asyncio
async def test_root_graph_with_two_hitl_resumes(postgres_url, monkeypatch):
    monkeypatch.setenv("WP_BASE_URL", "https://www.bowtie.com.hk/blog")

    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    async with sf() as s:
        s.add(
            Run(
                run_id=run_id,
                created_by="e@x.com",
                status="pending",
                article_url="https://www.bowtie.com.hk/blog/zh/x/",
                topic="x",
                keywords=["x"],
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
        "audit": json.loads(
            Path("tests/fixtures/gemini_responses/audit_pass.json").read_text(encoding="utf-8")  # noqa: ASYNC240
        ),
    }
    gemini = WriterOverrideFake(canned)

    with respx.mock(assert_all_called=False) as router:
        # Slug-based fetch via WordPressClient (wp_base_url = www.bowtie.com.hk/blog)
        router.get("https://www.bowtie.com.hk/blog/wp-json/wp/v2/posts").mock(
            return_value=Response(
                200,
                json=[
                    {
                        "id": 99,
                        "slug": "x",
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
        # No HEAD requests for grounding chunks expected — writer payload has no chunks.

        async with make_checkpointer(postgres_url) as cp:
            graph = build_root_graph(session_factory=sf, gemini=gemini, checkpointer=cp)
            config = {"configurable": {"thread_id": str(run_id)}}
            initial: dict[str, Any] = {
                "run_id": str(run_id),
                "article_url": "https://www.bowtie.com.hk/blog/zh/x/",
                "topic": "x",
                "keywords": ["x"],
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

            # Run until first interrupt (HITL_1, before production).
            await graph.ainvoke(initial, config=config)
            st = await graph.aget_state(config)
            assert "production" in st.next

            # Resume — proceeds into production, then halts before publish.
            await graph.aupdate_state(config, {"hitl_1_decision": "approve"})
            await graph.ainvoke(None, config=config)
            st = await graph.aget_state(config)
            assert "publish" in st.next

            # Resume — final publish (no wp_client → falls back to "persisted").
            await graph.aupdate_state(config, {"hitl_2_decision": "approve"})
            final = await graph.ainvoke(None, config=config)
            assert final["status"] == "persisted"

    await engine.dispose()
