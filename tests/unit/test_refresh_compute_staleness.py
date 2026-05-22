from decimal import Decimal
import pytest
from content_tool.refresh.deterministic_checks import DeterministicResult, Finding
from content_tool.refresh.evaluator import compute_staleness, LLMFindings


def make_det(high: int = 0, medium: int = 0, low: int = 0) -> DeterministicResult:
    r = DeterministicResult()
    for _ in range(high):
        r.add(Finding(id="x", severity="high", message="x"))
    for _ in range(medium):
        r.add(Finding(id="x", severity="medium", message="x"))
    for _ in range(low):
        r.add(Finding(id="x", severity="low", message="x"))
    return r


def test_fresh_article_no_findings_is_ok():
    score, action = compute_staleness(make_det(), None, age_days=10)
    assert score < Decimal("3.0")
    assert action == "ok"

def test_very_old_article_with_no_findings_is_at_least_monitor():
    score, action = compute_staleness(make_det(), None, age_days=180)
    assert score >= Decimal("3.0")
    assert action in ("monitor", "refresh")

def test_high_severity_det_forces_refresh_regardless_of_score():
    score, action = compute_staleness(make_det(high=1), None, age_days=1)
    assert action == "refresh"

def test_high_severity_llm_forces_refresh():
    llm = LLMFindings(severity_high=1)
    score, action = compute_staleness(make_det(), llm, age_days=1)
    assert action == "refresh"

def test_score_is_clamped_to_10():
    score, _ = compute_staleness(make_det(high=10, medium=10), LLMFindings(severity_high=10), age_days=10000)
    assert score == Decimal("10.00")

def test_monitor_action_at_score_3_to_6():
    score, action = compute_staleness(make_det(), None, age_days=140)
    assert Decimal("3.0") <= score < Decimal("6.0")
    assert action == "monitor"
