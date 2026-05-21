import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
import respx

from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import (
    FetchedArticle,
    GapAnalysisRow,
    OutlineRow,
    Run,
)
from content_tool.gemini.client import GeminiResult
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.graph.production import build_production_graph


class CountingFakeGemini(FakeGeminiClient):
    """First audit call fails, second passes — exercises the refine loop."""

    def __init__(self, canned):
        super().__init__(canned)
        self.audit_calls = 0

    async def generate(self, **kwargs):
        if kwargs["agent"] == "audit":
            self.audit_calls += 1
            if self.audit_calls == 1:
                parsed = self._canned["audit_fail"]
            else:
                parsed = self._canned["audit_pass"]
            self.calls.append(kwargs)
            return GeminiResult(
                parsed=parsed,
                raw_text=json.dumps(parsed),
                tokens_in=100,
                tokens_out=50,
                thinking_tokens=10,
                latency_ms=5,
            )
        return await super().generate(**kwargs)


@pytest.mark.asyncio
async def test_refine_loop_iterates_then_passes(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    async with sf() as s:
        s.add(
            Run(
                run_id=run_id,
                created_by="x",
                status="production",
                article_url="https://e.com",
                topic="x",
                keywords=[],
                mode="auto",
                acf_adv_id=1,
                acf_widget_id=2,
                persona="bowtie-editor",
                today_date=date(2026, 5, 21),
                chosen_route="small_refresh",
            )
        )
        await s.commit()
    async with sf() as s:
        s.add(FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="x"))
        s.add(
            GapAnalysisRow(
                run_id=run_id,
                model="x",
                thinking_level="high",
                payload={"update_plan": {}},
            )
        )
        s.add(OutlineRow(run_id=run_id, payload={}))
        await s.commit()

    fixtures = Path("tests/fixtures/gemini_responses")
    # Writer payload: must pass all deterministic checks (adv_panel, page_widget,
    # FAQ block, and 資訊來源 heading) so that after the LLM audit returns
    # audit_pass.json on the 2nd attempt, the recomputed overall_pass is True.
    writer_payload = {
        "diagnose": "refine ok",
        "markup": (
            "# Title\n"
            "%%meta desc=meta description here%%\n\n"
            "intro paragraph\n\n"
            "%%adv_panel id=1%%\n\n"
            "## Section\nbody text\n\n"
            "%%page_widget id=2%%\n\n"
            "## 常見問題\n"
            "%%acf_faq type=q%%\n"
            "Q1?\n"
            "%%acf_faq type=a%%\n"
            "A1.\n"
            "%%end%%\n\n"
            "## 資訊來源\n"
            "1. [example](https://example.org)\n"
        ),
        "citation_intents": [],
    }
    canned = {
        "writer": writer_payload,
        "audit_fail": json.loads(
            (fixtures / "audit_fail.json").read_text(encoding="utf-8")
        ),
        "audit_pass": json.loads(
            (fixtures / "audit_pass.json").read_text(encoding="utf-8")
        ),
    }
    gemini = CountingFakeGemini(canned)

    graph = build_production_graph(session_factory=sf, gemini=gemini).compile()
    initial = {
        "run_id": str(run_id),
        "article_url": "x",
        "topic": "x",
        "keywords": [],
        "mode": "auto",
        "edit_note": None,
        "acf_adv_id": 1,
        "acf_widget_id": 2,
        "persona": "bowtie-editor",
        "topic_category": None,
        "today_date": "2026-05-21",
        "existing_article_markdown": "x",
        "wp_post_id": 1,
        "wp_categories": [],
        "gap_analysis": {"update_plan": {}},
        "outline": {},
        "chosen_route": "small_refresh",
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
        "status": "production",
        "error": None,
    }

    with respx.mock(assert_all_called=False):
        final = await graph.ainvoke(initial)

    assert final["audit_findings"]["overall_pass"] is True
    assert gemini.audit_calls == 2
    await engine.dispose()
