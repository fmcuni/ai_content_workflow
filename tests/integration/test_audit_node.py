import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.audit import run_audit
from content_tool.db.models import (
    AuditRun,
    Draft,
    FetchedArticle,
    GapAnalysisRow,
    OutlineRow,
    Render,
    Run,
)
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_audit_pass_flow(db_session):
    run_id = uuid4()
    db_session.add(
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
    await db_session.commit()
    db_session.add(
        FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="x")
    )
    db_session.add(
        GapAnalysisRow(
            run_id=run_id,
            model="x",
            thinking_level="high",
            payload={"update_plan": {}},
        )
    )
    db_session.add(OutlineRow(run_id=run_id, payload={}))
    draft = Draft(
        run_id=run_id,
        iteration=0,
        diagnose="d",
        markup_raw="# H1\nbody",
        final_markup="# H1\nbody",
        citation_intents=[],
    )
    db_session.add(draft)
    await db_session.commit()
    await db_session.refresh(draft)
    # Render passes all det checks
    db_session.add(
        Render(
            draft_id=draft.draft_id,
            seo_title="H1",
            meta_description="m",
            html_body=(
                '<script type="application/ld+json">{"@type":"FAQPage"}</script>'
                '<p>x</p>[adv_panel id="1"]<h2>x</h2><p>y</p>[page_widget id="2"]'
                '<h2>常見問題</h2><div class="editor__item editor__faq">x</div>'
                "<h2>資訊來源</h2><ol><li>x</li></ol>"
            ),
        )
    )
    await db_session.commit()

    canned = json.loads(
        Path("tests/fixtures/gemini_responses/audit_pass.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    )
    gemini = FakeGeminiClient(canned_responses={"audit": canned})

    res = await run_audit(
        session=db_session,
        gemini=gemini,
        draft_id=draft.draft_id,
        topic_category=None,
        today=date(2026, 5, 21),
    )
    assert res.overall_pass is True

    row = (
        await db_session.execute(
            select(AuditRun).where(AuditRun.draft_id == draft.draft_id)
        )
    ).scalar_one()
    assert row.overall_pass is True
