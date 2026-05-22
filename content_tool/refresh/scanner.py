"""Refresh scanner — orchestrates per-article and per-tick scanning."""
from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.config import get_refresh_config, get_settings
from content_tool.db.models import Article, RefreshEvaluation, Run
from content_tool.gemini.client import GeminiClient
from content_tool.observability.cost import CostCalculator
from content_tool.refresh.deterministic_checks import deterministic_audit_published_html
from content_tool.refresh.evaluator import LLMFindings, compute_staleness, llm_audit_published
from content_tool.refresh.inventory import advance_schedule, schedule_after_retry
from content_tool.wordpress.client import WordPressClient

_COST_CALC: CostCalculator | None = None


def _get_cost_calc() -> CostCalculator:
    global _COST_CALC
    if _COST_CALC is None:
        _COST_CALC = CostCalculator.load_from("config/pricing.yaml")
    return _COST_CALC

log = structlog.get_logger(__name__)

SCANNER_VERSION = "scanner@0.1.0"
TriggerSource = Literal["cron", "manual_api", "manual_per_article"]

IN_FLIGHT_STATUSES = ("pending", "strategy", "hitl_1", "production", "hitl_2", "persisted")


@dataclass
class TickResult:
    tick_id: UUID
    scanned: int = 0
    evaluations_created: int = 0
    llm_calls: int = 0
    est_cost_usd_cents: int = 0
    started_at: datetime | None = None
    finished_at: datetime | None = None
    skipped: list[dict] = field(default_factory=list)


@asynccontextmanager
async def _advisory_lock(session: AsyncSession, key: int) -> AsyncIterator[bool]:
    """pg_try_advisory_lock(key) — non-blocking. Yields True if acquired."""
    got = (
        await session.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key})
    ).scalar_one()
    try:
        yield bool(got)
    finally:
        if got:
            await session.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})


async def scan_article(
    session: AsyncSession,
    *,
    article: Article,
    wp_client: WordPressClient,
    gemini_client: GeminiClient,
    trigger_source: TriggerSource,
    llm_budget_remaining: int,
    tick_id: UUID,
) -> tuple[RefreshEvaluation, int]:
    """Scan one article. Returns (evaluation_row, llm_calls_used).

    Caller is responsible for the surrounding transaction. The evaluation row
    is added to the session but not committed here; commit happens in
    `scan_tick` after the per-article savepoint succeeds.
    """
    now = datetime.now(UTC)
    reference = article.last_persisted_at or article.first_seen_at
    age_days = (now - reference).days if reference else 0

    log.info(
        "refresh_scan_article.started",
        tick_id=str(tick_id),
        article_id=str(article.article_id),
        article_url=article.article_url,
    )

    try:
        wp_post = await wp_client.fetch_post_by_url(article.article_url)
    except Exception as e:
        log.error(
            "refresh_scan_article.failed",
            article_id=str(article.article_id),
            exc_info=True,
        )
        ev = await _insert_evaluation(
            session,
            article=article,
            trigger_source=trigger_source,
            age_days=age_days,
            deterministic_findings={
                "findings": [],
                "error": "wp_fetch_failed",
                "detail": str(e)[:500],
                "severity_high": 0,
                "severity_medium": 0,
                "severity_low": 0,
                "passed": False,
            },
            llm_findings=None,
            llm_skipped_reason="scanner_error",
            score=Decimal("0.00"),
            action="monitor",
        )
        article.next_scan_due_at = schedule_after_retry(now=now)
        article.updated_at = now
        return ev, 0

    if wp_post is None:
        ev = await _insert_evaluation(
            session,
            article=article,
            trigger_source=trigger_source,
            age_days=age_days,
            deterministic_findings={
                "findings": [],
                "error": "wp_post_not_found",
                "severity_high": 1,
                "severity_medium": 0,
                "severity_low": 0,
                "passed": False,
            },
            llm_findings=None,
            llm_skipped_reason="no_published_html",
            score=Decimal("10.00"),
            action="refresh",
        )
        new_due = advance_schedule(action="refresh", now=now)
        if new_due is not None:
            article.next_scan_due_at = new_due
        article.updated_at = now
        return ev, 0

    if article.wp_post_id is None:
        article.wp_post_id = wp_post.id

    html_hash = hashlib.sha256(wp_post.content_html.encode("utf-8")).hexdigest()
    det = await deterministic_audit_published_html(
        wp_post.content_html,
        modified_gmt=wp_post.modified_gmt,
        last_persisted_at=article.last_persisted_at,
    )

    llm_skipped_reason: str | None = None
    llm: LLMFindings | None = None
    llm_findings_override: dict | None = None
    llm_used = 0
    if det.passed:
        llm_skipped_reason = "deterministic_passed"
    elif llm_budget_remaining <= 0:
        llm_skipped_reason = "cap_exceeded"
    else:
        try:
            llm = await llm_audit_published(
                wp_post.content_html,
                persona=article.persona,
                gemini_client=gemini_client,
            )
            llm_used = 1
            llm.model = get_settings().gemini_model
        except Exception as llm_exc:
            log.error(
                "refresh_scan_article.llm_failed",
                article_id=str(article.article_id),
                exc_info=True,
            )
            llm_skipped_reason = "llm_error"
            # Store failure detail so ops can distinguish "no LLM call" (None)
            # from "LLM call failed" (dict with error key).
            llm_findings_override = {"error": "llm_error", "detail": str(llm_exc)[:500]}

    score, action = compute_staleness(det, llm, age_days=age_days)

    est_cents: int | None = None
    if llm is not None and (llm.tokens_in or llm.tokens_out):
        est_cents = _get_cost_calc().estimate_cents(
            model=llm.model or get_settings().gemini_model,
            tokens_in=llm.tokens_in,
            tokens_out=llm.tokens_out,
            thinking_tokens=llm.thinking_tokens,
        )

    ev = await _insert_evaluation(
        session,
        article=article,
        trigger_source=trigger_source,
        age_days=age_days,
        fetched_html_hash=html_hash,
        deterministic_findings=det.to_jsonb(),
        llm_findings=(llm.raw if llm else llm_findings_override),
        llm_skipped_reason=llm_skipped_reason,
        score=score,
        action=action,
        tokens_in=llm.tokens_in if llm else None,
        tokens_out=llm.tokens_out if llm else None,
        est_cost_usd_cents=est_cents,
        latency_ms=llm.latency_ms if llm else None,
    )

    new_due = advance_schedule(action=action, now=now)
    if new_due is not None:
        article.next_scan_due_at = new_due
    article.updated_at = now

    log.info(
        "refresh_scan_article.finished",
        tick_id=str(tick_id),
        article_id=str(article.article_id),
        det_passed=det.passed,
        llm_called=(llm is not None),
        recommended_action=action,
        staleness_score=float(score),
    )
    return ev, llm_used


async def _insert_evaluation(
    session: AsyncSession,
    *,
    article: Article,
    trigger_source: str,
    age_days: int,
    deterministic_findings: dict,
    llm_findings: dict | None,
    llm_skipped_reason: str | None,
    score: Decimal,
    action: str,
    fetched_html_hash: str | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    est_cost_usd_cents: int | None = None,
    latency_ms: int | None = None,
) -> RefreshEvaluation:
    """Supersede prior open evals for the article and insert a new open eval.

    UPDATE + INSERT are atomic within the caller's transaction (in `scan_tick`
    this is a nested savepoint per article).

    Flush / refresh note:
        The returned ``RefreshEvaluation`` is added to the session but NOT
        flushed.  Python-side defaults — e.g. ``evaluation_id`` (``uuid4()``)
        — ARE populated immediately.  Server-side defaults — ``evaluated_at``
        (``server_default=text("now()")``) and ``outcome='open'`` set by the
        DB — are NOT available until after a flush.  Callers that need
        ``evaluated_at`` before commit must call ``await session.flush()``
        followed by ``await session.refresh(ev)``.
    """
    await session.execute(
        update(RefreshEvaluation)
        .where(
            RefreshEvaluation.article_id == article.article_id,
            RefreshEvaluation.outcome == "open",
        )
        .values(outcome="superseded")
    )
    ev = RefreshEvaluation(
        article_id=article.article_id,
        scanner_version=SCANNER_VERSION,
        trigger_source=trigger_source,
        age_days=age_days,
        fetched_html_hash=fetched_html_hash,
        deterministic_findings=deterministic_findings,
        llm_findings=llm_findings,
        llm_skipped_reason=llm_skipped_reason,
        staleness_score=score,
        recommended_action=action,
        outcome="open",
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        est_cost_usd_cents=est_cost_usd_cents,
        latency_ms=latency_ms,
    )
    session.add(ev)
    return ev


async def select_due_articles(
    session: AsyncSession, *, batch_size: int
) -> list[Article]:
    now = datetime.now(UTC)
    stmt = (
        select(Article)
        .where(Article.next_scan_due_at <= now)
        .where(
            (Article.dismissed_until.is_(None))
            | (Article.dismissed_until < now)
        )
        .where(
            ~select(Run.run_id)
            .where(Run.article_id == Article.article_id)
            .where(Run.status.in_(IN_FLIGHT_STATUSES))
            .exists()
        )
        .order_by(Article.next_scan_due_at.asc())
        .limit(batch_size)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


async def scan_tick(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    wp_client: WordPressClient,
    gemini_client: GeminiClient,
    trigger_source: TriggerSource = "cron",
    forced_article_ids: list[UUID] | None = None,
    force_bypass_due: bool = False,
) -> TickResult:
    cfg = get_refresh_config()
    scan_cfg = cfg["scan"]
    tick_id = uuid4()
    started_at = datetime.now(UTC)
    log.info(
        "refresh_scan_tick.started",
        tick_id=str(tick_id),
        trigger_source=trigger_source,
    )

    result = TickResult(tick_id=tick_id, started_at=started_at)

    async with session_factory() as session:
        async with _advisory_lock(session, scan_cfg["tick_lock_key"]) as got:
            if not got:
                log.warning("refresh_scan_tick.contended", tick_id=str(tick_id))
                result.finished_at = datetime.now(UTC)
                result.skipped = [{"reason": "scan_in_progress"}]
                return result

            if forced_article_ids:
                stmt = select(Article).where(
                    Article.article_id.in_(forced_article_ids)
                )
                if not force_bypass_due:
                    stmt = stmt.where(
                        Article.next_scan_due_at <= datetime.now(UTC)
                    )
                articles = list((await session.execute(stmt)).scalars().all())
                returned_ids = {a.article_id for a in articles}
                for missing in forced_article_ids:
                    if missing not in returned_ids:
                        result.skipped.append(
                            {
                                "article_id": str(missing),
                                "reason": "not_found_or_not_due",
                            }
                        )
            else:
                articles = await select_due_articles(
                    session, batch_size=scan_cfg["batch_size"]
                )

            llm_budget = scan_cfg["llm_cap_per_tick"]

            for article in articles:
                try:
                    async with session.begin_nested():
                        ev, used = await scan_article(
                            session,
                            article=article,
                            wp_client=wp_client,
                            gemini_client=gemini_client,
                            trigger_source=trigger_source,
                            llm_budget_remaining=llm_budget,
                            tick_id=tick_id,
                        )
                        llm_budget -= used
                        result.scanned += 1
                        result.evaluations_created += 1
                        result.llm_calls += used
                        if ev.est_cost_usd_cents:
                            result.est_cost_usd_cents += ev.est_cost_usd_cents
                except Exception:
                    log.error(
                        "refresh_scan_tick.article_aborted",
                        tick_id=str(tick_id),
                        article_id=str(article.article_id),
                        exc_info=True,
                    )
                    result.skipped.append(
                        {
                            "article_id": str(article.article_id),
                            "reason": "scan_exception",
                        }
                    )

            await session.commit()

    result.finished_at = datetime.now(UTC)
    log.info(
        "refresh_scan_tick.finished",
        tick_id=str(tick_id),
        scanned=result.scanned,
        evaluations_created=result.evaluations_created,
        llm_calls=result.llm_calls,
        duration_ms=int((result.finished_at - started_at).total_seconds() * 1000),
    )
    return result
