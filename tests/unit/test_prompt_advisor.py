"""Unit tests for the Prompt-Improvement Advisor core (evals/prompt_advisor.py).

No DB / no network: synthetic EvalRows, a fake async body loader, and the
in-repo FakeGeminiClient. Spec:
``docs/design/specs/2026-06-07-prompt-improvement-advisor.md``.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import pytest

from content_tool.gemini.fake import FakeGeminiClient
from evals.judges import JUDGE_METRICS
from evals.prompt_advisor import (
    METRIC_PROMPT_ATTRIBUTION,
    AdvisorJob,
    EvalRow,
    MetricAggregate,
    _bundled_source,
    aggregate_metrics,
    build_jobs,
    emit_langfuse_findings,
    normalise_finding,
    run_advisor,
)


async def _fake_body_loader(voice: str, template_id: str) -> tuple[str, str | None]:
    if template_id.startswith("judge_"):
        category = "judge"
    elif template_id.startswith("_"):
        category = "partial"
    else:
        category = "agent"
    return category, f"BODY::{template_id}"


def _row(metric: str, *, score: float | None, passed: bool, voice: str = "v1",
         start_mode: str = "refresh", notes: dict[str, Any] | None = None) -> EvalRow:
    return EvalRow(
        metric=metric, score=score, passed=passed, judge_notes=notes,
        run_id=uuid4(), voice=voice, start_mode=start_mode,
    )


def _agg(metric: str, *, n: int, fail_rate: float, start_modes: set[str],
         run_ids: tuple[UUID, ...] | None = None) -> MetricAggregate:
    return MetricAggregate(
        voice="v1", metric=metric, n=n, mean_score=0.5, fail_rate=fail_rate,
        sample_issues=(f"{metric}-issue",),
        run_ids=run_ids or (uuid4(),), start_modes=frozenset(start_modes),
    )


# ---------------------------------------------------------------------------
# Attribution map invariants
# ---------------------------------------------------------------------------


def test_every_judge_metric_has_attribution() -> None:
    assert set(METRIC_PROMPT_ATTRIBUTION) == set(JUDGE_METRICS)


def test_attribution_targets_are_real_templates() -> None:
    for metric, templates in METRIC_PROMPT_ATTRIBUTION.items():
        assert templates, f"{metric} has no attributed templates"
        for template_id in templates:
            assert _bundled_source(template_id) is not None, (
                f"{metric} -> {template_id} is not a real prompt source"
            )


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def test_aggregate_metrics_computes_stats() -> None:
    rows = [
        _row("brand_voice", score=0.6, passed=True),
        _row("brand_voice", score=0.8, passed=True),
        _row("brand_voice", score=None, passed=False),
        _row("brand_voice", score=0.4, passed=False),
    ]
    aggs = aggregate_metrics(rows)
    agg = aggs[("v1", "brand_voice")]
    assert agg.n == 4
    assert agg.fail_rate == 0.5
    assert agg.mean_score is not None and abs(agg.mean_score - 0.6) < 1e-9
    assert agg.is_weak  # n>=3 and fail_rate>=0.2


def test_aggregate_dedupes_and_caps_issues() -> None:
    notes = {"issues": ["dup", "dup", "uniqueA"]}
    rows = [_row("brand_voice", score=0.4, passed=False, notes=notes) for _ in range(3)]
    agg = aggregate_metrics(rows)[("v1", "brand_voice")]
    assert agg.sample_issues == ("dup", "uniqueA")


def test_issue_extraction_from_alignments_and_items() -> None:
    rows = [
        _row("citation_alignment", score=0.2, passed=False, notes={
            "alignments": [
                {"claim": "claimX", "supported": False},
                {"claim": "claimY", "supported": True},
            ]
        }),
        _row("coverage", score=0.3, passed=False, notes={
            "items": [{"plan_item": "itemA", "addressed": False}]
        }),
    ]
    aggs = aggregate_metrics(rows)
    assert any("claimX" in i for i in aggs[("v1", "citation_alignment")].sample_issues)
    assert all("claimY" not in i for i in aggs[("v1", "citation_alignment")].sample_issues)
    assert any("itemA" in i for i in aggs[("v1", "coverage")].sample_issues)


# ---------------------------------------------------------------------------
# Job building: gate + attribution + start_mode relevance
# ---------------------------------------------------------------------------


async def test_build_jobs_gate_skips_healthy_prompts() -> None:
    healthy = {("v1", "brand_voice"): _agg("brand_voice", n=5, fail_rate=0.0,
                                           start_modes={"refresh"})}
    assert await build_jobs(healthy, _fake_body_loader) == []

    too_few = {("v1", "brand_voice"): _agg("brand_voice", n=2, fail_rate=1.0,
                                           start_modes={"refresh"})}
    assert await build_jobs(too_few, _fake_body_loader) == []


async def test_build_jobs_creates_one_job_per_template_with_union_evidence() -> None:
    # brand_voice + hk_localisation both attribute to _writer_brand_block.
    aggs = {
        ("v1", "brand_voice"): _agg("brand_voice", n=4, fail_rate=0.5, start_modes={"refresh"}),
        ("v1", "hk_localisation"): _agg("hk_localisation", n=4, fail_rate=0.5,
                                        start_modes={"refresh"}),
    }
    jobs = await build_jobs(aggs, _fake_body_loader)
    by_template = {j.template_id: j for j in jobs}
    assert "_writer_brand_block" in by_template
    brand_block = by_template["_writer_brand_block"]
    assert {e.metric for e in brand_block.evidence} == {"brand_voice", "hk_localisation"}
    assert brand_block.current_body == "BODY::_writer_brand_block"


async def test_build_jobs_start_mode_relevance() -> None:
    refresh_only = {("v1", "brand_voice"): _agg("brand_voice", n=4, fail_rate=0.5,
                                                start_modes={"refresh"})}
    refresh_jobs = {j.template_id for j in await build_jobs(refresh_only, _fake_body_loader)}
    assert "writer_create" not in refresh_jobs
    assert {"writer_full_rewrite", "writer_small_refresh"} <= refresh_jobs

    create_only = {("v1", "brand_voice"): _agg("brand_voice", n=4, fail_rate=0.5,
                                               start_modes={"create"})}
    create_jobs = {j.template_id for j in await build_jobs(create_only, _fake_body_loader)}
    assert "writer_create" in create_jobs
    assert "writer_full_rewrite" not in create_jobs


async def test_build_jobs_threshold_override() -> None:
    borderline = {("v1", "brand_voice"): _agg("brand_voice", n=4, fail_rate=0.1,
                                              start_modes={"refresh"})}
    assert await build_jobs(borderline, _fake_body_loader) == []
    relaxed = await build_jobs(borderline, _fake_body_loader, min_fail_rate=0.05)
    assert relaxed  # now above the lowered gate


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------


def _job(template_id: str = "_writer_brand_block") -> AdvisorJob:
    return AdvisorJob(
        voice="v1", template_id=template_id, category="partial",
        current_body="old body", evidence=(), run_ids=(uuid4(),),
    )


def test_normalise_clamps_severity_and_score() -> None:
    f = normalise_finding(_job(), {"severity": 9, "diagnosis": "d", "directions": [],
                                   "proposed_prompt": "new"})
    assert f.severity == 5
    assert f.score == 1.0

    f_low = normalise_finding(_job(), {"severity": -3, "diagnosis": "d", "directions": [],
                                       "proposed_prompt": "new"})
    assert f_low.severity == 1


def test_normalise_handles_garbage() -> None:
    f = normalise_finding(_job(), {"severity": "oops", "root_cause_target": "nonsense",
                                   "directions": ["a", 5, "", "b"], "confidence": 1.7})
    assert f.severity == 3  # invalid -> default
    assert f.root_cause_target == "prompt"  # invalid -> default
    assert f.directions == ("a", "b")  # non-strings + blanks dropped
    assert f.confidence == 1.0  # clamped


def test_normalise_preserves_valid_root_cause() -> None:
    f = normalise_finding(_job(), {"severity": 4, "root_cause_target": "persona_data",
                                   "directions": [], "proposed_prompt": "x"})
    assert f.root_cause_target == "persona_data"


# ---------------------------------------------------------------------------
# Advisor run (FakeGeminiClient)
# ---------------------------------------------------------------------------


async def test_run_advisor_returns_sorted_findings() -> None:
    jobs = [_job("writer_full_rewrite"), _job("_writer_brand_block")]
    canned = {
        "prompt_advisor.writer_full_rewrite": {
            "severity": 2, "diagnosis": "minor", "directions": ["x"], "proposed_prompt": "p1",
        },
        "prompt_advisor._writer_brand_block": {
            "severity": 5, "diagnosis": "major", "directions": ["y"], "proposed_prompt": "p2",
        },
    }
    gemini = FakeGeminiClient(canned_responses=canned)
    findings = await run_advisor(gemini, jobs, advisor_prompt="RUBRIC")
    # severity desc: the brand-block (5) sorts before the writer (2)
    assert [f.template_id for f in findings] == ["_writer_brand_block", "writer_full_rewrite"]
    assert findings[0].severity == 5
    # the rubric is passed as the system prompt
    assert all(c["system_prompt"] == "RUBRIC" for c in gemini.calls)


# ---------------------------------------------------------------------------
# Langfuse write-back
# ---------------------------------------------------------------------------


class _FakeLangfuse:
    def __init__(self, *, broken: bool = False) -> None:
        self.scores: list[dict[str, Any]] = []
        self._broken = broken

    def create_trace_id(self, *, seed: str) -> str:
        # Mirrors Langfuse.create_trace_id(seed=...) — deterministic per seed.
        return f"otel-{seed}"

    def create_score(self, **kwargs: Any) -> None:
        if self._broken:
            raise RuntimeError("langfuse down")
        self.scores.append(kwargs)

    def flush(self) -> None:
        pass


def _finding_for_emit(run_ids: tuple[UUID, ...]):
    return normalise_finding(
        AdvisorJob(voice="v1", template_id="writer_create", category="agent",
                   current_body="b", evidence=(), run_ids=run_ids),
        {"severity": 4, "diagnosis": "d", "directions": ["fix"], "proposed_prompt": "p"},
    )


def _enable_langfuse(monkeypatch: pytest.MonkeyPatch, client: object) -> None:
    from content_tool.config import Settings
    from content_tool.observability import langfuse_client

    monkeypatch.setattr(
        "content_tool.config.get_settings",
        lambda: Settings(langfuse_enabled=True, gemini_api_key="x",
                         postgres_url="postgresql+asyncpg://x:x@localhost/x"),
    )
    langfuse_client.reset_for_testing(client)


def test_emit_langfuse_disabled_emits_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.config import Settings
    from content_tool.observability import langfuse_client

    monkeypatch.setattr(
        "content_tool.config.get_settings",
        lambda: Settings(langfuse_enabled=False, gemini_api_key="x",
                         postgres_url="postgresql+asyncpg://x:x@localhost/x"),
    )
    langfuse_client.reset_for_testing(None)
    assert emit_langfuse_findings([_finding_for_emit((uuid4(),))]) == 0


def test_emit_langfuse_one_score_per_run(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.observability import langfuse_client

    fake = _FakeLangfuse()
    _enable_langfuse(monkeypatch, fake)
    run_ids = (uuid4(), uuid4())
    emitted = emit_langfuse_findings([_finding_for_emit(run_ids)])
    # Two trace-id candidates per run (raw run_id + seed-derived) => 2x scores.
    assert emitted == 4
    assert len(fake.scores) == 4
    assert all(s["name"] == "prompt_advisor.writer_create" for s in fake.scores)
    assert all(s["value"] == 0.8 for s in fake.scores)  # severity 4 / 5
    tids = {s["trace_id"] for s in fake.scores}
    # both the raw run_id (Workers) and the seed-derived id (Python v4) are emitted
    assert str(run_ids[0]) in tids
    assert f"otel-{run_ids[0]}" in tids
    langfuse_client.reset_for_testing(None)


def test_emit_langfuse_swallows_client_error(monkeypatch: pytest.MonkeyPatch) -> None:
    from content_tool.observability import langfuse_client

    _enable_langfuse(monkeypatch, _FakeLangfuse(broken=True))
    # must not raise; nothing recorded
    assert emit_langfuse_findings([_finding_for_emit((uuid4(),))]) == 0
    langfuse_client.reset_for_testing(None)
