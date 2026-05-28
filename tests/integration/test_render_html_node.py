from datetime import date
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.render_html import run_render_html
from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Render, Run


@pytest.mark.asyncio
async def test_render_html_node_writes_renders_row(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="production",
        article_url="https://e.com", topic="x", keywords=[], mode="auto",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        today_date=date(2026, 5, 21), chosen_route="small_refresh",
    ))
    await db_session.commit()
    db_session.add(FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="x"))
    db_session.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={}))
    db_session.add(OutlineRow(run_id=run_id, payload={}))
    raw_md = "# H1\n%%meta desc=m%%\n\nfirst para.\n\n%%adv_panel id=1%%\n\n## x\nbody\n"
    final_md = raw_md + "\n## 資訊來源\n1. [a.gov](https://a.gov/x)\n"
    draft = Draft(
        run_id=run_id, iteration=0, diagnose="d",
        markup_raw=raw_md,
        final_markup=final_md,
        citation_intents=[],
    )
    db_session.add(draft)
    await db_session.commit()

    result = await run_render_html(session=db_session, draft_id=draft.draft_id)

    assert result.seo_title == "H1"
    row = (
        await db_session.execute(select(Render).where(Render.draft_id == draft.draft_id))
    ).scalar_one()
    assert row.html_body == result.html_body


@pytest.mark.asyncio
async def test_render_html_node_is_idempotent_on_replay(db_session):
    """Re-running the node for the same draft must leave exactly one Render row.

    LangGraph re-enters the production sub-graph on resume / retry / refine
    loop, calling ``run_render_html`` again for the same draft. Without
    DELETE-before-INSERT we accumulate duplicate Render rows and the audit
    node's ``scalar_one()`` on ``Render.draft_id`` blows up.
    """
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="production",
        article_url="https://e.com", topic="x", keywords=[], mode="auto",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        today_date=date(2026, 5, 28), chosen_route="small_refresh",
    ))
    await db_session.commit()
    db_session.add(OutlineRow(run_id=run_id, payload={}))
    raw_md = "# H1\n%%meta desc=m%%\n\nfirst para.\n\n%%adv_panel id=1%%\n\n## x\nbody\n"
    final_md_v1 = raw_md + "\n## 資訊來源\n1. [a.gov](https://a.gov/x)\n"
    final_md_v2 = raw_md + "\n## 資訊來源\n1. [b.gov](https://b.gov/x)\n"
    draft = Draft(
        run_id=run_id, iteration=0, diagnose="d",
        markup_raw=raw_md, final_markup=final_md_v1, citation_intents=[],
    )
    db_session.add(draft)
    await db_session.commit()

    await run_render_html(session=db_session, draft_id=draft.draft_id)

    # Simulate the refine loop / resume: caller updates final_markup and
    # re-invokes the node.
    draft.final_markup = final_md_v2
    await db_session.commit()
    second = await run_render_html(session=db_session, draft_id=draft.draft_id)

    rows = (
        await db_session.execute(select(Render).where(Render.draft_id == draft.draft_id))
    ).scalars().all()
    assert len(rows) == 1, f"expected single Render row, found {len(rows)}"
    assert rows[0].html_body == second.html_body
