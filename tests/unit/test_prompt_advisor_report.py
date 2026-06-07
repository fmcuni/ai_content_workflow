"""Unit tests for the advisor Markdown renderer (evals/prompt_advisor_report.py)."""

from __future__ import annotations

from dataclasses import replace
from uuid import UUID

from evals.prompt_advisor import AdvisorEvidence, AdvisorFinding
from evals.prompt_advisor_report import render_report

_RUN = UUID("11111111-1111-1111-1111-111111111111")


def _finding(severity: int, template_id: str) -> AdvisorFinding:
    return AdvisorFinding(
        voice="bowtie-editor",
        template_id=template_id,
        category="agent",
        current_body="CURRENT BODY TEXT",
        evidence=(
            AdvisorEvidence(metric="brand_voice", n=4, mean_score=0.55,
                            fail_rate=0.5, sample_issues=("語氣偏硬", "缺少 required phrasing")),
        ),
        run_ids=(_RUN,),
        diagnosis="提示詞沒有強調口語化語氣。",
        severity=severity,
        score=severity / 5.0,
        directions=("加入語氣範例", "移除過時用語"),
        root_cause_target="prompt",
        proposed_prompt="PROPOSED BODY TEXT",
        confidence=0.7,
    )


def test_empty_report_states_no_findings() -> None:
    out = render_report([], generated_date="2026-06-07", run_limit=20, voice_filter=None)
    assert "No weaknesses above threshold" in out
    assert "all voices" in out


def test_report_is_deterministic() -> None:
    findings = [_finding(5, "writer_full_rewrite")]
    a = render_report(findings, generated_date="2026-06-07", run_limit=20,
                      voice_filter="bowtie-editor")
    b = render_report(findings, generated_date="2026-06-07", run_limit=20,
                      voice_filter="bowtie-editor")
    assert a == b


def test_report_contains_evidence_directions_and_before_after() -> None:
    out = render_report([_finding(4, "writer_full_rewrite")],
                        generated_date="2026-06-07", run_limit=10, voice_filter=None)
    # evidence table
    assert "| `brand_voice` | 4 |" in out
    assert "語氣偏硬" in out
    # directions
    assert "加入語氣範例" in out
    # before/after
    assert "CURRENT BODY TEXT" in out
    assert "PROPOSED BODY TEXT" in out
    assert "Proposed prompt (review before applying)" in out
    # langfuse score line + contributing trace id
    assert "prompt_advisor.writer_full_rewrite" in out
    assert str(_RUN) in out


def test_report_orders_by_caller_sequence() -> None:
    # render_report renders in the order given (caller sorts severity desc).
    findings = [_finding(5, "high_sev"), _finding(2, "low_sev")]
    out = render_report(findings, generated_date="2026-06-07", run_limit=20, voice_filter=None)
    assert out.index("high_sev") < out.index("low_sev")


def test_code_block_widens_fence_for_bodies_with_backticks() -> None:
    f = _finding(3, "writer_create")
    fenced = replace(f, proposed_prompt="has ``` fence inside")
    out = render_report([fenced], generated_date="2026-06-07", run_limit=20, voice_filter=None)
    # the inner ``` must be preserved (not break the surrounding fence)
    assert "has ``` fence inside" in out
    assert "````" in out  # widened fence present
