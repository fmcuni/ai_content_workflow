from datetime import date
from uuid import uuid4

import pytest
import respx
from httpx import Response
from sqlalchemy import select

from content_tool.agents.resolve_citations import run_resolve_citations
from content_tool.db.models import Citation, Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Run


@pytest.mark.asyncio
async def test_drops_denied_sources(db_session):
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
    db_session.add(FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="x"))
    db_session.add(GapAnalysisRow(run_id=run_id, model="x", thinking_level="high", payload={}))
    db_session.add(OutlineRow(run_id=run_id, payload={}))
    draft = Draft(
        run_id=run_id,
        iteration=0,
        diagnose="d",
        markup_raw="# H1\nbody\n",
        citation_intents=[],
        grounding_chunks=[
            {"web": {"uri": "https://vertexaisearch.cloud.google.com/a", "title": "Bowtie"}},
            {"web": {"uri": "https://vertexaisearch.cloud.google.com/b", "title": "IA"}},
        ],
    )
    db_session.add(draft)
    await db_session.commit()

    with respx.mock(assert_all_called=True) as router:
        router.head("https://vertexaisearch.cloud.google.com/a").mock(
            return_value=Response(302, headers={"Location": "https://www.bowtie.com.hk/x"})
        )
        router.head("https://www.bowtie.com.hk/x").mock(return_value=Response(200))
        router.head("https://vertexaisearch.cloud.google.com/b").mock(
            return_value=Response(302, headers={"Location": "https://www.ia.org.hk/y"})
        )
        router.head("https://www.ia.org.hk/y").mock(return_value=Response(200))

        result = await run_resolve_citations(
            session=db_session, draft_id=draft.draft_id, topic_category=None
        )

    citations = (
        await db_session.execute(select(Citation).where(Citation.draft_id == draft.draft_id))
    ).scalars().all()
    bowtie = next(c for c in citations if c.domain == "bowtie.com.hk")
    ia = next(c for c in citations if c.domain == "ia.org.hk")

    assert bowtie.policy_decision == "denied"
    assert bowtie.denied_reason == "bowtie_owned"
    assert bowtie.was_displayed is False
    assert ia.policy_decision == "allowed"
    assert ia.was_displayed is True

    assert "## 資訊來源" in result["final_markup"]
    assert "ia.org.hk" in result["final_markup"]
    assert "bowtie.com.hk" not in result["final_markup"]
