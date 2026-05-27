import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.outline import run_outline
from content_tool.db.models import FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_outline_node_persists_and_returns(db_session):
    run_id = uuid4()
    db_session.add(
        Run(
            run_id=run_id,
            created_by="x",
            status="strategy",
            article_url="https://e.com",
            topic="大腸癌",
            keywords=["大腸癌"],
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
        FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="# old article")
    )
    ga_payload = json.loads(
        Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    )
    db_session.add(
        GapAnalysisRow(
            run_id=run_id,
            model="gemini-3.5-flash",
            thinking_level="high",
            payload=ga_payload,
        )
    )
    await db_session.commit()

    canned = json.loads(
        Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    )
    gemini = FakeGeminiClient(canned_responses={"outline": canned})

    out = await run_outline(
        session=db_session, gemini=gemini, run_id=run_id, today=date(2026, 5, 21)
    )

    assert out.h1.startswith("大腸癌")
    row = (
        await db_session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))
    ).scalar_one()
    assert row.payload["h1"] == out.h1
    assert row.edited_by_human is False


@pytest.mark.asyncio
async def test_outline_node_rerun_upserts_and_preserves_human_edits(db_session):
    run_id = uuid4()
    db_session.add(
        Run(
            run_id=run_id,
            created_by="x",
            status="strategy",
            article_url="https://e.com",
            topic="大腸癌",
            keywords=["大腸癌"],
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
        FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="# old article")
    )
    ga_payload = json.loads(
        Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    )
    db_session.add(
        GapAnalysisRow(
            run_id=run_id,
            model="gemini-3.5-flash",
            thinking_level="high",
            payload=ga_payload,
        )
    )
    await db_session.commit()

    canned = json.loads(
        Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    )
    gemini = FakeGeminiClient(canned_responses={"outline": canned})

    await run_outline(session=db_session, gemini=gemini, run_id=run_id, today=date(2026, 5, 21))

    # Simulate a human edit landing on the row between the first and second run.
    row = (
        await db_session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))
    ).scalar_one()
    row.edited_by_human = True
    row.human_edits = {"h1": "edited"}
    await db_session.commit()

    # Re-running the node (e.g. after a restart) must not raise outlines_pkey.
    out2 = await run_outline(
        session=db_session, gemini=gemini, run_id=run_id, today=date(2026, 5, 21)
    )

    row = (
        await db_session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))
    ).scalar_one()
    assert row.payload["h1"] == out2.h1
    assert row.edited_by_human is True
    assert row.human_edits == {"h1": "edited"}
