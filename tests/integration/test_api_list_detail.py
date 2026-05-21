"""Tests for GET /runs list, per-resource detail endpoints, and CORS middleware."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from content_tool.api.main import create_app
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import (
    AuditRun,
    Draft,
    GapAnalysisRow,
    OutlineRow,
    Render,
    Run,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BASE = "http://test"


def _make_run(**kwargs) -> Run:
    """Return a Run with all non-nullable fields defaulted to safe test values."""
    defaults = dict(
        run_id=uuid4(),
        created_by="tester@example.com",
        status="pending",
        article_url="https://example.com/article",
        topic="大腸癌指南",
        keywords=["大腸癌"],
        mode="auto",
        acf_adv_id=1,
        acf_widget_id=2,
        persona="bowtie-editor",
        today_date=datetime(2026, 5, 21, tzinfo=UTC).date(),
    )
    defaults.update(kwargs)
    return Run(**defaults)


def _make_draft(run_id, iteration: int = 1) -> Draft:
    return Draft(
        draft_id=uuid4(),
        run_id=run_id,
        iteration=iteration,
        diagnose="diagnose text",
        markup_raw="<p>raw</p>",
        final_markup="<p>final</p>",
        citation_intents=[],
    )


# ---------------------------------------------------------------------------
# Fixture: app + seeded session factory
# ---------------------------------------------------------------------------


async def _setup_app(postgres_url: str):
    """Return (app, sf, engine) with session_factory injected into app.state."""
    app = create_app()
    engine = make_engine(postgres_url)
    sf = make_session_factory(engine)
    app.state.session_factory = sf

    class _NullExecutor:
        async def start(self, run_id):
            pass

        async def resume(self, run_id, update):
            pass

    app.state.run_executor = _NullExecutor()
    return app, sf, engine


# ===========================================================================
# GET /runs — list
# ===========================================================================


@pytest.mark.asyncio
async def test_list_runs_returns_newest_first(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)

    run_id_a = uuid4()
    run_id_b = uuid4()
    run_id_c = uuid4()

    async with sf() as session:
        # Insert in ascending order; timestamps are set by server_default — use
        # explicit created_at overrides so ordering is deterministic.
        session.add_all([
            _make_run(
                run_id=run_id_a,
                status="pending",
                topic="run A",
                created_at=datetime(2026, 5, 21, 10, 0, 0, tzinfo=UTC),
            ),
            _make_run(
                run_id=run_id_b,
                status="hitl_1",
                topic="run B",
                created_at=datetime(2026, 5, 21, 11, 0, 0, tzinfo=UTC),
            ),
            _make_run(
                run_id=run_id_c,
                status="done",
                topic="run C",
                created_at=datetime(2026, 5, 21, 12, 0, 0, tzinfo=UTC),
            ),
        ])
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get("/runs")

    await engine.dispose()

    assert r.status_code == 200
    body = r.json()
    # newest first: C → B → A (at least among the runs we inserted)
    ids = [item["run_id"] for item in body]
    idx_c = ids.index(str(run_id_c))
    idx_b = ids.index(str(run_id_b))
    idx_a = ids.index(str(run_id_a))
    assert idx_c < idx_b < idx_a

    # Shape check on one item
    item = next(i for i in body if i["run_id"] == str(run_id_c))
    assert set(item.keys()) >= {
        "run_id", "status", "topic", "article_url", "mode",
        "created_at", "chosen_route", "iteration_count",
    }
    assert isinstance(item["run_id"], str)


@pytest.mark.asyncio
async def test_list_runs_filter_by_status(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)

    run_id_hitl = uuid4()
    run_id_done = uuid4()

    async with sf() as session:
        session.add_all([
            _make_run(run_id=run_id_hitl, status="awaiting_hitl_1", topic="hitl run"),
            _make_run(run_id=run_id_done, status="done", topic="done run"),
        ])
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get("/runs?status=awaiting_hitl_1")

    await engine.dispose()

    assert r.status_code == 200
    body = r.json()
    returned_ids = {i["run_id"] for i in body}
    assert str(run_id_hitl) in returned_ids
    assert str(run_id_done) not in returned_ids
    for item in body:
        assert item["status"] == "awaiting_hitl_1"


@pytest.mark.asyncio
async def test_list_runs_limit(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)

    async with sf() as session:
        session.add_all([_make_run() for _ in range(3)])
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get("/runs?limit=1")

    await engine.dispose()

    assert r.status_code == 200
    assert len(r.json()) == 1


@pytest.mark.asyncio
async def test_list_runs_empty_db(postgres_url):
    """When there are no runs the list endpoint must return an empty list, not 404/500."""
    # NOTE: other tests may have inserted rows; we use a status that no test uses
    # so we get 0 results from the filter.
    app, _sf, engine = await _setup_app(postgres_url)

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get("/runs?status=__nonexistent_status__")

    await engine.dispose()

    assert r.status_code == 200
    assert r.json() == []


# ===========================================================================
# GET /runs/{run_id}/gap-analysis
# ===========================================================================


@pytest.mark.asyncio
async def test_get_gap_analysis_200(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.flush()
        session.add(
            GapAnalysisRow(
                run_id=run_id,
                model="gemini-test",
                thinking_level="none",
                payload={"target_query": "大腸癌篩查"},
            )
        )
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/gap-analysis")

    await engine.dispose()

    assert r.status_code == 200
    assert r.json() == {"target_query": "大腸癌篩查"}


@pytest.mark.asyncio
async def test_get_gap_analysis_404(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/gap-analysis")

    await engine.dispose()

    assert r.status_code == 404


# ===========================================================================
# GET /runs/{run_id}/outline
# ===========================================================================


@pytest.mark.asyncio
async def test_get_outline_200(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.flush()
        session.add(
            OutlineRow(
                run_id=run_id,
                payload={"sections": ["intro", "body", "conclusion"]},
                edited_by_human=False,
            )
        )
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/outline")

    await engine.dispose()

    assert r.status_code == 200
    body = r.json()
    assert body["payload"] == {"sections": ["intro", "body", "conclusion"]}
    assert body["edited_by_human"] is False


@pytest.mark.asyncio
async def test_get_outline_404(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/outline")

    await engine.dispose()

    assert r.status_code == 404


# ===========================================================================
# GET /runs/{run_id}/drafts/latest
# ===========================================================================


@pytest.mark.asyncio
async def test_get_latest_draft_returns_highest_iteration(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.flush()
        session.add(_make_draft(run_id=run_id, iteration=1))
        session.add(_make_draft(run_id=run_id, iteration=2))
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/drafts/latest")

    await engine.dispose()

    assert r.status_code == 200
    body = r.json()
    assert body["iteration"] == 2
    assert set(body.keys()) >= {"draft_id", "iteration", "diagnose", "markup_raw", "final_markup"}


@pytest.mark.asyncio
async def test_get_latest_draft_404_no_drafts(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/drafts/latest")

    await engine.dispose()

    assert r.status_code == 404


# ===========================================================================
# GET /runs/{run_id}/render
# ===========================================================================


@pytest.mark.asyncio
async def test_get_render_200(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()
    draft = _make_draft(run_id=run_id)

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.flush()
        session.add(draft)
        await session.flush()
        session.add(
            Render(
                render_id=uuid4(),
                draft_id=draft.draft_id,
                seo_title="大腸癌篩查完整指南",
                meta_description="了解大腸癌篩查方法",
                html_body="<article><p>content</p></article>",
                faq_schema_jsonld={"@type": "FAQPage"},
                excerpt_suggestion="大腸癌篩查摘要",
                slug_suggestion="colorectal-cancer-screening",
            )
        )
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/render")

    await engine.dispose()

    assert r.status_code == 200
    body = r.json()
    assert body["seo_title"] == "大腸癌篩查完整指南"
    assert set(body.keys()) >= {
        "seo_title", "meta_description", "html_body",
        "faq_schema_jsonld", "excerpt_suggestion", "slug_suggestion",
    }


@pytest.mark.asyncio
async def test_get_render_404_no_draft(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/render")

    await engine.dispose()

    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_render_404_no_render_row(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()
    draft = _make_draft(run_id=run_id)

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.flush()
        session.add(draft)
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/render")

    await engine.dispose()

    assert r.status_code == 404


# ===========================================================================
# GET /runs/{run_id}/audit
# ===========================================================================


@pytest.mark.asyncio
async def test_get_audit_200(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()
    draft = _make_draft(run_id=run_id)

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.flush()
        session.add(draft)
        await session.flush()
        session.add(
            AuditRun(
                audit_id=uuid4(),
                draft_id=draft.draft_id,
                overall_pass=True,
                severity_high=0,
                severity_medium=1,
                severity_low=2,
                llm_findings={"items": []},
                deterministic_findings={"items": []},
            )
        )
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/audit")

    await engine.dispose()

    assert r.status_code == 200
    body = r.json()
    assert body["overall_pass"] is True
    assert body["severity_medium"] == 1
    assert set(body.keys()) >= {
        "overall_pass", "severity_high", "severity_medium", "severity_low",
        "llm_findings", "deterministic_findings",
    }


@pytest.mark.asyncio
async def test_get_audit_404_no_draft(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/audit")

    await engine.dispose()

    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_audit_404_no_audit_row(postgres_url):
    app, sf, engine = await _setup_app(postgres_url)
    run_id = uuid4()
    draft = _make_draft(run_id=run_id)

    async with sf() as session:
        session.add(_make_run(run_id=run_id))
        await session.flush()
        session.add(draft)
        await session.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.get(f"/runs/{run_id}/audit")

    await engine.dispose()

    assert r.status_code == 404


# ===========================================================================
# CORS smoke test
# ===========================================================================


@pytest.mark.asyncio
async def test_cors_allows_localhost_3000(postgres_url):
    app, _sf, engine = await _setup_app(postgres_url)

    async with AsyncClient(transport=ASGITransport(app=app), base_url=_BASE) as ac:
        r = await ac.options(
            "/runs",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
            },
        )

    await engine.dispose()

    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"
