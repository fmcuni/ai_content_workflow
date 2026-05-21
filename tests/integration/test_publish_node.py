from datetime import date, datetime
from uuid import uuid4

import pytest
import respx
from httpx import Response
from sqlalchemy import select

from content_tool.agents.publish import publish_to_wordpress
from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Render, Run
from content_tool.wordpress.client import WordPressClient


@pytest.mark.asyncio
async def test_publish_node_updates_runs(db_session):
    run_id = uuid4()
    db_session.add(Run(
        run_id=run_id, created_by="x", status="hitl_2",
        article_url="https://e.com", topic="x", keywords=[], mode="auto",
        acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
        today_date=date(2026, 5, 21), chosen_route="small_refresh",
        wp_publish_status="draft", wp_category_ids=[42], wp_author_id=5,
        approved_at=datetime.utcnow(), approved_by="e@x.com",
    ))
    await db_session.commit()
    db_session.add(FetchedArticle(run_id=run_id, wp_post_id=98785, wp_categories=[],
                                  raw_html="x", markdown="x"))
    db_session.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={}))
    db_session.add(OutlineRow(run_id=run_id, payload={}))
    draft = Draft(
        run_id=run_id, iteration=0, diagnose="d", markup_raw="x", final_markup="x",
        citation_intents=[],
    )
    db_session.add(draft)
    await db_session.commit()
    await db_session.refresh(draft)
    db_session.add(Render(
        draft_id=draft.draft_id, seo_title="新標題", meta_description="meta",
        html_body="<p>x</p>", excerpt_suggestion="e", slug_suggestion=None,
    ))
    await db_session.commit()

    with respx.mock(assert_all_called=True) as r:
        r.put("https://wp.example.com/wp-json/wp/v2/posts/98785").mock(
            return_value=Response(200, json={
                "id": 98785, "link": "https://wp.example.com/x",
                "status": "draft", "modified_gmt": "2026-05-21T10:00:00",
                "slug": "x",
            })
        )
        client = WordPressClient("https://wp.example.com", username="u", app_password="p")  # noqa: S106
        await publish_to_wordpress(
            session=db_session, run_id=run_id, wp_client=client, seo_plugin="yoast",
            if_unmodified_since="2026-04-12T08:30:00",
        )

    updated = (await db_session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert updated.wp_pushed_post_id == 98785
    assert updated.status == "published"
