import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from content_tool.agents.writer import run_writer
from content_tool.db.models import Draft, FetchedArticle, GapAnalysisRow, OutlineRow, Run
from content_tool.gemini.fake import FakeGeminiClient


@pytest.mark.asyncio
async def test_writer_writes_draft_iteration_0(db_session):
    run_id = uuid4()
    db_session.add(
        Run(
            run_id=run_id,
            created_by="x",
            status="production",
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
        FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="# old")
    )
    db_session.add(
        GapAnalysisRow(
            run_id=run_id,
            model="gemini-3.5-flash",
            thinking_level="high",
            payload=json.loads(
                Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
            ),
        )
    )
    db_session.add(
        OutlineRow(
            run_id=run_id,
            payload=json.loads(
                Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
            ),
        )
    )
    await db_session.commit()

    canned = json.loads(
        Path("tests/fixtures/gemini_responses/writer_small_refresh_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    )
    gemini = FakeGeminiClient(canned_responses={"writer": canned})

    draft = await run_writer(
        session=db_session,
        gemini=gemini,
        run_id=run_id,
        iteration=0,
        today=date(2026, 5, 21),
        refine_notes=None,
    )

    assert draft.iteration == 0
    assert "%%adv_panel id=1%%" in draft.markup_raw

    row = (
        await db_session.execute(select(Draft).where(Draft.run_id == run_id))
    ).scalar_one()
    assert row.iteration == 0
    assert "大腸癌" in row.markup_raw

    # Confirm writer agent was invoked with the right agent label
    assert any(c["agent"] == "writer" for c in gemini.calls)


@pytest.mark.asyncio
async def test_writer_rerun_upserts_same_iteration(db_session):
    run_id = uuid4()
    db_session.add(
        Run(
            run_id=run_id,
            created_by="x",
            status="production",
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
        FetchedArticle(run_id=run_id, wp_post_id=1, wp_categories=[], markdown="# old")
    )
    db_session.add(
        GapAnalysisRow(
            run_id=run_id,
            model="gemini-3.5-flash",
            thinking_level="high",
            payload=json.loads(
                Path("tests/fixtures/gemini_responses/gap_analysis_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
            ),
        )
    )
    db_session.add(
        OutlineRow(
            run_id=run_id,
            payload=json.loads(
                Path("tests/fixtures/gemini_responses/outline_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
            ),
        )
    )
    await db_session.commit()

    canned = json.loads(
        Path("tests/fixtures/gemini_responses/writer_small_refresh_ok.json").read_text(encoding="utf-8")  # noqa: ASYNC240
    )
    gemini = FakeGeminiClient(canned_responses={"writer": canned})

    first = await run_writer(
        session=db_session,
        gemini=gemini,
        run_id=run_id,
        iteration=0,
        today=date(2026, 5, 21),
        refine_notes=None,
    )

    # Downstream resolve_citations fills final_markup before any restart.
    row = (
        await db_session.execute(select(Draft).where(Draft.run_id == run_id))
    ).scalar_one()
    row.final_markup = "stale derived markup"
    await db_session.commit()

    # Restart re-enters the writer at the same iteration; must not raise on the
    # (run_id, iteration) unique constraint.
    second = await run_writer(
        session=db_session,
        gemini=gemini,
        run_id=run_id,
        iteration=0,
        today=date(2026, 5, 21),
        refine_notes=None,
    )

    # Drop the cached ORM instance so we read the upserted row from the DB
    # (the upsert runs via session.execute and bypasses the identity map).
    db_session.expire_all()

    # Still exactly one draft row, reusing the original draft_id, with stale
    # derived content cleared for downstream regeneration.
    rows = (
        await db_session.execute(select(Draft).where(Draft.run_id == run_id))
    ).scalars().all()
    assert len(rows) == 1
    assert second.draft_id == first.draft_id
    assert rows[0].final_markup is None
