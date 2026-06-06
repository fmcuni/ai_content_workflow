"""Unit tests for Langfuse score emission in record_eval.

Guardrails verified:
- G3: When LANGFUSE_ENABLED is false, no score is emitted and no error is raised.
- DB write path is unchanged regardless of Langfuse state.
- Score is emitted with the correct trace_id / name / value / comment when enabled.
- None score is skipped gracefully (no lf.score call).
- None run_id is skipped gracefully (no trace to attach to).
- Langfuse client errors are swallowed — record_eval never raises because of them.

No network is used; all tests inject a fake Langfuse client via the P1
``reset_for_testing`` helper on the singleton.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from evals.runner import record_eval

# ---------------------------------------------------------------------------
# Helpers / fakes
# ---------------------------------------------------------------------------


class _ScoreSpy:
    """Records calls to lf.create_score() (Langfuse v4 API)."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def create_score(
        self,
        *,
        trace_id: str,
        name: str,
        value: float,
        comment: str | None = None,
    ) -> None:
        self.calls.append(
            {"trace_id": trace_id, "name": name, "value": value, "comment": comment}
        )

    def flush(self) -> None:
        pass


class _FakeSession:
    """Minimal SQLAlchemy session fake used to intercept DB writes."""

    def __init__(self) -> None:
        self.added: list[Any] = []

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    async def commit(self) -> None:
        pass

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *_: object) -> None:
        pass


def _make_session_factory() -> Any:
    """Return a callable that yields a _FakeSession, mimicking async_sessionmaker."""
    session = _FakeSession()

    def factory() -> _FakeSession:
        return session

    factory._session = session  # type: ignore[attr-defined]
    return factory


# ---------------------------------------------------------------------------
# Helpers to control get_settings() inside record_eval
# ---------------------------------------------------------------------------


def _settings(*, langfuse_enabled: bool) -> MagicMock:
    s = MagicMock()
    s.langfuse_enabled = langfuse_enabled
    return s


# ---------------------------------------------------------------------------
# 1. DB write path is always executed (unchanged)
# ---------------------------------------------------------------------------


async def test_db_write_always_executed(monkeypatch: pytest.MonkeyPatch) -> None:
    sf = _make_session_factory()
    run_id = uuid4()

    monkeypatch.setattr("evals.runner.get_settings", lambda: _settings(langfuse_enabled=False))

    await record_eval(
        sf,
        metric="coverage",
        fixture_id="fix-1",
        score=0.8,
        passed=True,
        judge_notes={"detail": "ok"},
        run_id=run_id,
    )

    assert len(sf._session.added) == 1
    row = sf._session.added[0]
    assert row.metric == "coverage"
    assert row.score == 0.8
    assert row.pass_ is True
    assert row.run_id == run_id


# ---------------------------------------------------------------------------
# 2. No score emitted when LANGFUSE_ENABLED=false
# ---------------------------------------------------------------------------


async def test_no_score_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.observability import langfuse_client

    spy = _ScoreSpy()
    langfuse_client.reset_for_testing(spy)

    sf = _make_session_factory()
    monkeypatch.setattr("evals.runner.get_settings", lambda: _settings(langfuse_enabled=False))

    await record_eval(
        sf,
        metric="brand_voice",
        fixture_id="fix-2",
        score=0.9,
        passed=True,
        run_id=uuid4(),
    )

    assert spy.calls == [], "No score must be emitted when Langfuse is disabled"

    langfuse_client.reset_for_testing(None)


# ---------------------------------------------------------------------------
# 3. Score emitted with correct fields when enabled
# ---------------------------------------------------------------------------


async def test_score_emitted_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.observability import langfuse_client

    spy = _ScoreSpy()
    langfuse_client.reset_for_testing(spy)

    sf = _make_session_factory()
    run_id = uuid4()
    notes: dict[str, object] = {"detail": "looks good", "score": 0.75}

    monkeypatch.setattr("evals.runner.get_settings", lambda: _settings(langfuse_enabled=True))

    await record_eval(
        sf,
        metric="hk_localisation",
        fixture_id="fix-3",
        score=0.75,
        passed=True,
        judge_notes=notes,
        run_id=run_id,
    )

    assert len(spy.calls) == 1
    call = spy.calls[0]
    assert call["trace_id"] == str(run_id)
    assert call["name"] == "hk_localisation"
    assert call["value"] == 0.75
    # comment is JSON-serialised judge_notes
    assert call["comment"] == json.dumps(notes, ensure_ascii=False)

    langfuse_client.reset_for_testing(None)


# ---------------------------------------------------------------------------
# 4. None score → score call skipped gracefully
# ---------------------------------------------------------------------------


async def test_none_score_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.observability import langfuse_client

    spy = _ScoreSpy()
    langfuse_client.reset_for_testing(spy)

    sf = _make_session_factory()
    monkeypatch.setattr("evals.runner.get_settings", lambda: _settings(langfuse_enabled=True))

    await record_eval(
        sf,
        metric="citation_alignment",
        fixture_id="fix-4",
        score=None,
        passed=False,
        run_id=uuid4(),
    )

    assert spy.calls == [], "score=None must not trigger lf.score()"

    langfuse_client.reset_for_testing(None)


# ---------------------------------------------------------------------------
# 5. None run_id → score call skipped gracefully
# ---------------------------------------------------------------------------


async def test_none_run_id_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.observability import langfuse_client

    spy = _ScoreSpy()
    langfuse_client.reset_for_testing(spy)

    sf = _make_session_factory()
    monkeypatch.setattr("evals.runner.get_settings", lambda: _settings(langfuse_enabled=True))

    await record_eval(
        sf,
        metric="refine_loop_convergence",
        fixture_id="fix-5",
        score=1.0,
        passed=True,
        run_id=None,  # fixture-only eval — no run
    )

    assert spy.calls == [], "run_id=None must not trigger lf.score()"

    langfuse_client.reset_for_testing(None)


# ---------------------------------------------------------------------------
# 6. Langfuse client error is swallowed — record_eval does not raise
# ---------------------------------------------------------------------------


async def test_langfuse_error_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.observability import langfuse_client

    class _BrokenClient:
        def create_score(self, **kwargs: object) -> None:
            raise RuntimeError("Langfuse is unavailable")

        def flush(self) -> None:
            pass

    langfuse_client.reset_for_testing(_BrokenClient())

    sf = _make_session_factory()
    monkeypatch.setattr("evals.runner.get_settings", lambda: _settings(langfuse_enabled=True))

    # Must not raise even though the Langfuse client throws
    await record_eval(
        sf,
        metric="coverage",
        fixture_id="fix-6",
        score=0.5,
        passed=False,
        run_id=uuid4(),
    )

    # DB write still happened
    assert len(sf._session.added) == 1

    langfuse_client.reset_for_testing(None)


# ---------------------------------------------------------------------------
# 7. judge_notes=None → comment is None (no serialisation attempted)
# ---------------------------------------------------------------------------


async def test_null_judge_notes_yields_null_comment(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.observability import langfuse_client

    spy = _ScoreSpy()
    langfuse_client.reset_for_testing(spy)

    sf = _make_session_factory()
    monkeypatch.setattr("evals.runner.get_settings", lambda: _settings(langfuse_enabled=True))

    await record_eval(
        sf,
        metric="citation_policy_compliance",
        fixture_id="fix-7",
        score=1.0,
        passed=True,
        judge_notes=None,
        run_id=uuid4(),
    )

    assert len(spy.calls) == 1
    assert spy.calls[0]["comment"] is None

    langfuse_client.reset_for_testing(None)
