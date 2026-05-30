import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.gap_analysis import run_gap_analysis
from content_tool.config import Settings
from content_tool.db.models import GapAnalysisRow, Run
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_gap_analysis_writes_db_and_returns_parsed(db_session):
    # seed a run
    run_id = uuid4()
    db_session.add(
        Run(
            run_id=run_id,
            created_by="test@example.com",
            status="strategy",
            article_url="https://www.bowtie.com.hk/blog/post",
            topic="大腸癌篩查",
            keywords=["大腸癌", "篩查"],
            mode="auto",
            acf_adv_id=1,
            acf_widget_id=2,
            persona="bowtie-editor",
            today_date=date(2026, 5, 21),
        )
    )
    await db_session.commit()

    canned = json.loads(
        Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    )
    gemini = FakeGeminiClient(canned_responses={"gap_analysis": canned})

    # Pin model/thinking-level so the row assertion is independent of ambient
    # config (.env.local / desktop config.json) — init kwargs win over env.
    settings = Settings(gemini_model="gemini-3.5-flash", gemini_thinking_level="high")
    result = await run_gap_analysis(
        session=db_session,
        gemini=gemini,
        run_id=run_id,
        today=date(2026, 5, 21),
        settings=settings,
    )

    assert result.chosen_route == "small_refresh"

    # gap_analyses row was inserted
    row = (
        await db_session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))
    ).scalar_one()
    assert row.model == "gemini-3.5-flash"
    assert row.thinking_level == "high"
    assert row.payload["chosen_route"] == "small_refresh"

    # runs.chosen_route updated
    updated = (await db_session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert updated.chosen_route == "small_refresh"


@pytest.mark.asyncio
async def test_route_override_forces_chosen_route(db_session):
    run_id = uuid4()
    db_session.add(
        Run(
            run_id=run_id,
            created_by="test@example.com",
            status="strategy",
            article_url="https://example.com",
            topic="x",
            keywords=[],
            mode="full_rewrite",
            acf_adv_id=1,
            acf_widget_id=2,
            persona="bowtie-editor",
            today_date=date(2026, 5, 21),
        )
    )
    await db_session.commit()

    canned = json.loads(
        Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    )
    # canned says small_refresh; user mode says full_rewrite → override wins
    gemini = FakeGeminiClient(canned_responses={"gap_analysis": canned})

    result = await run_gap_analysis(
        session=db_session, gemini=gemini, run_id=run_id, today=date(2026, 5, 21)
    )

    assert result.chosen_route == "full_rewrite"  # override applied
