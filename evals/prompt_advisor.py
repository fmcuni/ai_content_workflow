"""Prompt-Improvement Advisor — an aggregate, prescriptive LLM-as-judge.

Where the per-run judges (``evals/judges.py``) *score* an output, the advisor
*prescribes*: it aggregates the existing judge scores + issues across the last
``N`` published runs, attributes recurring weakness to the prompt template(s)
most responsible, and asks an LLM judge — per implicated prompt — for a
diagnosis, ranked directional changes, and a concrete revised-prompt proposal.

Read-only against prompts and Postgres; the only side effects are the Markdown
report (rendered by :mod:`evals.prompt_advisor_report`) and best-effort Langfuse
scores. Spec: ``docs/superpowers/specs/2026-06-07-prompt-improvement-advisor.md``.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.gemini.client import GeminiClient
from evals.judges import JUDGE_METRICS

logger = logging.getLogger(__name__)

# template_id of the advisor rubric (DB-backed, shared) + its bundled source.
ADVISOR_TEMPLATE_ID = "judge_prompt_advisor"
_JUDGE_DIR = Path(__file__).resolve().parent / "judge"
_PROMPT_DIR = Path(__file__).resolve().parents[1] / "prompts"

# A (voice, template) is only advised when at least one attributed metric is
# weak: enough samples AND a high-enough fail rate. Bounds Gemini cost and
# avoids advising on prompts that already perform.
MIN_SAMPLES = 3
MIN_FAIL_RATE = 0.20
# Cap distinct issue excerpts carried into the advisor payload per metric, so a
# noisy run set can't blow up the prompt size.
MAX_SAMPLE_ISSUES = 8

# Each judge metric -> the editable prompt template(s) that most plausibly drive
# it. Every target must be a real template_id (asserted by the unit tests).
METRIC_PROMPT_ATTRIBUTION: dict[str, tuple[str, ...]] = {
    "brand_voice": (
        "_writer_brand_block",
        "writer_full_rewrite",
        "writer_small_refresh",
        "writer_create",
    ),
    "hk_localisation": (
        "_writer_brand_block",
        "writer_full_rewrite",
        "writer_small_refresh",
        "writer_create",
    ),
    "citation_alignment": (
        "_writer_seo",
        "writer_full_rewrite",
        "writer_small_refresh",
        "writer_create",
    ),
    "coverage": (
        "gap_analysis",
        "outline_rewrite_mode",
        "writer_full_rewrite",
        "writer_small_refresh",
    ),
}

# Writer templates are start_mode specific: create-mode runs use writer_create;
# refresh/topic-derived runs use writer_full_rewrite or writer_small_refresh. We
# can't tell which refresh writer fired from start_mode alone, so both are
# candidates for any non-create run. Non-writer templates apply to all runs.
_CREATE_ONLY = frozenset({"writer_create"})
_REFRESH_ONLY = frozenset({"writer_full_rewrite", "writer_small_refresh"})

# Gemini structured-output schema for the advisor (mirrors prompt_advisor.md).
ADVISOR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "diagnosis": {"type": "string"},
        "severity": {"type": "integer"},
        "directions": {"type": "array", "items": {"type": "string"}},
        "root_cause_target": {"type": "string"},
        "proposed_prompt": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["diagnosis", "severity", "directions", "proposed_prompt"],
}

_VALID_ROOT_CAUSES = frozenset({"prompt", "persona_data", "source_policy", "mixed"})

# Async resolver: (voice, template_id) -> (category, editable body or None).
BodyLoader = Callable[[str, str], Awaitable["tuple[str, str | None]"]]


def _empty_parsed() -> dict[str, Any]:
    """Typed default factory for AdvisorFinding.parsed (avoids dict[Unknown])."""
    return {}


@dataclass(frozen=True)
class EvalRow:
    """One judge score read from ``content_tool.evals`` joined to its run."""

    metric: str
    score: float | None
    passed: bool
    judge_notes: dict[str, Any] | None
    run_id: UUID
    voice: str
    start_mode: str


@dataclass(frozen=True)
class MetricAggregate:
    """Aggregated performance of one judge ``metric`` for one ``voice``."""

    voice: str
    metric: str
    n: int
    mean_score: float | None
    fail_rate: float
    sample_issues: tuple[str, ...]
    run_ids: tuple[UUID, ...]
    start_modes: frozenset[str]

    def meets_weakness(self, *, min_samples: int, min_fail_rate: float) -> bool:
        return self.n >= min_samples and self.fail_rate >= min_fail_rate

    @property
    def is_weak(self) -> bool:
        return self.meets_weakness(min_samples=MIN_SAMPLES, min_fail_rate=MIN_FAIL_RATE)


@dataclass(frozen=True)
class AdvisorEvidence:
    """One metric's evidence as handed to the advisor for a single prompt."""

    metric: str
    n: int
    mean_score: float | None
    fail_rate: float
    sample_issues: tuple[str, ...]


@dataclass(frozen=True)
class AdvisorJob:
    """A single (voice, template) the advisor will diagnose."""

    voice: str
    template_id: str
    category: str
    current_body: str
    evidence: tuple[AdvisorEvidence, ...]
    run_ids: tuple[UUID, ...]


@dataclass(frozen=True)
class AdvisorFinding:
    """The advisor's structured output for one job, normalised."""

    voice: str
    template_id: str
    category: str
    current_body: str
    evidence: tuple[AdvisorEvidence, ...]
    run_ids: tuple[UUID, ...]
    diagnosis: str
    severity: int
    score: float
    directions: tuple[str, ...]
    root_cause_target: str
    proposed_prompt: str
    confidence: float | None
    parsed: dict[str, Any] = field(default_factory=_empty_parsed)


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


# ---------------------------------------------------------------------------
# 1. Read evals + runs
# ---------------------------------------------------------------------------


async def gather_eval_rows(
    session: AsyncSession, *, limit: int, voice: str | None = None
) -> list[EvalRow]:
    """Read judge scores for the most recent ``limit`` *draft-bearing* runs.

    Any run that produced a draft is in scope — a run does NOT need to be
    published to be analysed (HITL_2 drafts count), so prompts can be improved
    before anything ships. Optionally filtered to one ``voice`` (persona slug).
    Returns one row per (run, metric) for the four LLM-judge metrics; rows with a
    NULL run_id (pure fixture evals) are excluded since they cannot be attributed
    to a voice.
    """
    sql = text(
        """
        SELECT e.metric AS metric, e.score AS score, e."pass" AS passed,
               e.judge_notes AS judge_notes, e.run_id AS run_id,
               r.persona AS voice, r.start_mode AS start_mode
        FROM content_tool.evals e
        JOIN content_tool.runs r ON r.run_id = e.run_id
        WHERE e.metric = ANY(:metrics)
          AND e.run_id IS NOT NULL
          AND (CAST(:voice AS text) IS NULL OR r.persona = :voice)
          AND r.run_id IN (
              SELECT rr.run_id FROM content_tool.runs rr
              WHERE EXISTS (SELECT 1 FROM content_tool.drafts d WHERE d.run_id = rr.run_id)
                AND (CAST(:voice AS text) IS NULL OR rr.persona = :voice)
              ORDER BY rr.created_at DESC
              LIMIT :limit
          )
        ORDER BY r.created_at DESC
        """
    )
    result = await session.execute(
        sql, {"metrics": list(JUDGE_METRICS), "voice": voice, "limit": limit}
    )
    rows: list[EvalRow] = []
    for r in result.mappings():
        notes = r["judge_notes"] if isinstance(r["judge_notes"], dict) else None
        rows.append(
            EvalRow(
                metric=str(r["metric"]),
                score=float(r["score"]) if r["score"] is not None else None,
                passed=bool(r["passed"]),
                judge_notes=notes,
                run_id=r["run_id"],
                voice=str(r["voice"]),
                start_mode=str(r["start_mode"]),
            )
        )
    return rows


# ---------------------------------------------------------------------------
# 2. Aggregate per (voice, metric)
# ---------------------------------------------------------------------------


def _as_object_list(value: object) -> list[object]:
    """Narrow an untyped (``Any``) value to a ``list[object]`` (else empty)."""
    return cast("list[object]", value) if isinstance(value, list) else []


def _issue_strings(notes: dict[str, Any] | None) -> list[str]:
    """Extract human-readable issue excerpts from a judge's parsed notes.

    Generic across the four rubrics: collects free-text issue lists plus the
    salient sub-fields (unsupported claims, unaddressed plan items). Non-string
    entries are skipped.
    """
    if not notes:
        return []
    out: list[str] = []
    for key in ("issues", "mainland_terms_found", "non_hk_phrasings", "found_banned_terms"):
        for item in _as_object_list(notes.get(key)):
            if isinstance(item, str) and item.strip():
                out.append(item.strip())
    for alignment in _as_object_list(notes.get("alignments")):
        if isinstance(alignment, dict):
            a = cast("dict[str, object]", alignment)
            claim = a.get("claim")
            if a.get("supported") is False and isinstance(claim, str) and claim.strip():
                out.append(f"未獲支持的引用宣稱：{claim.strip()}")  # noqa: RUF001
    for plan_item in _as_object_list(notes.get("items")):
        if isinstance(plan_item, dict):
            p = cast("dict[str, object]", plan_item)
            label = p.get("plan_item")
            if p.get("addressed") is False and isinstance(label, str) and label.strip():
                out.append(f"未處理的更新項目：{label.strip()}")  # noqa: RUF001
    return out


def aggregate_metrics(rows: list[EvalRow]) -> dict[tuple[str, str], MetricAggregate]:
    """Aggregate eval rows into one :class:`MetricAggregate` per (voice, metric)."""
    buckets: dict[tuple[str, str], list[EvalRow]] = {}
    for row in rows:
        buckets.setdefault((row.voice, row.metric), []).append(row)

    aggregates: dict[tuple[str, str], MetricAggregate] = {}
    for (voice, metric), group in buckets.items():
        scored = [r.score for r in group if r.score is not None]
        mean = sum(scored) / len(scored) if scored else None
        failed = sum(1 for r in group if not r.passed)
        # Preserve first-seen order while de-duplicating issue excerpts.
        seen: dict[str, None] = {}
        for r in group:
            for issue in _issue_strings(r.judge_notes):
                if issue not in seen:
                    seen[issue] = None
        aggregates[(voice, metric)] = MetricAggregate(
            voice=voice,
            metric=metric,
            n=len(group),
            mean_score=mean,
            fail_rate=failed / len(group),
            sample_issues=tuple(list(seen)[:MAX_SAMPLE_ISSUES]),
            run_ids=tuple(r.run_id for r in group),
            start_modes=frozenset(r.start_mode for r in group),
        )
    return aggregates


# ---------------------------------------------------------------------------
# 3. Attribute to prompts + build jobs
# ---------------------------------------------------------------------------


def _template_relevant(template_id: str, start_modes: frozenset[str]) -> bool:
    """Is this writer template plausibly responsible given the run modes seen?

    create-mode runs use writer_create; refresh/topic-derived runs use one of
    the refresh writers. Non-writer templates are always relevant.
    """
    if template_id in _CREATE_ONLY:
        return "create" in start_modes
    if template_id in _REFRESH_ONLY:
        return any(mode != "create" for mode in start_modes)
    return True


async def build_jobs(
    aggregates: dict[tuple[str, str], MetricAggregate],
    body_loader: BodyLoader,
    *,
    min_samples: int = MIN_SAMPLES,
    min_fail_rate: float = MIN_FAIL_RATE,
) -> list[AdvisorJob]:
    """Invert the attribution map into one job per implicated (voice, template).

    A job is created only when at least one attributed metric is weak and the
    template is start_mode-relevant to the contributing runs. ``body_loader``
    resolves each template's current editable body.
    """
    # (voice, template_id) -> list of weak metric aggregates feeding it.
    per_template: dict[tuple[str, str], list[MetricAggregate]] = {}
    for (voice, metric), agg in aggregates.items():
        if not agg.meets_weakness(min_samples=min_samples, min_fail_rate=min_fail_rate):
            continue
        for template_id in METRIC_PROMPT_ATTRIBUTION.get(metric, ()):
            if _template_relevant(template_id, agg.start_modes):
                per_template.setdefault((voice, template_id), []).append(agg)

    jobs: list[AdvisorJob] = []
    for (voice, template_id), aggs in sorted(per_template.items()):
        category, body = await body_loader(voice, template_id)
        if body is None:
            logger.warning("advisor: no body for %s/%s — skipping", voice, template_id)
            continue
        evidence = tuple(
            AdvisorEvidence(
                metric=a.metric,
                n=a.n,
                mean_score=a.mean_score,
                fail_rate=a.fail_rate,
                sample_issues=a.sample_issues,
            )
            for a in sorted(aggs, key=lambda a: a.metric)
        )
        run_ids = _unique_run_ids(aggs)
        jobs.append(
            AdvisorJob(
                voice=voice,
                template_id=template_id,
                category=category,
                current_body=body,
                evidence=evidence,
                run_ids=run_ids,
            )
        )
    return jobs


def _unique_run_ids(aggs: list[MetricAggregate]) -> tuple[UUID, ...]:
    seen: dict[UUID, None] = {}
    for agg in aggs:
        for rid in agg.run_ids:
            seen.setdefault(rid, None)
    return tuple(seen)


# ---------------------------------------------------------------------------
# 4. Prompt body + rubric loaders (DB-first, file fallback)
# ---------------------------------------------------------------------------


def _bundled_source(template_id: str) -> Path | None:
    """Path to the bundled .md source for a template, or None if unknown."""
    judge = _JUDGE_DIR / f"{template_id.removeprefix('judge_')}.md"
    if template_id.startswith("judge_") and judge.exists():
        return judge
    prompt = _PROMPT_DIR / f"{template_id}.md"
    return prompt if prompt.exists() else None


def _category_for(template_id: str) -> str:
    if template_id.startswith("judge_"):
        return "judge"
    if template_id.startswith("_"):
        return "partial"
    return "agent"


async def db_body_loader(voice: str, template_id: str) -> tuple[str, str | None]:
    """Resolve a template's editable body: DB row (voice → __shared__) then file.

    Returns ``(category, body)``; ``body`` is ``None`` only when neither the DB
    nor a bundled file has the template.
    """
    from content_tool import prompts_store

    try:
        row = await prompts_store.get_template_row_standalone(template_id, voice_slug=voice)
        if row is not None:
            return row.category, row.body
    except RuntimeError:
        # prompts_store not configured (e.g. no DB) — fall through to the file.
        pass
    src = _bundled_source(template_id)
    if src is None:
        return _category_for(template_id), None
    return _category_for(template_id), src.read_text(encoding="utf-8")


async def load_advisor_prompt() -> str:
    """Return the advisor rubric body: DB row first, bundled file fallback."""
    from content_tool import prompts_store

    try:
        row = await prompts_store.get_template_row_standalone(ADVISOR_TEMPLATE_ID)
        if row is not None:
            return row.body
    except RuntimeError:
        pass
    return (_JUDGE_DIR / "prompt_advisor.md").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 5. Run the advisor + normalise
# ---------------------------------------------------------------------------


def _clamp_severity(value: object) -> int:
    try:
        sev = round(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 3
    return max(1, min(5, sev))


def _clamp_confidence(value: object) -> float | None:
    if value is None:
        return None
    try:
        conf = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, conf))


def normalise_finding(job: AdvisorJob, parsed: dict[str, Any]) -> AdvisorFinding:
    """Map the advisor's raw parsed output to a clamped :class:`AdvisorFinding`."""
    severity = _clamp_severity(parsed.get("severity"))
    directions = tuple(
        d.strip()
        for d in _as_object_list(parsed.get("directions"))
        if isinstance(d, str) and d.strip()
    )
    target = parsed.get("root_cause_target")
    root_cause = str(target) if target in _VALID_ROOT_CAUSES else "prompt"
    return AdvisorFinding(
        voice=job.voice,
        template_id=job.template_id,
        category=job.category,
        current_body=job.current_body,
        evidence=job.evidence,
        run_ids=job.run_ids,
        diagnosis=str(parsed.get("diagnosis", "")).strip(),
        severity=severity,
        score=severity / 5.0,
        directions=directions,
        root_cause_target=root_cause,
        proposed_prompt=str(parsed.get("proposed_prompt", "")),
        confidence=_clamp_confidence(parsed.get("confidence")),
        parsed=parsed,
    )


def _job_payload(job: AdvisorJob) -> dict[str, Any]:
    return {
        "template_id": job.template_id,
        "category": job.category,
        "voice_slug": job.voice,
        "current_body": job.current_body,
        "evidence": [
            {
                "metric": e.metric,
                "n": e.n,
                "mean_score": round(e.mean_score, 3) if e.mean_score is not None else None,
                "fail_rate": round(e.fail_rate, 3),
                "sample_issues": list(e.sample_issues),
            }
            for e in job.evidence
        ],
    }


async def run_advisor(
    gemini: GeminiClient, jobs: list[AdvisorJob], advisor_prompt: str
) -> list[AdvisorFinding]:
    """Diagnose every job with the advisor rubric; return findings, severity desc."""
    findings: list[AdvisorFinding] = []
    for job in jobs:
        result = await gemini.generate(
            agent=f"prompt_advisor.{job.template_id}",
            system_prompt=advisor_prompt,
            user_prompt=_dump(_job_payload(job)),
            response_schema=ADVISOR_SCHEMA,
            tools=[],
        )
        findings.append(normalise_finding(job, result.parsed))
    findings.sort(key=lambda f: (f.severity, f.score), reverse=True)
    return findings


# ---------------------------------------------------------------------------
# 6. Langfuse write-back (best-effort, never raises)
# ---------------------------------------------------------------------------


def emit_langfuse_findings(findings: list[AdvisorFinding]) -> int:
    """Attach each finding to its contributing run traces as a score + comment.

    Best-effort and gated on ``langfuse_enabled`` — a Langfuse outage or a
    disabled flag never breaks the report path. Returns the number of scores
    emitted (0 when disabled).
    """
    try:
        from content_tool.config import get_settings

        if not get_settings().langfuse_enabled:
            return 0
        from content_tool.observability.langfuse_client import get_langfuse

        lf = get_langfuse()
        if lf is None:
            return 0
    except Exception:
        logger.debug("advisor: Langfuse gating check failed", exc_info=True)
        return 0

    emitted = 0
    for finding in findings:
        comment = _dump(
            {
                "diagnosis": finding.diagnosis,
                "directions": list(finding.directions),
                "root_cause_target": finding.root_cause_target,
                "confidence": finding.confidence,
            }
        )
        for run_id in finding.run_ids:
            # A run's trace is keyed differently per backend: the Workers
            # (production) tracer uses the raw run_id UUID as the trace id,
            # while the Python v4 tracer groups generations under a 32-hex OTEL
            # id derived via Langfuse.create_trace_id(seed=run_id). Emit the
            # score to BOTH candidates so it attaches regardless of which backend
            # produced the trace; the non-matching one is accepted by ingestion
            # but dangles (hidden from the scores view), so there is no harm.
            for trace_id in _candidate_trace_ids(lf, run_id):
                try:
                    lf.create_score(
                        trace_id=trace_id,
                        name=f"prompt_advisor.{finding.template_id}",
                        value=finding.score,
                        comment=comment,
                    )
                    emitted += 1
                except Exception:
                    logger.debug(
                        "advisor: Langfuse score failed template=%s run=%s trace=%s",
                        finding.template_id,
                        run_id,
                        trace_id,
                        exc_info=True,
                    )
    return emitted


def _candidate_trace_ids(lf: Any, run_id: UUID) -> list[str]:  # noqa: ANN401
    """Trace ids a run may live under: raw run_id (Workers) + seed-derived (Python v4)."""
    raw = str(run_id)
    ids = [raw]
    try:
        derived = lf.create_trace_id(seed=raw)
        if derived and derived != raw:
            ids.append(derived)
    except Exception:
        logger.debug("advisor: create_trace_id failed for run=%s", run_id, exc_info=True)
    return ids
