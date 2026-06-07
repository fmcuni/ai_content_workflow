"""Deterministic Markdown rendering of Prompt-Improvement Advisor findings.

Pure: the generation date is passed in (no hidden clock) so the same findings
always render byte-identically — easy to diff and to test. Spec:
``docs/superpowers/specs/2026-06-07-prompt-improvement-advisor.md``.
"""

from __future__ import annotations

from evals.prompt_advisor import AdvisorEvidence, AdvisorFinding

_FENCE = "```"


def _fmt_score(value: float | None) -> str:
    return f"{value:.2f}" if value is not None else "—"


def _evidence_table(evidence: tuple[AdvisorEvidence, ...]) -> list[str]:
    lines = [
        "| metric | n | mean score | fail rate | sample issues |",
        "|---|---|---|---|---|",
    ]
    for e in evidence:
        issues = "; ".join(e.sample_issues) if e.sample_issues else "—"
        # Keep table cells single-line.
        issues = issues.replace("\n", " ").replace("|", "\\|")
        lines.append(
            f"| `{e.metric}` | {e.n} | {_fmt_score(e.mean_score)} | "
            f"{e.fail_rate:.0%} | {issues} |"
        )
    return lines


def _code_block(body: str) -> list[str]:
    """Fence a prompt body, widening the fence if the body itself contains ```."""
    fence = _FENCE
    while fence in body:
        fence += "`"
    return [fence, body.rstrip("\n"), fence]


def _finding_section(index: int, finding: AdvisorFinding) -> list[str]:
    conf = f"{finding.confidence:.2f}" if finding.confidence is not None else "—"
    metrics = ", ".join(f"`{e.metric}`" for e in finding.evidence)
    lines: list[str] = [
        f"## {index}. `{finding.template_id}` — severity {finding.severity}/5  "
        f"(voice: `{finding.voice}`)",
        "",
        f"- **Root cause:** {finding.root_cause_target}",
        f"- **Confidence:** {conf}",
        f"- **Flagged metrics:** {metrics}",
        f"- **Langfuse score:** `prompt_advisor.{finding.template_id}` = "
        f"{finding.score:.2f} on {len(finding.run_ids)} trace(s)",
        "",
        "### Evidence",
        "",
        *_evidence_table(finding.evidence),
        "",
        "### Diagnosis",
        "",
        finding.diagnosis or "_(none)_",
        "",
        "### Directional changes",
        "",
    ]
    if finding.directions:
        lines.extend(f"{i}. {d}" for i, d in enumerate(finding.directions, 1))
    else:
        lines.append("_(none proposed)_")
    lines += [
        "",
        "### Proposed prompt (review before applying)",
        "",
        "<details><summary>Current body</summary>",
        "",
        *_code_block(finding.current_body),
        "",
        "</details>",
        "",
        "<details open><summary>Proposed body</summary>",
        "",
        *_code_block(finding.proposed_prompt or "(advisor returned no proposal)"),
        "",
        "</details>",
        "",
        "### Contributing runs (Langfuse trace ids)",
        "",
    ]
    lines.extend(f"- `{rid}`" for rid in finding.run_ids)
    lines.append("")
    return lines


def render_report(
    findings: list[AdvisorFinding],
    *,
    generated_date: str,
    run_limit: int,
    voice_filter: str | None,
) -> str:
    """Render findings (already sorted severity desc) to a Markdown report."""
    scope = voice_filter or "all voices"
    header: list[str] = [
        "# Prompt-Improvement Advisor report",
        "",
        f"- **Generated:** {generated_date}",
        f"- **Run window:** last {run_limit} published runs ({scope})",
        f"- **Findings:** {len(findings)}",
        "",
        "> Aggregate LLM-as-judge analysis of recurring weaknesses, attributed to "
        "specific prompts with directional fixes. Proposals are **not** applied "
        "automatically — review and paste into `/prompts` (or commit) by hand.",
        "",
    ]

    if not findings:
        header += [
            "## No weaknesses above threshold",
            "",
            "Every attributed prompt is performing above the weakness gate "
            "(`MIN_SAMPLES` / `MIN_FAIL_RATE`) for this run window. Nothing to "
            "advise. Widen `--limit` or lower `--min-fail-rate` to probe further.",
            "",
        ]
        return "\n".join(header)

    header += ["## Summary", "", "| # | prompt | voice | severity | root cause |",
               "|---|---|---|---|---|"]
    for i, f in enumerate(findings, 1):
        header.append(
            f"| {i} | `{f.template_id}` | `{f.voice}` | {f.severity}/5 | "
            f"{f.root_cause_target} |"
        )
    header.append("")

    body: list[str] = []
    for i, finding in enumerate(findings, 1):
        body.extend(_finding_section(i, finding))
    return "\n".join(header + body)
