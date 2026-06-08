import json
import logging
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from content_tool.api.schemas import (
    ApplyEditsRequest,
    ApplyEditsResponse,
    ArticleEditRequest,
    CreateReviewThreadIn,
    CreateRunRequest,
    CreateRunResponse,
    DryPublishRequest,
    DryPublishResponse,
    ExistingPostOut,
    Hitl2Request,
    Hitl2SnapshotIn,
    Hitl2SnapshotOut,
    OutlineEditRequest,
    RegenerateRequest,
    RepublishResponse,
    ResumeRequest,
    ReviewReplyIn,
    ReviewResolveIn,
    ReviewThreadOut,
    RunWpMetaPatch,
)
from content_tool.api.sse import RunAlreadyExecutingError, sse_stream
from content_tool.db.models import (
    AuditRun,
    ComplianceLog,
    Draft,
    FetchedArticle,
    GapAnalysisRow,
    Hitl2Snapshot,
    OutlineRow,
    RefreshEvaluation,
    Render,
    ReviewThread,
    Run,
    RunEventLog,
    TopicCandidate,
)
from content_tool.observability.event_log_query import VALID_LEVELS, query_event_logs
from content_tool.publishers.wp_factory import resolve_wp_target
from content_tool.refresh.inventory import upsert_article
from content_tool.wordpress.client import (
    SCHEMA_JSONLD_META_KEY,
    WP_DEFAULT_PAGE_TEMPLATE,
    WordPressClient,
)
from content_tool.wordpress.seo_plugin import SeoPlugin, seo_meta_key
from content_tool.wordpress.slug import canonicalize_slug

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/runs", tags=["runs"])


async def _active_seo_plugin(state: object) -> SeoPlugin | None:
    """Resolve the SEO plugin against the live WP target (Fix C).

    Prefers the per-publish ``SeoPluginResolver`` wired up by ``init_runtime``.
    Falls back to a statically seeded ``app.state.seo_plugin`` so tests that
    build the app without ``init_runtime`` can still drive the publish payload.
    """
    resolver = getattr(state, "seo_plugin_resolver", None)
    if resolver is not None:
        return await resolver.resolve()
    return getattr(state, "seo_plugin", None)


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


def get_runner(request: Request):  # noqa: ANN201
    return request.app.state.run_executor


async def _create_run_row(
    session: AsyncSession,
    payload: CreateRunRequest,
) -> Run:
    """Insert a ``runs`` row from a validated ``CreateRunRequest``.

    Shared by ``POST /runs`` and ``POST /topic-batches/{id}/promote``. Caller
    commits the surrounding transaction.
    """
    article_id: UUID | None = None
    if payload.start_mode == "refresh":
        assert payload.article_url is not None  # validator-guaranteed
        article = await upsert_article(
            session,
            article_url=payload.article_url,
            topic=payload.topic,
            persona=payload.persona,
            topic_category=payload.topic_category,
        )
        article_id = article.article_id

    ev: RefreshEvaluation | None = None
    if payload.triggered_by_evaluation_id is not None:
        ev = await session.get(RefreshEvaluation, payload.triggered_by_evaluation_id)
        if ev is None or ev.article_id != article_id:
            raise HTTPException(
                status_code=422, detail="triggered_by_evaluation_id mismatch"
            )
        if ev.outcome != "open":
            raise HTTPException(status_code=409, detail="evaluation already resolved")

    row = Run(
        run_id=uuid4(),
        created_by=payload.editor_email,
        status="pending",
        article_url=payload.article_url,
        topic=payload.topic,
        keywords=payload.keywords,
        mode=payload.mode,
        edit_note=payload.edit_note,
        acf_adv_id=payload.acf_adv_id,
        acf_widget_id=payload.acf_widget_id,
        persona=payload.persona,
        topic_category=payload.topic_category,
        today_date=date.today(),
        article_id=article_id,
        triggered_by_evaluation_id=ev.evaluation_id if ev else None,
        start_mode=payload.start_mode,
        topic_candidate_id=payload.topic_candidate_id,
        target_audience=payload.target_audience,
        auto_accept_hitl1=payload.auto_accept_hitl1,
    )
    session.add(row)
    await session.flush()

    if ev is not None:
        ev.outcome = "triggered"
        ev.resulting_run_id = row.run_id
        ev.outcome_set_at = datetime.now(UTC)
        ev.outcome_set_by = payload.editor_email

    return row


@router.post("", response_model=CreateRunResponse)
async def create_run(
    payload: CreateRunRequest,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> CreateRunResponse:
    async with sf() as session:
        row = await _create_run_row(session, payload)
        await session.commit()
        run_id = row.run_id
        created_at = row.created_at
        article_id = row.article_id

    try:
        await runner.start(run_id)
    except RunAlreadyExecutingError as e:
        raise HTTPException(409, "run already executing") from e
    return CreateRunResponse(
        run_id=run_id,
        status="pending",
        created_at=created_at if created_at else datetime.now(UTC),
        article_id=article_id,
    )


@router.get("")
async def list_runs(
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    status: str | None = None,
    limit: int = 50,
) -> list[dict]:
    async with sf() as session:
        q = select(Run)
        if status:
            q = q.where(Run.status == status)
        q = q.order_by(Run.created_at.desc()).limit(limit)
        rows = (await session.execute(q)).scalars().all()
        return [
            {
                "run_id": str(r.run_id),
                "status": r.status,
                "topic": r.topic,
                "article_url": r.article_url,
                "mode": r.mode,
                "created_at": r.created_at.isoformat(),
                "chosen_route": r.chosen_route,
                "iteration_count": r.iteration_count,
                "start_mode": r.start_mode,
                "target_audience": r.target_audience,
                "keywords": r.keywords,
                "persona": r.persona,
                "acf_adv_id": r.acf_adv_id,
                "acf_widget_id": r.acf_widget_id,
                "edit_note": r.edit_note,
                "auto_accept_hitl1": r.auto_accept_hitl1,
                # WordPress destination — the Ledger board's WORDPRESS columns
                # read these from the list (display + inline-edit round-trip).
                "wp_author_id": r.wp_author_id,
                "wp_category_ids": r.wp_category_ids,
                "wp_tag_ids": r.wp_tag_ids,
                "wp_featured_media_id": r.wp_featured_media_id,
                "wp_slug": r.wp_slug,
                "wp_excerpt": r.wp_excerpt,
                "wp_publish_status": r.wp_publish_status,
                "wp_publish_at": r.wp_publish_at.isoformat() if r.wp_publish_at else None,
                "wp_pushed_post_id": r.wp_pushed_post_id,
            }
            for r in rows
        ]


@router.get("/{run_id}")
async def get_run(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "run not found")
        return {
            "run_id": str(row.run_id),
            "status": row.status,
            "topic": row.topic,
            "article_url": row.article_url,
            "mode": row.mode,
            "keywords": row.keywords,
            "persona": row.persona,
            "acf_adv_id": row.acf_adv_id,
            "acf_widget_id": row.acf_widget_id,
            "edit_note": row.edit_note,
            "chosen_route": row.chosen_route,
            "iteration_count": row.iteration_count,
            # Timestamps / identity
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            "created_by": row.created_by,
            # HITL_2 signals — `runs` has no hitl_*_decision columns (those
            # live in the LangGraph checkpoint state). `approved_at` and
            # `approved_by` are the durable proxies for HITL_2 approval.
            "approved_at": row.approved_at.isoformat() if row.approved_at else None,
            "approved_by": row.approved_by,
            "hitl_2_decision": row.hitl_2_decision,
            "hitl_2_notes": row.hitl_2_notes,
            "hitl_2_iteration": row.hitl_2_iteration,
            # WordPress publish outcome
            "wp_publish_status": row.wp_publish_status,
            # WordPress metadata the operator selected — surfaced so the edit
            # page can re-hydrate author / categories for create AND refresh
            # runs (a create run has no upstream post to read them back from).
            "wp_author_id": row.wp_author_id,
            "wp_category_ids": row.wp_category_ids,
            "wp_tag_ids": row.wp_tag_ids,
            "wp_featured_media_id": row.wp_featured_media_id,
            "wp_slug": row.wp_slug,
            "wp_excerpt": row.wp_excerpt,
            "wp_pushed_post_id": row.wp_pushed_post_id,
            "wp_pushed_at": row.wp_pushed_at.isoformat() if row.wp_pushed_at else None,
            "wp_push_error": row.wp_push_error,
            # Topic-expansion linkage (Front II / III)
            "start_mode": row.start_mode,
            "topic_candidate_id": (
                str(row.topic_candidate_id) if row.topic_candidate_id else None
            ),
            "target_audience": row.target_audience,
            "auto_accept_hitl1": row.auto_accept_hitl1,
            # Generic graph error
            "error": row.error,
        }


# Statuses where the LangGraph is still actively driving the run; deleting its
# rows mid-flight would race the executor, so these are refused.
_IN_MOTION_STATUSES = frozenset({"pending", "fetching", "strategy", "production"})


@router.delete("/{run_id}")
async def delete_run(
    run_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> dict:
    """Hard-delete a run and everything derived from it.

    Content artifacts (gap analysis, fetched article, outline, drafts →
    citations / renders / audits) fall away via ``ON DELETE CASCADE``. The
    ``compliance_log`` row and the soft back-references that point *at* this run
    (``topic_candidates.promoted_run_id``, ``refresh_evaluations.resulting_run_id``)
    do not cascade, so they are cleared explicitly first. Any in-flight run is
    first cancelled (its background task stopped and checkpoint dropped) so the
    delete can't race the executor.
    """
    from sqlalchemy import delete, update

    # Stop the executor before touching rows — no-op for runs with no live task.
    await runner.cancel(run_id)

    async with sf() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "run not found")

        await session.execute(
            update(TopicCandidate)
            .where(TopicCandidate.promoted_run_id == run_id)
            .values(promoted_run_id=None)
        )
        await session.execute(
            update(RefreshEvaluation)
            .where(RefreshEvaluation.resulting_run_id == run_id)
            .values(resulting_run_id=None)
        )
        await session.execute(delete(ComplianceLog).where(ComplianceLog.run_id == run_id))
        # Verbose event log has no FK (stream_id may be a run or a batch), so
        # clear it explicitly for this run before the Run row goes away.
        await session.execute(delete(RunEventLog).where(RunEventLog.stream_id == run_id))
        await session.execute(delete(Run).where(Run.run_id == run_id))
        await session.commit()
    return {"ok": True}


@router.get("/{run_id}/events")
async def events(
    run_id: UUID,
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> EventSourceResponse:
    return EventSourceResponse(sse_stream(runner, run_id))


@router.get("/{run_id}/logs")
async def run_logs(
    run_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    since_seq: int | None = None,
    limit: int = 2000,
    level: str | None = None,
) -> list[dict]:
    """Return the persisted verbose event log for a run, ordered by seq ASC."""
    if level is not None and level not in VALID_LEVELS:
        raise HTTPException(
            status_code=400,
            detail=f"invalid level {level!r}; expected one of {sorted(VALID_LEVELS)}",
        )
    async with sf() as session:
        return await query_event_logs(
            session,
            stream_id=run_id,
            since_seq=since_seq,
            limit=limit,
            level=level,
        )


@router.post("/{run_id}/resume")
async def resume_run(
    run_id: UUID,
    payload: ResumeRequest,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> dict:
    state_update: dict = {"hitl_1_decision": payload.decision}
    if payload.decision == "edit_outline" and payload.edited_outline:
        state_update["outline"] = payload.edited_outline
        # Also persist to outlines.human_edits
        from sqlalchemy import update

        from content_tool.db.models import OutlineRow

        async with sf() as session:
            await session.execute(
                update(OutlineRow)
                .where(OutlineRow.run_id == run_id)
                .values(edited_by_human=True, human_edits=payload.edited_outline)
            )
            await session.commit()
    if payload.decision == "override_route" and payload.new_route:
        state_update["chosen_route"] = payload.new_route
        # Persist to Run row so writer.py (reads run.chosen_route from DB) honors the override
        from sqlalchemy import update

        async with sf() as session:
            await session.execute(
                update(Run)
                .where(Run.run_id == run_id)
                .values(chosen_route=payload.new_route)
            )
            await session.commit()

    try:
        await runner.resume(run_id, state_update)
    except RunAlreadyExecutingError as e:
        raise HTTPException(409, "run already executing") from e
    return {"ok": True}


@router.post("/{run_id}/restart")
async def restart_run(
    run_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> dict:
    """Re-run a failed run from the top.

    Only ``failed`` runs are restartable — an in-flight or completed run must
    not have its checkpoint wiped out from under it. The ``failed → pending``
    transition is claimed with a conditional UPDATE so two concurrent restarts
    can't both drive the executor (TOCTOU between the read and the claim).
    """
    from sqlalchemy import update

    async with sf() as session:
        row = (
            await session.execute(select(Run).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "run not found")
        # Atomically claim the failed run. Only the request that flips
        # failed→pending proceeds; a concurrent restart sees rowcount 0.
        result = await session.execute(
            update(Run)
            .where(Run.run_id == run_id, Run.status == "failed")
            .values(status="pending")
        )
        await session.commit()
        if result.rowcount == 0:
            raise HTTPException(409, "only failed runs can be restarted")

    try:
        await runner.restart(run_id)
    except RunAlreadyExecutingError as e:
        raise HTTPException(409, "run already executing") from e
    return {"ok": True}


@router.post("/{run_id}/hitl-2")
async def hitl_2(
    run_id: UUID, payload: Hitl2Request,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> dict:
    from sqlalchemy import update

    async with sf() as session:
        row = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "run not found")

        comments_json = [c.model_dump() for c in (payload.comments or [])]
        is_approve = payload.decision == "approve"
        is_request_changes = payload.decision == "request_changes"

        # Cap enforcement is atomic: for request_changes the increment rides a
        # conditional UPDATE (hitl_2_iteration < 3), so two concurrent requests
        # from iteration 2 land on 3, not 4 — exactly one passes, the other 409s.
        # UI also disables at the cap; this is belt + braces against tab races.
        common_values: dict = dict(
            hitl_2_decision=payload.decision,
            hitl_2_notes=payload.notes,
            hitl_2_comments=comments_json,
            wp_publish_status=payload.wp_publish_status,
            wp_author_id=payload.wp_author_id,
            wp_category_ids=payload.wp_category_ids,
            wp_tag_ids=payload.wp_tag_ids,
            wp_featured_media_id=payload.wp_featured_media_id,
            wp_slug=payload.wp_slug,
            wp_excerpt=payload.wp_excerpt,
            wp_publish_at=payload.wp_publish_at,
        )
        if is_request_changes:
            _CAP = 3
            result = await session.execute(
                update(Run)
                .where(Run.run_id == run_id, Run.hitl_2_iteration < _CAP)
                .values(
                    hitl_2_iteration=Run.hitl_2_iteration + 1,
                    approved_at=None,
                    approved_by=None,
                    **common_values,
                )
            )
            if result.rowcount == 0:
                raise HTTPException(409, "request_changes cap reached")
            # Re-read the committed value so the resume reflects the real count.
            new_iteration = (
                await session.execute(
                    select(Run.hitl_2_iteration).where(Run.run_id == run_id)
                )
            ).scalar_one()
        else:
            # approve / reject leave the iteration counter unchanged.
            new_iteration = row.hitl_2_iteration
            await session.execute(
                update(Run).where(Run.run_id == run_id).values(
                    hitl_2_iteration=new_iteration,
                    approved_at=datetime.now(UTC) if is_approve else None,
                    # Real approver identity (email) — only stamped on approve,
                    # the event the compliance log records. Falls back to
                    # "unknown" when the sidecar runs without an authenticated
                    # identity.
                    approved_by=(payload.editor_email or "unknown") if is_approve else None,
                    **common_values,
                )
            )

        # Persist any human inline edits onto the latest render BEFORE resuming,
        # so the publish step pushes the reviewer's edited content (mirrors
        # PUT /article). Only on approve — request_changes triggers an AI rewrite
        # and reject is terminal, so neither needs the manual edit persisted.
        if is_approve:
            edited: dict[str, str] = {}
            if payload.edited_html_body is not None:
                edited["html_body"] = payload.edited_html_body
            if payload.edited_seo_title is not None:
                edited["seo_title"] = payload.edited_seo_title
            if payload.edited_meta_description is not None:
                edited["meta_description"] = payload.edited_meta_description
            if edited:
                latest_draft = (
                    await session.execute(
                        select(Draft)
                        .where(Draft.run_id == run_id)
                        .order_by(Draft.iteration.desc())
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if latest_draft is not None:
                    render_row = (
                        await session.execute(
                            select(Render).where(Render.draft_id == latest_draft.draft_id)
                        )
                    ).scalar_one_or_none()
                    if render_row is not None:
                        await session.execute(
                            update(Render)
                            .where(Render.render_id == render_row.render_id)
                            .values(**edited)
                        )

        await session.commit()

    state_update: dict = {
        "hitl_2_decision": payload.decision,
        "hitl_2_notes": payload.notes,
        "hitl_2_comments": comments_json,
        "hitl_2_iteration": new_iteration,
    }
    # request_changes no longer pins a terminal status — the graph decides.
    if payload.decision == "reject":
        state_update["status"] = "rejected"

    try:
        await runner.resume(run_id, state_update)
    except RunAlreadyExecutingError as e:
        raise HTTPException(409, "run already executing") from e
    return {"ok": True}


# How many autosave / version-history snapshots to retain per run. Older rows
# are pruned on each save so the history list stays bounded.
_HITL2_SNAPSHOT_KEEP = 50


@router.post("/{run_id}/hitl2-snapshots", response_model=Hitl2SnapshotOut)
async def save_hitl2_snapshot(
    run_id: UUID,
    payload: Hitl2SnapshotIn,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> Hitl2Snapshot:
    """Persist one autosave / version-history snapshot for the HITL_2 galley.

    Captures the reviewer's combined working state (editor body, SEO/WP
    metadata, notes, anchored comments). Prunes to the newest
    ``_HITL2_SNAPSHOT_KEEP`` rows so history stays bounded.
    """
    from sqlalchemy import delete

    async with sf() as session:
        run = (
            await session.execute(select(Run).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            raise HTTPException(404, "run not found")

        snap = Hitl2Snapshot(
            snapshot_id=uuid4(),
            run_id=run_id,
            created_by=payload.editor_email or "unknown",  # real author identity (email)
            trigger=payload.trigger,
            html_body=payload.html_body,
            seo_title=payload.seo_title,
            meta_description=payload.meta_description,
            notes=payload.notes,
            comments=[c.model_dump() for c in payload.comments] if payload.comments else None,
            wp_publish_status=payload.wp_publish_status,
            wp_author_id=payload.wp_author_id,
            wp_category_ids=payload.wp_category_ids,
            wp_tag_ids=payload.wp_tag_ids,
            wp_featured_media_id=payload.wp_featured_media_id,
            wp_slug=payload.wp_slug,
            wp_excerpt=payload.wp_excerpt,
            wp_publish_at=payload.wp_publish_at,
        )
        session.add(snap)
        await session.flush()

        stale = (
            select(Hitl2Snapshot.snapshot_id)
            .where(Hitl2Snapshot.run_id == run_id)
            .order_by(Hitl2Snapshot.created_at.desc())
            .offset(_HITL2_SNAPSHOT_KEEP)
        )
        await session.execute(
            delete(Hitl2Snapshot).where(Hitl2Snapshot.snapshot_id.in_(stale))
        )
        await session.commit()
        await session.refresh(snap)
        return snap


async def _ensure_generated_baseline(session: AsyncSession, run_id: UUID) -> None:
    """Idempotently seed a ``trigger='generated'`` baseline snapshot from the
    run's latest render, so the AI's original draft is always the v1 entry in
    the version-history panel (diffable + restorable).

    No-op when a ``generated`` row already exists or the run has no render yet.
    The body byte-equals the render's ``html_body`` so the "● Live" match works
    until the reviewer edits.
    """
    exists = (
        await session.execute(
            select(Hitl2Snapshot.snapshot_id).where(
                Hitl2Snapshot.run_id == run_id,
                Hitl2Snapshot.trigger == "generated",
            )
        )
    ).first()
    if exists is not None:
        return
    latest_draft = (
        await session.execute(
            select(Draft)
            .where(Draft.run_id == run_id)
            .order_by(Draft.iteration.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if latest_draft is None:
        return
    render = (
        await session.execute(
            select(Render).where(Render.draft_id == latest_draft.draft_id)
        )
    ).scalar_one_or_none()
    if render is None:
        return
    session.add(
        Hitl2Snapshot(
            snapshot_id=uuid4(),
            run_id=run_id,
            created_by="system:generated",
            trigger="generated",
            html_body=render.html_body,
            seo_title=render.seo_title,
            meta_description=render.meta_description,
        )
    )
    await session.commit()


@router.get("/{run_id}/hitl2-snapshots", response_model=list[Hitl2SnapshotOut])
async def list_hitl2_snapshots(
    run_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[Hitl2SnapshotOut]:
    """List the run's autosave / version-history snapshots, newest first.

    Lazily seeds the ``generated`` baseline (the original AI draft) and stamps
    each row with a stable ``version_number`` (oldest = 1) plus ``is_current``
    (its ``html_body`` matches the live render).
    """
    async with sf() as session:
        await _ensure_generated_baseline(session, run_id)
        # The live content the run would publish (latest render's body), used to
        # flag the "● Live" snapshot.
        live_body = (
            await session.execute(
                select(Render.html_body)
                .join(Draft, Render.draft_id == Draft.draft_id)
                .where(Draft.run_id == run_id)
                .order_by(Draft.iteration.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        total = (
            await session.execute(
                select(func.count())
                .select_from(Hitl2Snapshot)
                .where(Hitl2Snapshot.run_id == run_id)
            )
        ).scalar_one()
        rows = (
            await session.execute(
                select(Hitl2Snapshot)
                .where(Hitl2Snapshot.run_id == run_id)
                .order_by(Hitl2Snapshot.created_at.desc())
                .limit(_HITL2_SNAPSHOT_KEEP)
            )
        ).scalars().all()
    current_id = _current_snapshot_id(rows, live_body)
    return [
        Hitl2SnapshotOut.model_validate(r).model_copy(
            update={
                "version_number": total - i,
                "is_current": r.snapshot_id == current_id,
            }
        )
        for i, r in enumerate(rows)
    ]


def _current_snapshot_id(
    rows: list[Hitl2Snapshot], live_body: str | None
) -> UUID | None:
    """The newest snapshot whose ``html_body`` equals the live render body, if
    any. Newest-first ``rows`` means the first match is the freshest live one."""
    if live_body is None:
        return None
    for r in rows:
        if r.html_body == live_body:
            return r.snapshot_id
    return None


# --- Review threads (human-only highlight discussions) ---------------------
# A SEPARATE pipeline from the AI-edit ``comments``: these are never dispatched
# to apply-edits. comment / reply / resolve, persisted in ``review_threads``.

_REVIEW_EVENT_SQL = text(
    """
    INSERT INTO content_tool.run_event_logs
        (log_id, stream_id, stream_kind, seq, event, level, step, payload, recorded_at)
    SELECT :log_id, :stream_id, 'run',
           COALESCE(MAX(seq), -1) + 1, :event, 'info', NULL,
           CAST(:payload AS jsonb), now()
    FROM content_tool.run_event_logs
    WHERE stream_id = CAST(:stream_id AS uuid)
    """
)


async def _write_review_event(
    session: AsyncSession, run_id: UUID, event: str, payload: dict[str, object]
) -> None:
    """Append one run-event-log row for a review-thread action (audit trail).

    Best-effort: a failure here must never fail the thread mutation. The
    ``INSERT ... SELECT`` computes ``seq`` atomically within the statement so it
    does not race the streaming writer's in-memory counter.
    """
    try:
        await session.execute(
            _REVIEW_EVENT_SQL,
            {
                "log_id": str(uuid4()),
                "stream_id": str(run_id),
                "event": event,
                "payload": json.dumps(payload, ensure_ascii=False),
            },
        )
    except Exception:
        logger.warning("review_event_log_failed run_id=%s event=%s", run_id, event)


def _new_review_message(body: str, email: str | None, name: str | None) -> dict[str, object]:
    """Build one immutable review message dict (stored in the messages jsonb)."""
    return {
        "id": f"m-{uuid4().hex[:8]}",
        "author_email": email,
        "author_name": name,
        "body": body,
        "created_at": datetime.now(UTC).isoformat(),
    }


@router.get("/{run_id}/review-threads", response_model=list[ReviewThreadOut])
async def list_review_threads(
    run_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[ReviewThreadOut]:
    """List the run's human review threads, oldest-first (creation order)."""
    async with sf() as session:
        rows = (
            await session.execute(
                select(ReviewThread)
                .where(ReviewThread.run_id == run_id)
                .order_by(ReviewThread.created_at.asc())
            )
        ).scalars().all()
    return [ReviewThreadOut.model_validate(r) for r in rows]


@router.post("/{run_id}/review-threads", response_model=ReviewThreadOut)
async def create_review_thread(
    run_id: UUID,
    payload: CreateReviewThreadIn,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> ReviewThreadOut:
    """Open a new review thread anchored to a highlighted passage."""
    async with sf() as session:
        run = (
            await session.execute(select(Run).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            raise HTTPException(404, "run not found")
        message = _new_review_message(payload.body, payload.editor_email, payload.editor_name)
        thread = ReviewThread(
            thread_id=uuid4(),
            run_id=run_id,
            anchor_id=payload.anchor_id,
            anchor_text=payload.anchor_text,
            status="open",
            messages=[message],
            created_by=payload.editor_email,
            created_by_name=payload.editor_name,
        )
        session.add(thread)
        await _write_review_event(
            session, run_id, "review.thread.created", {"anchor_id": payload.anchor_id}
        )
        await session.commit()
        await session.refresh(thread)
    return ReviewThreadOut.model_validate(thread)


async def _load_thread(
    session: AsyncSession, run_id: UUID, thread_id: UUID
) -> ReviewThread:
    thread = (
        await session.execute(
            select(ReviewThread).where(
                ReviewThread.thread_id == thread_id,
                ReviewThread.run_id == run_id,
            )
        )
    ).scalar_one_or_none()
    if thread is None:
        raise HTTPException(404, "thread not found")
    return thread


@router.post(
    "/{run_id}/review-threads/{thread_id}/replies", response_model=ReviewThreadOut
)
async def reply_review_thread(
    run_id: UUID,
    thread_id: UUID,
    payload: ReviewReplyIn,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> ReviewThreadOut:
    """Append a reply to an existing review thread."""
    async with sf() as session:
        thread = await _load_thread(session, run_id, thread_id)
        message = _new_review_message(payload.body, payload.editor_email, payload.editor_name)
        # Reassign (don't mutate in place) so SQLAlchemy flags the JSONB dirty.
        thread.messages = [*thread.messages, message]
        thread.updated_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(thread)
    return ReviewThreadOut.model_validate(thread)


@router.post(
    "/{run_id}/review-threads/{thread_id}/resolve", response_model=ReviewThreadOut
)
async def resolve_review_thread(
    run_id: UUID,
    thread_id: UUID,
    payload: ReviewResolveIn,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> ReviewThreadOut:
    """Resolve or reopen a review thread (audited in the run event log)."""
    async with sf() as session:
        thread = await _load_thread(session, run_id, thread_id)
        now = datetime.now(UTC)
        if payload.resolved:
            thread.status = "resolved"
            thread.resolved_by = payload.editor_email
            thread.resolved_by_name = payload.editor_name
            thread.resolved_at = now
        else:
            thread.status = "open"
            thread.resolved_by = None
            thread.resolved_by_name = None
            thread.resolved_at = None
        thread.updated_at = now
        await _write_review_event(
            session,
            run_id,
            "review.thread.resolved" if payload.resolved else "review.thread.reopened",
            {"thread_id": str(thread_id), "by": payload.editor_email},
        )
        await session.commit()
        await session.refresh(thread)
    return ReviewThreadOut.model_validate(thread)


@router.delete("/{run_id}/review-threads/{thread_id}", status_code=204)
async def delete_review_thread(
    run_id: UUID,
    thread_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> None:
    """Delete a review thread."""
    async with sf() as session:
        await session.execute(
            delete(ReviewThread).where(
                ReviewThread.thread_id == thread_id,
                ReviewThread.run_id == run_id,
            )
        )
        await session.commit()


@router.get("/{run_id}/drafts")
async def list_drafts(
    run_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[dict[str, object]]:
    """All draft iterations that produced a render, newest-first, with the
    render body + SEO metadata.

    Powers the unified run-history timeline: AI/regenerate iterations are
    interleaved with reviewer snapshots so a run reads as one chronology, and a
    draft can be restored into the editor. Iterations without a render are
    omitted (there is nothing restorable). Mirrors the Workers ``GET
    /:id/drafts`` shape byte-for-byte for the parity gate.
    """
    async with sf() as session:
        rows = (
            await session.execute(
                select(Draft, Render)
                .join(Render, Render.draft_id == Draft.draft_id)
                .where(Draft.run_id == run_id)
                .order_by(Draft.iteration.desc())
            )
        ).all()
    return [
        {
            "draft_id": str(draft.draft_id),
            "iteration": draft.iteration,
            "created_at": draft.created_at.isoformat(),
            "html_body": render.html_body,
            "seo_title": render.seo_title,
            "meta_description": render.meta_description,
        }
        for draft, render in rows
    ]


@router.get("/{run_id}/gap-analysis")
async def get_gap_analysis(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        row = (
            await session.execute(select(GapAnalysisRow).where(GapAnalysisRow.run_id == run_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        return row.payload


@router.get("/{run_id}/outline")
async def get_outline(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        row = (
            await session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        return {
            "payload": row.payload,
            "edited_by_human": row.edited_by_human,
            "human_edits": row.human_edits,
            # Optimistic-concurrency token — echo back as `expected_version` on
            # PUT /outline so a stale edit is rejected instead of clobbering.
            "version": row.version,
        }


@router.get("/{run_id}/drafts/latest")
async def get_latest_draft(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        q = select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        row = (await session.execute(q)).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        return {
            "draft_id": str(row.draft_id),
            "iteration": row.iteration,
            "diagnose": row.diagnose,
            "markup_raw": row.markup_raw,
            "final_markup": row.final_markup,
        }


@router.get("/{run_id}/render")
async def get_latest_render(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        q = select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        latest_draft = (await session.execute(q)).scalar_one_or_none()
        if not latest_draft:
            raise HTTPException(404, "no draft")
        render = (
            await session.execute(
                select(Render).where(Render.draft_id == latest_draft.draft_id)
            )
        ).scalar_one_or_none()
        if not render:
            raise HTTPException(404, "no render")
        return {
            "seo_title": render.seo_title,
            "meta_description": render.meta_description,
            "html_body": render.html_body,
            "faq_schema_jsonld": render.faq_schema_jsonld,
            "schema_jsonld": render.schema_jsonld,
            "excerpt_suggestion": render.excerpt_suggestion,
            "slug_suggestion": render.slug_suggestion,
            # Optimistic-concurrency token — echo back as `expected_version` on
            # PUT /article so a stale edit is rejected instead of clobbering.
            "version": render.version,
        }


@router.put("/{run_id}/outline")
async def edit_outline(
    run_id: UUID,
    payload: OutlineEditRequest,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Persist a post-hoc outline edit to ``outlines.human_edits``.

    Unlike ``/resume`` (which drives the HITL_1 gate), this is a plain record
    update for finished runs and never touches the LangGraph checkpoint.
    """
    from sqlalchemy import update

    async with sf() as session:
        row = (
            await session.execute(select(OutlineRow).where(OutlineRow.run_id == run_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "no outline for this run")
        stmt = update(OutlineRow).where(OutlineRow.run_id == run_id)
        if payload.expected_version is not None:
            stmt = stmt.where(OutlineRow.version == payload.expected_version)
        result = await session.execute(
            stmt.values(
                edited_by_human=True,
                human_edits=payload.outline,
                version=OutlineRow.version + 1,
            )
        )
        if result.rowcount == 0:
            # Conditional WHERE matched no row → another reviewer saved since the
            # client loaded this outline. `row.version` is the committed current.
            raise HTTPException(
                409,
                {
                    "error": "stale_version",
                    "message": "outline was changed since you loaded it",
                    "current_version": row.version,
                },
            )
        await session.commit()
    return {"ok": True, "version": row.version + 1}


@router.put("/{run_id}/article")
async def edit_article(
    run_id: UUID,
    payload: ArticleEditRequest,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Persist a post-hoc article edit for a finished run.

    Writes body/SEO onto the latest Render row and WP metadata onto the Run
    row, so a subsequent ``/republish`` pushes the edited content. Only WP
    fields explicitly provided are overwritten.
    """
    from sqlalchemy import update

    q = select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
    async with sf() as session:
        latest_draft = (await session.execute(q)).scalar_one_or_none()
        if not latest_draft:
            raise HTTPException(404, "no draft for this run")
        render = (
            await session.execute(select(Render).where(Render.draft_id == latest_draft.draft_id))
        ).scalar_one_or_none()
        if not render:
            raise HTTPException(404, "no render for this run")

        stmt = update(Render).where(Render.render_id == render.render_id)
        if payload.expected_version is not None:
            stmt = stmt.where(Render.version == payload.expected_version)
        result = await session.execute(
            stmt.values(
                html_body=payload.html_body,
                seo_title=payload.seo_title,
                meta_description=payload.meta_description,
                version=Render.version + 1,
            )
        )
        if result.rowcount == 0:
            # Conditional WHERE matched no row → another reviewer saved since the
            # client loaded this render. `render.version` is the committed current.
            raise HTTPException(
                409,
                {
                    "error": "stale_version",
                    "message": "article was changed since you loaded it",
                    "current_version": render.version,
                },
            )

        wp_values: dict = {
            field: getattr(payload, field)
            for field in (
                "wp_publish_status",
                "wp_author_id",
                "wp_category_ids",
                "wp_tag_ids",
                "wp_featured_media_id",
                "wp_slug",
                "wp_excerpt",
                "wp_publish_at",
            )
            if getattr(payload, field) is not None
        }
        if wp_values:
            await session.execute(update(Run).where(Run.run_id == run_id).values(**wp_values))
        await session.commit()
    return {"ok": True}


# Editable run fields exposed by the Ledger board's inline cells. Persona/Voice
# is intentionally excluded — it is read-only in the board (audit decision 1).
_PATCH_RUN_FIELDS = (
    "acf_adv_id",
    "acf_widget_id",
    "wp_author_id",
    "wp_category_ids",
    "wp_slug",
    "wp_publish_status",
    "wp_publish_at",
)


@router.patch("/{run_id}")
async def patch_run_wp_meta(
    run_id: UUID,
    payload: RunWpMetaPatch,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Partial-update a run's destination / brief fields (Ledger inline edits).

    Only the fields the caller actually supplied (non-null) are overwritten,
    mirroring the ``wp_values`` block in ``PUT /article``. Optimistic concurrency
    uses the latest Render's ``version`` (the run's content token, shared with
    ``PUT /article``): when ``expected_version`` is set, a stale value is rejected
    with 409 ``stale_version`` and nothing is written. ``wp_slug`` is canonicalized
    (decode-then-encode) so the grid shows decoded and WordPress receives encoded.
    """
    from sqlalchemy import update

    values: dict = {
        field: getattr(payload, field)
        for field in _PATCH_RUN_FIELDS
        if getattr(payload, field) is not None
    }
    if "wp_slug" in values:
        values["wp_slug"] = canonicalize_slug(values["wp_slug"])

    async with sf() as session:
        run = (
            await session.execute(select(Run).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            raise HTTPException(404, "run not found")

        # The latest render holds the optimistic-concurrency token. A run still
        # generating may not have one yet — destination edits without a version
        # are then last-write-wins.
        draft_q = (
            select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        )
        latest_draft = (await session.execute(draft_q)).scalar_one_or_none()
        render = None
        if latest_draft is not None:
            render = (
                await session.execute(
                    select(Render).where(Render.draft_id == latest_draft.draft_id)
                )
            ).scalar_one_or_none()

        new_version: int | None = None
        if render is not None:
            # Snapshot the committed version BEFORE the UPDATE — issuing the
            # statement synchronizes the in-memory attribute, so reading it after
            # would already reflect the bump.
            current_version = render.version
        if payload.expected_version is not None:
            if render is None:
                raise HTTPException(404, "no render for this run")
            result = await session.execute(
                update(Render)
                .where(
                    Render.render_id == render.render_id,
                    Render.version == payload.expected_version,
                )
                .values(version=Render.version + 1)
            )
            if result.rowcount == 0:
                # Conditional WHERE matched no row → another reviewer saved since
                # the client loaded this render. `current_version` is the current.
                raise HTTPException(
                    409,
                    {
                        "error": "stale_version",
                        "message": "run was changed since you loaded it",
                        "current_version": current_version,
                    },
                )
            new_version = current_version + 1
        elif render is not None:
            # Last-write-wins, but still advance the token so a concurrent article
            # editor holding the old version is rejected on their next save.
            await session.execute(
                update(Render)
                .where(Render.render_id == render.render_id)
                .values(version=Render.version + 1)
            )
            new_version = current_version + 1

        if values:
            await session.execute(update(Run).where(Run.run_id == run_id).values(**values))
        await session.commit()
    return {"ok": True, "version": new_version}


@router.post("/{run_id}/republish", response_model=RepublishResponse)
async def republish(
    run_id: UUID,
    request: Request,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Re-push the (already persisted) render + WP metadata to WordPress.

    Operator-initiated overwrite of a finished run's post. Reads the durable
    Render / Run values — call ``PUT /article`` first to save edits. Runs the
    publish directly (no graph), reusing ``publish_to_wordpress`` so refresh
    runs update their existing post and create runs update their minted draft.
    """
    from content_tool.agents.publish import publish_to_wordpress
    from content_tool.wordpress.client import WordPressError

    wp_client = getattr(request.app.state, "wp_client", None)
    if wp_client is None:
        raise HTTPException(503, "WordPress client not configured")
    # SEO-plugin detection stays on the process default — matches the dry-publish
    # preview's simplification; the per-voice WP *client* below is what routes the
    # actual push to the correct instance.
    seo_plugin = await _active_seo_plugin(request.app.state)

    draft_q = select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
    async with sf() as session:
        run = (
            await session.execute(select(Run).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        if not run:
            raise HTTPException(404, "run not found")
        latest_draft = (await session.execute(draft_q)).scalar_one_or_none()
        if not latest_draft:
            raise HTTPException(409, "run has no draft to publish")
        render = (
            await session.execute(select(Render).where(Render.draft_id == latest_draft.draft_id))
        ).scalar_one_or_none()
        if not render:
            raise HTTPException(409, "run has no render to publish")

        # Re-push to the run's own voice CMS. A misconfigured / archived target
        # surfaces as 503 — never a silent push to the default (Bowtie) instance.
        try:
            resolved = await resolve_wp_target(
                session=session,
                persona_slug=run.persona,
                default_client=wp_client,
                default_label=getattr(request.app.state, "wp_target", ""),
            )
        except (ValueError, OSError) as e:
            logger.warning("WP target resolution failed for run %s: %s", run_id, e)
            raise HTTPException(503, "WordPress client not configured") from e
        target_client = resolved.client or wp_client

        try:
            result = await publish_to_wordpress(
                session=session,
                run_id=run_id,
                wp_client=target_client,
                seo_plugin=seo_plugin,
                if_unmodified_since=None,
            )
        except WordPressError as e:
            raise HTTPException(502, f"WordPress upstream error: {e}") from e

    return {
        "wp_post_id": result["id"],
        "link": result.get("link"),
        "status": result["status"],
    }


def _refine_notes_from_feedback(payload: RegenerateRequest) -> list[dict] | None:
    """Translate reviewer feedback into the writer's ``refine_notes`` shape.

    Mirrors the HITL_2 path in ``graph/production.py`` so post-hoc regeneration
    feeds the writer the same way an in-flight ``request_changes`` would.
    """
    notes: list[dict] = []
    for c in payload.comments or []:
        notes.append({
            "source": "reviewer",
            "severity": "high",
            "must_fix": True,
            "issue": f'On span "{c.anchor_text}": {c.body}',
        })
    if payload.notes:
        notes.append({
            "source": "reviewer-overall",
            "severity": "high",
            "must_fix": True,
            "issue": f"Overall reviewer note: {payload.notes}",
        })
    return notes or None


@router.post("/{run_id}/regenerate")
async def regenerate_run(
    run_id: UUID,
    payload: RegenerateRequest,
    request: Request,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Re-run the AI on a finished run using editor comments, like HITL_2.

    Runs writer → resolve_citations → render → audit at a fresh iteration
    (preserving prior drafts) so the new render becomes the latest. The operator
    then verifies and re-pushes from the standalone edit page — nothing is
    published here. Refused while the run is still in flight.
    """
    from content_tool.agents.audit import run_audit
    from content_tool.agents.render_html import run_render_html
    from content_tool.agents.resolve_citations import run_resolve_citations
    from content_tool.agents.writer import run_writer

    gemini = getattr(request.app.state, "gemini_client", None)
    if gemini is None:
        raise HTTPException(503, "Gemini client not configured")

    draft_q = select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
    async with sf() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one_or_none()
        if not run:
            raise HTTPException(404, "run not found")
        if run.status in _IN_MOTION_STATUSES or run.status in {"hitl_1", "hitl_2"}:
            raise HTTPException(409, "run is still in flight — use the HITL gates instead")
        latest_draft = (await session.execute(draft_q)).scalar_one_or_none()
        if not latest_draft:
            raise HTTPException(409, "run has no draft to regenerate")
        topic_category = run.topic_category
        today = run.today_date
        prev_hitl_2_iteration = run.hitl_2_iteration
        new_iter = latest_draft.iteration + 1

    refine_notes = _refine_notes_from_feedback(payload)

    async with sf() as session:
        result = await run_writer(
            session=session,
            gemini=gemini,
            run_id=run_id,
            iteration=new_iter,
            today=today,
            refine_notes=refine_notes,
        )
    draft_id = result.draft_id
    async with sf() as session:
        await run_resolve_citations(
            session=session, draft_id=draft_id, topic_category=topic_category
        )
    async with sf() as session:
        await run_render_html(session=session, draft_id=draft_id)
    async with sf() as session:
        await run_audit(
            session=session,
            gemini=gemini,
            draft_id=draft_id,
            topic_category=topic_category,
            today=today,
        )

    from sqlalchemy import update

    async with sf() as session:
        await session.execute(
            update(Run)
            .where(Run.run_id == run_id)
            .values(
                iteration_count=new_iter,
                hitl_2_notes=payload.notes,
                hitl_2_comments=(
                    [c.model_dump() for c in payload.comments] if payload.comments else None
                ),
                hitl_2_iteration=prev_hitl_2_iteration + 1,
            )
        )
        await session.commit()

    return {"ok": True, "iteration": new_iter, "draft_id": str(draft_id)}


@router.post("/{run_id}/apply-edits")
async def apply_edits_run(
    run_id: UUID,
    payload: ApplyEditsRequest,
    request: Request,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> ApplyEditsResponse:
    """Apply reviewer feedback to the supplied HTML in place and return it.

    Stateless AI edit: the agent revises ``html_body`` per the anchored comments
    and/or overall notes, returning the revised HTML for the editor to review. No
    new draft / render is created and nothing is published — that happens through
    the existing Save / Approve flows. Works on a paused HITL_2 run or a finished
    one alike, since it never touches run state.
    """
    from pydantic import ValidationError

    from content_tool.agents.apply_edits import run_apply_edits

    gemini = getattr(request.app.state, "gemini_client", None)
    if gemini is None:
        raise HTTPException(503, "Gemini client not configured")

    if not payload.html_body.strip():
        raise HTTPException(400, "html_body is required")
    comments = payload.comments or []
    has_comment = any(c.body.strip() for c in comments)
    has_notes = bool((payload.notes or "").strip())
    if not has_comment and not has_notes:
        raise HTTPException(400, "no comments or notes provided")

    async with sf() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one_or_none()
        if not run:
            raise HTTPException(404, "run not found")
        try:
            revised = await run_apply_edits(
                session=session,
                gemini=gemini,
                run=run,
                html_body=payload.html_body,
                comments=comments,
                notes=payload.notes,
            )
        except ValidationError as e:
            raise HTTPException(502, "AI edit returned a malformed response") from e
    return ApplyEditsResponse(html_body=revised)


@router.get("/{run_id}/audit")
async def get_latest_audit(run_id: UUID, sf=Depends(get_session_factory)) -> dict:  # noqa: ANN001, B008
    async with sf() as session:
        q = select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        latest_draft = (await session.execute(q)).scalar_one_or_none()
        if not latest_draft:
            raise HTTPException(404, "no draft")
        audit = (
            await session.execute(
                select(AuditRun).where(AuditRun.draft_id == latest_draft.draft_id)
            )
        ).scalar_one_or_none()
        if not audit:
            raise HTTPException(404, "no audit")
        return {
            "overall_pass": audit.overall_pass,
            "severity_high": audit.severity_high,
            "severity_medium": audit.severity_medium,
            "severity_low": audit.severity_low,
            "llm_findings": audit.llm_findings,
            "deterministic_findings": audit.deterministic_findings,
        }


@router.post("/{run_id}/dry-publish", response_model=DryPublishResponse)
async def dry_publish(
    run_id: UUID,
    request: Request,
    overrides: DryPublishRequest | None = Body(None),  # noqa: B008
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Return the exact REST payload we'd send to WP, WITHOUT calling WP.

    Accepts an optional body of in-progress HITL2 edits; when present, those
    fields override the persisted Render / Run values so the preview reflects
    unsaved reviewer edits.
    """
    seo_plugin = await _active_seo_plugin(request.app.state)

    async with sf() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        # Reflect the voice's actual publish target so the operator verifies the
        # right CMS before approving HITL_2 (NULL voice → process default).
        resolved_target = await resolve_wp_target(
            session=session,
            persona_slug=run.persona,
            default_client=request.app.state.wp_client,
            default_label=request.app.state.wp_target,
        )
        target_base = (
            resolved_target.client.base_url
            if resolved_target.client is not None
            else request.app.state.wp_client.base_url
        )
        target_label = resolved_target.label
        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run_id)
        )).scalar_one_or_none()
        draft = (await session.execute(
            select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
        )).scalar_one()
        render = (await session.execute(
            select(Render).where(Render.draft_id == draft.draft_id)
        )).scalar_one()

    ov = overrides or DryPublishRequest()

    title = ov.edited_seo_title if ov.edited_seo_title is not None else render.seo_title
    content = ov.edited_html_body if ov.edited_html_body is not None else render.html_body
    meta_desc = (
        ov.edited_meta_description
        if ov.edited_meta_description is not None
        else render.meta_description
    )
    status = ov.wp_publish_status or run.wp_publish_status or "draft"
    categories = (
        ov.wp_category_ids if ov.wp_category_ids is not None else (run.wp_category_ids or [])
    )
    tags = ov.wp_tag_ids if ov.wp_tag_ids is not None else (run.wp_tag_ids or [])
    excerpt = (
        ov.wp_excerpt
        if ov.wp_excerpt is not None
        else (run.wp_excerpt or render.excerpt_suggestion)
    )
    slug = ov.wp_slug if ov.wp_slug is not None else run.wp_slug
    author = ov.wp_author_id if ov.wp_author_id is not None else run.wp_author_id
    featured_media = (
        ov.wp_featured_media_id
        if ov.wp_featured_media_id is not None
        else run.wp_featured_media_id
    )

    meta_key = seo_meta_key(seo_plugin)
    meta: dict[str, str] = {meta_key: meta_desc} if meta_key else {}
    # Mirror the actual publish payload: the structured-data graph rides along
    # as out-of-band post meta (consumed by the WP-side schema filter), never
    # inlined into the body.
    if render.schema_jsonld:
        meta[SCHEMA_JSONLD_META_KEY] = json.dumps(render.schema_jsonld, ensure_ascii=False)

    body: dict = {
        "title": title,
        "content": content,
        "status": status,
        "categories": categories,
        "tags": tags,
        "meta": meta,
        # Mirror the actual publish payload: force the theme default template.
        "template": WP_DEFAULT_PAGE_TEMPLATE,
    }
    if excerpt:
        body["excerpt"] = excerpt
    if slug:
        body["slug"] = slug
    if author:
        body["author"] = author
    if featured_media:
        body["featured_media"] = featured_media

    publish_at = ov.wp_publish_at if ov.wp_publish_at is not None else run.wp_publish_at
    if publish_at is not None:
        body["date_gmt"] = publish_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")

    wp_post_id = fa.wp_post_id if fa is not None else None
    url = (
        f"{target_base}/wp-json/wp/v2/posts/{wp_post_id}"
        if wp_post_id
        else f"{target_base}/wp-json/wp/v2/posts"
    )
    method = "PUT" if wp_post_id else "POST"

    return {
        "target_base_url": target_base,
        "target_label": target_label,
        "request_method": method,
        "request_url": url,
        "request_headers": {
            "authorization": "Basic <redacted>",
            "content-type": "application/json",
        },
        "request_body": body,
    }


async def _resolve_run_wp_client(
    session: AsyncSession,
    request: Request,
    persona_slug: str | None,
) -> tuple[WordPressClient | None, str]:
    """Best-effort: resolve a run's voice to its WordPress client + a cache-key
    prefix (the target base URL).

    For cosmetic name lookups. An archived/missing target or absent credentials
    falls back to the process-default client (names degrade to raw ids) rather
    than failing the request. Publish paths resolve strictly instead.
    """
    default_client = getattr(request.app.state, "wp_client", None)
    try:
        resolved = await resolve_wp_target(
            session=session,
            persona_slug=persona_slug,
            default_client=default_client,
            default_label=getattr(request.app.state, "wp_target", ""),
        )
    except (ValueError, OSError) as e:
        logger.warning("WP target resolution failed for voice %r: %s", persona_slug, e)
        return default_client, ""
    client = resolved.client or default_client
    prefix = getattr(client, "base_url", "") or ""
    return client, prefix


async def _resolve_wp_names(
    request: Request,
    author_id: int | None,
    category_id: int | None,
    *,
    wp: WordPressClient | None = None,
    cache_prefix: str = "",
) -> tuple[str | None, str | None]:
    """Best-effort resolution of WP author / category display names.

    Uses single-resource GETs (cached on app.state.wp_options_cache) so a
    blocked /wp-json/wp/v2/users list endpoint doesn't take out the page.
    Any upstream failure → None so the UI falls back to the raw ID.

    ``wp`` is the per-voice WordPress client to read names from (defaults to the
    process client); ``cache_prefix`` (the target's base URL) keys the cache so
    ids don't collide across CMS instances — author #5 on Bowtie and #5 on
    VHIS101 are distinct people.
    """
    from content_tool.wordpress.client import WordPressError

    cache = request.app.state.wp_options_cache
    client = wp if wp is not None else request.app.state.wp_client

    async def _author() -> str | None:
        if author_id is None:
            return None
        uid = author_id  # narrowed to int for the deferred lambda
        try:
            user = await cache.get_or_set(
                f"{cache_prefix}:user:{uid}", lambda: client.get_user(uid)
            )
        except WordPressError as e:
            logger.warning("WP get_user(%s) failed: %s", uid, e)
            return None
        return user.name if user else None

    async def _category() -> str | None:
        if category_id is None:
            return None
        cid = category_id  # narrowed to int for the deferred lambda
        try:
            cat = await cache.get_or_set(
                f"{cache_prefix}:category:{cid}",
                lambda: client.get_category(cid),
            )
        except WordPressError as e:
            logger.warning("WP get_category(%s) failed: %s", category_id, e)
            return None
        return cat.name if cat else None

    return await _author(), await _category()


@router.get("/{run_id}/existing-post", response_model=ExistingPostOut)
async def get_existing_post(
    run_id: UUID,
    request: Request,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Return the cached snapshot of the existing WP post for this run.

    404 when there's no fetched-article row, or when wp_post_id is null
    (e.g. brand-new-post path).
    """
    async with sf() as session:
        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run_id)
        )).scalar_one_or_none()
        if fa is None or fa.wp_post_id is None:
            raise HTTPException(status_code=404, detail="No existing post")
        run = (await session.execute(
            select(Run).where(Run.run_id == run_id)
        )).scalar_one_or_none()
        # Resolve names against the run's voice CMS (best-effort).
        wp, cache_prefix = await _resolve_run_wp_client(
            session, request, run.persona if run else None
        )

    cats = fa.wp_categories or []
    first_cat_id = (
        cats[0]["id"]
        if cats and isinstance(cats[0], dict) and "id" in cats[0]
        else None
    )

    author_name, category_name = await _resolve_wp_names(
        request, fa.wp_author_id, first_cat_id, wp=wp, cache_prefix=cache_prefix
    )

    return {
        "wp_post_id": fa.wp_post_id,
        "link": fa.wp_link,
        "wp_author_id": fa.wp_author_id,
        "wp_author_name": author_name,
        "wp_category_id": first_cat_id,
        "wp_category_name": category_name,
        "wp_slug": fa.wp_slug,
    }


@router.post("/{run_id}/existing-post/refresh", response_model=ExistingPostOut)
async def refresh_existing_post(
    run_id: UUID,
    request: Request,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> dict:
    """Re-read the existing post from WP and update the cached row.

    Refreshes wp_author_id / wp_slug / wp_link / wp_categories only.
    Leaves raw_html / markdown / wp_post_id intact (those drove the writer).
    """
    from content_tool.wordpress.client import WordPressError

    async with sf() as session:
        run = (await session.execute(
            select(Run).where(Run.run_id == run_id)
        )).scalar_one_or_none()
        if run is None:
            raise HTTPException(status_code=404, detail="Run not found")

        # Re-read the post from the run's own voice CMS. A misconfigured /
        # archived target surfaces as 503 — never a silent read of the default
        # (Bowtie) instance for a non-default voice.
        try:
            resolved = await resolve_wp_target(
                session=session,
                persona_slug=run.persona,
                default_client=request.app.state.wp_client,
                default_label=getattr(request.app.state, "wp_target", ""),
            )
        except (ValueError, OSError) as e:
            logger.warning("WP target resolution failed for run %s: %s", run_id, e)
            raise HTTPException(
                status_code=503, detail="WordPress client not configured"
            ) from e
        wp = resolved.client
        if wp is None:
            raise HTTPException(status_code=503, detail="WordPress client not configured")
        cache_prefix = getattr(wp, "base_url", "") or ""

        try:
            post = await wp.fetch_post_by_url(run.article_url)
        except WordPressError as e:
            logger.warning("WordPress refresh failed for run %s: %s", run_id, e)
            raise HTTPException(status_code=502, detail="WordPress upstream error") from e

        if post is None:
            raise HTTPException(status_code=404, detail="Existing post not found on WordPress")

        fa = (await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run_id)
        )).scalar_one_or_none()
        if fa is None:
            raise HTTPException(status_code=404, detail="No fetched article for this run")

        # Store categories as id-only dicts; name resolution is only needed for
        # the /wp-options/categories dropdown, not for prefill.
        fa.wp_categories = [{"id": cid} for cid in post.categories]
        fa.wp_author_id = post.author
        fa.wp_slug = post.slug
        fa.wp_link = post.link
        await session.commit()

    first_cat_id = post.categories[0] if post.categories else None
    author_name, category_name = await _resolve_wp_names(
        request, post.author, first_cat_id, wp=wp, cache_prefix=cache_prefix
    )
    return {
        "wp_post_id": post.id,
        "link": post.link,
        "wp_author_id": post.author,
        "wp_author_name": author_name,
        "wp_category_id": first_cat_id,
        "wp_category_name": category_name,
        "wp_slug": post.slug,
    }
