"""Multi-user race-condition hardening for the runs router + executor.

Three confirmed races are closed here:

1. HITL-2 ``request_changes`` iteration cap was a TOCTOU — two concurrent
   requests both read iteration N, both passed the ``< 3`` check, and both
   incremented, blowing past the cap. The increment is now a conditional
   UPDATE, so exactly one of two concurrent requests from iteration 2 wins and
   the counter lands on 3 (never 4).
2. ``POST /runs/{id}/restart`` claimed the run with a conditional
   ``status=failed → pending`` UPDATE, so a concurrent double-restart only
   drives the executor once.
3. ``RunExecutor.start``/``resume``/``restart`` refuse to spawn a second live
   task for a run that already has one in flight, surfaced to callers as 409.
"""
import asyncio
from datetime import date
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from content_tool.api.routes.runs import router as runs_router
from content_tool.api.sse import RunAlreadyExecutingError, RunExecutor
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import Draft, Render, Run
from content_tool.wordpress.client import WordPressClient


class _FakeRunner:
    """Records resume/start/restart calls without driving a real graph."""

    def __init__(self) -> None:
        self.resume_calls: list[tuple] = []
        self.start_calls: list = []
        self.restart_calls: list = []

    async def resume(self, run_id, update) -> None:
        self.resume_calls.append((run_id, update))

    async def start(self, run_id) -> None:
        self.start_calls.append(run_id)

    async def restart(self, run_id) -> None:
        self.restart_calls.append(run_id)


def _make_app(sf, runner):
    app = FastAPI()
    app.include_router(runs_router)
    app.state.session_factory = sf
    app.state.wp_client = WordPressClient(
        "https://wp.example.com", username="u", app_password="p"  # noqa: S106
    )
    app.state.wp_target = "staging"
    app.state.seo_plugin = "yoast"
    app.state.run_executor = runner
    return app


async def _seed_hitl2_run(sf, run_id, *, iteration):
    """A paused HITL-2 run with a draft + render, at the given iteration."""
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="hitl_2",
            article_url=None, topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 27), chosen_route="small_refresh",
            wp_publish_status="draft", start_mode="create",
            hitl_2_iteration=iteration,
        ))
        await s.commit()
    async with sf() as s:
        d = Draft(
            run_id=run_id, iteration=0, diagnose="d",
            markup_raw="x", final_markup="x", citation_intents=[],
        )
        s.add(d)
        await s.commit()
        await s.refresh(d)
        s.add(Render(draft_id=d.draft_id, seo_title="t", meta_description="m",
                     html_body="<p>x</p>", excerpt_suggestion="e"))
        await s.commit()


async def _seed_failed_run(sf, run_id):
    async with sf() as s:
        s.add(Run(
            run_id=run_id, created_by="x", status="failed",
            article_url=None, topic="x", keywords=[], mode="auto",
            acf_adv_id=1, acf_widget_id=2, persona="bowtie-editor",
            today_date=date(2026, 5, 27), start_mode="create",
        ))
        await s.commit()


# ---------------------------------------------------------------------------
# FIX 1 — HITL-2 iteration cap is atomic
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_concurrent_request_changes_respects_cap(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_hitl2_run(sf, run_id, iteration=2)
    runner = _FakeRunner()
    app = _make_app(sf, runner)

    body = {"decision": "request_changes", "notes": "again"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r1, r2 = await asyncio.gather(
            ac.post(f"/runs/{run_id}/hitl-2", json=body),
            ac.post(f"/runs/{run_id}/hitl-2", json=body),
        )

    codes = sorted([r1.status_code, r2.status_code])
    assert codes == [200, 409], codes

    async with sf() as s:
        row = (await s.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert row.hitl_2_iteration == 3  # not 4 — exactly one increment committed
    # The winning request resumed with the committed iteration; the loser did not.
    assert len(runner.resume_calls) == 1
    assert runner.resume_calls[0][1]["hitl_2_iteration"] == 3
    await engine.dispose()


@pytest.mark.asyncio
async def test_request_changes_at_cap_rejected(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_hitl2_run(sf, run_id, iteration=3)
    runner = _FakeRunner()
    app = _make_app(sf, runner)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{run_id}/hitl-2", json={"decision": "request_changes", "notes": "n"}
        )
    assert r.status_code == 409
    async with sf() as s:
        row = (await s.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert row.hitl_2_iteration == 3
    assert runner.resume_calls == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_approve_does_not_increment_iteration(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_hitl2_run(sf, run_id, iteration=2)
    runner = _FakeRunner()
    app = _make_app(sf, runner)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{run_id}/hitl-2",
            json={"decision": "approve", "editor_email": "ed@bowtie.com.hk"},
        )
    assert r.status_code == 200
    async with sf() as s:
        row = (await s.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    assert row.hitl_2_iteration == 2
    assert row.approved_by == "ed@bowtie.com.hk"
    assert runner.resume_calls[0][1]["hitl_2_iteration"] == 2
    await engine.dispose()


# ---------------------------------------------------------------------------
# FIX 2 — restart status guard is atomic
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_concurrent_restart_only_one_wins(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_failed_run(sf, run_id)
    runner = _FakeRunner()
    app = _make_app(sf, runner)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r1, r2 = await asyncio.gather(
            ac.post(f"/runs/{run_id}/restart"),
            ac.post(f"/runs/{run_id}/restart"),
        )
    codes = sorted([r1.status_code, r2.status_code])
    assert codes == [200, 409], codes
    assert len(runner.restart_calls) == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_restart_non_failed_is_409(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_hitl2_run(sf, run_id, iteration=0)
    runner = _FakeRunner()
    app = _make_app(sf, runner)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(f"/runs/{run_id}/restart")
    assert r.status_code == 409
    assert runner.restart_calls == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_restart_missing_run_is_404(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    runner = _FakeRunner()
    app = _make_app(sf, runner)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post(f"/runs/{uuid4()}/restart")
    assert r.status_code == 404
    await engine.dispose()


# ---------------------------------------------------------------------------
# FIX 3 — single-flight executor
# ---------------------------------------------------------------------------

def _make_executor(sf):
    return RunExecutor(
        postgres_url="postgresql+asyncpg://unused",
        session_factory=sf,
        gemini=object(),  # never used — _run is patched in these tests
    )


@pytest.mark.asyncio
async def test_double_start_refuses_second_task(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    ex = _make_executor(sf)

    released = asyncio.Event()

    async def _blocking_run(rid, **_kw):
        await released.wait()

    ex._run = _blocking_run  # type: ignore[method-assign]

    await ex.start(run_id)
    with pytest.raises(RunAlreadyExecutingError):
        await ex.start(run_id)

    assert len([t for t in ex._tasks.values() if not t.done()]) == 1
    released.set()
    await asyncio.gather(*ex._tasks.values())
    await engine.dispose()


@pytest.mark.asyncio
async def test_start_after_completion_is_allowed(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    ex = _make_executor(sf)

    async def _instant_run(rid, **_kw):
        return None

    ex._run = _instant_run  # type: ignore[method-assign]

    await ex.start(run_id)
    # Let the first task complete.
    await asyncio.gather(*ex._tasks.values())
    # A finished task must not block a fresh start (e.g. restart of a done run).
    await ex.start(run_id)
    await asyncio.gather(*ex._tasks.values())
    await engine.dispose()


@pytest.mark.asyncio
async def test_resume_while_running_is_409(postgres_url):
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    run_id = uuid4()
    await _seed_hitl2_run(sf, run_id, iteration=0)

    released = asyncio.Event()

    class _BlockingExecutor(RunExecutor):
        async def _run(self, rid, *, resume=False, update=None):
            await released.wait()

    ex = _BlockingExecutor(
        postgres_url="postgresql+asyncpg://unused",
        session_factory=sf,
        gemini=object(),
    )
    runner_app = _make_app(sf, ex)

    # Occupy the slot with a live resume task.
    await ex.resume(run_id, {"hitl_2_decision": "approve"})

    async with AsyncClient(transport=ASGITransport(app=runner_app), base_url="http://test") as ac:
        r = await ac.post(
            f"/runs/{run_id}/hitl-2",
            json={"decision": "approve", "editor_email": "ed@bowtie.com.hk"},
        )
    assert r.status_code == 409
    released.set()
    await asyncio.gather(*ex._tasks.values())
    await engine.dispose()
