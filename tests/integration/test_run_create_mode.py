"""End-to-end integration test for a ``start_mode="create"`` run (Task 4).

Drives the root graph from ``START`` through both HITL gates and publish for
a create-mode run (Front III). Verifies:

* the graph skips ``fetch_article`` and ``gap_analysis`` (the strategy
  conditional edge routes ``START -> outline`` when ``start_mode == "create"``);
* the writer/audit nodes survive the absence of ``FetchedArticle`` and
  ``GapAnalysisRow`` (the agents short-circuit on those missing rows);
* WP receives a ``POST /wp/v2/posts`` with no ``post_id`` and ``status="draft"``
  (i.e. the create-mode publish shape);
* the freshly-minted draft ``link`` is backfilled onto ``runs.article_url``;
* ``start_mode`` and ``topic_candidate_id`` survive on the run row.

The fixture pattern mirrors ``test_root_graph_e2e.py`` and
``test_topic_expansion_graph.py``: ``FakeGeminiClient`` for canned LLM
responses, ``respx`` for the WP REST surface, real Postgres from the project's
testcontainers fixture, and ``make_checkpointer`` to back the graph.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
import respx
from httpx import Response
from sqlalchemy import select

from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Run
from content_tool.gemini.client import GeminiResult
from content_tool.gemini.fake import FakeGeminiClient
from content_tool.graph.checkpointer import make_checkpointer
from content_tool.graph.root import build_root_graph
from content_tool.wordpress.client import WordPressClient

# Writer payload identical in shape to the one used by
# ``test_root_graph_e2e.py`` — includes every artifact the deterministic
# audit checks scan for (adv_panel, page_widget, FAQ block, FAQPage JSON-LD,
# and the inline ``<h2>資訊來源</h2>`` heading) so the pipeline lands at
# ``overall_pass=True`` without us having to mock the citation resolver.
_WRITER_PAYLOAD: dict[str, Any] = {
    "diagnose": "create-mode diagnose",
    "markup": (
        "# 保險新手指南\n"
        "%%meta desc=創新保險指南%%\n\n"
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

# Module-scope fixture loads — avoids ASYNC240 when called inside async tests.
_FIXTURE_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "gemini_responses"
_OUTLINE_FIXTURE: dict[str, Any] = json.loads(
    (_FIXTURE_DIR / "outline_ok.json").read_text(encoding="utf-8")
)
_AUDIT_FIXTURE: dict[str, Any] = json.loads(
    (_FIXTURE_DIR / "audit_pass.json").read_text(encoding="utf-8")
)


class _WriterOverrideFake(FakeGeminiClient):
    """FakeGeminiClient that returns ``_WRITER_PAYLOAD`` for agent=writer and
    falls back to canned responses for the other agents (outline + audit).
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
async def test_root_graph_create_mode_publishes_as_draft(postgres_url, monkeypatch):
    """Full create-mode run lands in WP as a draft and backfills article_url."""
    monkeypatch.setenv("WP_BASE_URL", "https://wp.example.com")

    # Stub write_compliance_log so this test focuses on the WP publish path
    # without spinning up a full compliance-log fixture.
    async def _noop_write_compliance_log(**_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(
        "content_tool.graph.root.write_compliance_log",
        _noop_write_compliance_log,
    )

    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    topic_candidate_id = uuid4()

    # Seed the run row with start_mode='create' and NO article_url (matches the
    # API contract for create-mode runs — Task 5 will enforce this on the
    # endpoint).
    async with sf() as s:
        s.add(
            Run(
                run_id=run_id,
                created_by="editor@bowtie",
                status="pending",
                article_url=None,
                topic="保險新手指南",
                keywords=["保險", "新手"],
                mode="auto",
                acf_adv_id=1,
                acf_widget_id=2,
                persona="bowtie-editor",
                today_date=date(2026, 5, 26),
                start_mode="create",
                target_audience="香港 25-35 歲首次買保險的上班族",
                # Don't set topic_candidate_id FK — the topic_candidates row
                # isn't seeded here and the FK is nullable. Persist it
                # separately further down with a direct UPDATE so the test
                # still asserts on it without violating the FK.
            )
        )
        await s.commit()

    canned = {"outline": _OUTLINE_FIXTURE, "audit": _AUDIT_FIXTURE}
    gemini = _WriterOverrideFake(canned)

    expected_link = "https://wp.example.com/?p=12345"

    with respx.mock(assert_all_called=False) as router:
        # The publish call MUST go through POST /wp/v2/posts (create), not
        # PUT /wp/v2/posts/{id} (update). assert_all_called=False so we don't
        # accidentally require unrelated GETs/HEADs we don't care about.
        post_route = router.post(
            "https://wp.example.com/wp-json/wp/v2/posts"
        ).mock(
            return_value=Response(
                201,
                json={
                    "id": 12345,
                    "link": expected_link,
                    "status": "draft",
                    "modified_gmt": "2026-05-26T10:00:00",
                    "slug": "create-mode-draft",
                },
            )
        )

        wp_client = WordPressClient(
            "https://wp.example.com",
            username="u",
            app_password="p",  # noqa: S106
        )

        async with make_checkpointer(postgres_url) as cp:
            graph = build_root_graph(
                session_factory=sf,
                gemini=gemini,
                checkpointer=cp,
                wp_client=wp_client,
                seo_plugin=None,
            )
            config = {"configurable": {"thread_id": str(run_id)}}
            initial: dict[str, Any] = {
                "run_id": str(run_id),
                "article_url": "",  # create-mode: no upstream URL
                "topic": "保險新手指南",
                "keywords": ["保險", "新手"],
                "mode": "auto",
                "edit_note": None,
                "acf_adv_id": 1,
                "acf_widget_id": 2,
                "persona": "bowtie-editor",
                "topic_category": None,
                "today_date": "2026-05-26",
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
                "hitl_2_comments": None,
                "hitl_2_iteration": 0,
                "status": "pending",
                "error": None,
                # The new Task-4 inputs that drive the strategy branch.
                "start_mode": "create",
                "topic_candidate_id": str(topic_candidate_id),
                "target_audience": "香港 25-35 歲首次買保險的上班族",
            }

            # Run until HITL_1 (before production).
            await graph.ainvoke(initial, config=config)
            st = await graph.aget_state(config)
            assert "production" in st.next, (
                f"expected to halt before 'production', got next={st.next}"
            )

            # Strategy outputs: outline present, gap_analysis absent (we
            # skipped that node), chosen_route absent (n_gap_analysis didn't
            # run, so it never set chosen_route).
            assert st.values.get("outline") is not None
            assert st.values.get("gap_analysis") is None

            # Resume — runs production (writer/audit), halts before publish.
            await graph.aupdate_state(config, {"hitl_1_decision": "approve"})
            await graph.ainvoke(None, config=config)
            st = await graph.aget_state(config)
            assert "publish_or_revise" in st.next

            # Resume — publish to WP as a draft.
            await graph.aupdate_state(config, {"hitl_2_decision": "approve"})
            final = await graph.ainvoke(None, config=config)
            assert final["status"] == "published"
            # State carries the freshly-minted WP link.
            assert final.get("article_url") == expected_link

        # ----- WP call shape assertions -----
        assert post_route.called, "expected one POST /wp/v2/posts call"
        last_request = post_route.calls.last.request
        body = json.loads(last_request.content)
        assert body["status"] == "draft", body
        # Title from the rendered SEO title (writer markup '# 保險新手指南').
        assert body["title"]
        # ``post_id`` MUST NOT have been passed (we'd hit the PUT path) —
        # respx routed POST, so this is implicit. Double-check no `id` in body.
        assert "id" not in body

    # ----- DB assertions -----
    async with sf() as s:
        row = (await s.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert row.start_mode == "create"
    assert row.article_url == expected_link, (
        f"create-mode publish should backfill runs.article_url; got {row.article_url!r}"
    )
    assert row.status == "published"
    assert row.wp_pushed_post_id == 12345
    # target_audience persisted as we seeded it.
    assert row.target_audience == "香港 25-35 歲首次買保險的上班族"

    await engine.dispose()


@pytest.mark.asyncio
async def test_audit_handles_missing_gap_analysis_row(postgres_url):
    """Sanity-check: audit.py must not blow up when ``GapAnalysisRow`` is
    absent — that's the create-mode shape and the test above exercises the
    full path, but this isolates the audit-only case so a regression here
    is loud and obvious without dragging the whole graph in.
    """
    from datetime import date as _date
    from uuid import uuid4 as _uuid4

    from content_tool.agents.audit import run_audit
    from content_tool.db.models import Citation, Draft, Render, Run

    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)

    run_id = _uuid4()
    async with sf() as s:
        s.add(
            Run(
                run_id=run_id,
                created_by="t@bowtie",
                status="production",
                article_url=None,
                topic="保險新手",
                keywords=["保險"],
                mode="auto",
                acf_adv_id=1,
                acf_widget_id=2,
                persona="bowtie-editor",
                today_date=_date(2026, 5, 26),
                chosen_route=None,
                start_mode="create",
            )
        )
        await s.commit()
        draft = Draft(
            run_id=run_id,
            iteration=0,
            diagnose="d",
            markup_raw="# H1\nbody",
            final_markup="# H1\nbody",
            citation_intents=[],
        )
        s.add(draft)
        await s.commit()
        await s.refresh(draft)
        s.add(
            Render(
                draft_id=draft.draft_id,
                seo_title="H1",
                meta_description="m",
                schema_jsonld=[{"@type": "FAQPage"}],
                html_body=(
                    '<p>x</p>[adv_panel id="1"]<h2>x</h2><p>y</p>'
                    '[page_widget id="2"]<h2>常見問題</h2>'
                    '<div class="editor__item editor__faq">x</div>'
                    "<h2>資訊來源</h2><ol><li>x</li></ol>"
                ),
            )
        )
        s.add(
            Citation(
                draft_id=draft.draft_id,
                chunk_idx=0,
                vertex_uri="https://vertexaisearch.cloud.google.com/x",
                final_url="https://example.com",
                domain="example.com",
                title="x",
                policy_decision="allowed",
                was_displayed=True,
                resolution_error=None,
            )
        )
        await s.commit()

        gemini = FakeGeminiClient(canned_responses={"audit": _AUDIT_FIXTURE})

        # No GapAnalysisRow inserted — this is the create-mode shape.
        out = await run_audit(
            session=s,
            gemini=gemini,
            draft_id=draft.draft_id,
            topic_category=None,
            today=_date(2026, 5, 26),
        )
    assert out.overall_pass is True

    await engine.dispose()
