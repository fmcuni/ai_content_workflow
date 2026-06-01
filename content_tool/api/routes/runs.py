import json
import logging
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from content_tool.api.schemas import (
    ApplyEditsRequest,
    ApplyEditsResponse,
    ArticleEditRequest,
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
)
from content_tool.api.sse import sse_stream
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
    Run,
    TopicCandidate,
)
from content_tool.refresh.inventory import upsert_article
from content_tool.wordpress.client import (
    SCHEMA_JSONLD_META_KEY,
    WP_DEFAULT_PAGE_TEMPLATE,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/runs", tags=["runs"])


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

    await runner.start(run_id)
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
        await session.execute(delete(Run).where(Run.run_id == run_id))
        await session.commit()
    return {"ok": True}


@router.get("/{run_id}/events")
async def events(
    run_id: UUID,
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> EventSourceResponse:
    return EventSourceResponse(sse_stream(runner, run_id))


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

    await runner.resume(run_id, state_update)
    return {"ok": True}


@router.post("/{run_id}/restart")
async def restart_run(
    run_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
    runner=Depends(get_runner),  # noqa: ANN001, B008
) -> dict:
    """Re-run a failed run from the top.

    Only ``failed`` runs are restartable — an in-flight or completed run must
    not have its checkpoint wiped out from under it.
    """
    async with sf() as session:
        row = (
            await session.execute(select(Run).where(Run.run_id == run_id))
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "run not found")
        if row.status != "failed":
            raise HTTPException(409, "only failed runs can be restarted")

    await runner.restart(run_id)
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

        # Cap defense — UI also disables; this is belt + braces against tab races.
        if payload.decision == "request_changes" and row.hitl_2_iteration >= 3:
            raise HTTPException(409, "request_changes cap reached")

        new_iteration = (
            row.hitl_2_iteration + 1
            if payload.decision == "request_changes"
            else row.hitl_2_iteration
        )
        comments_json = [c.model_dump() for c in (payload.comments or [])]

        is_approve = payload.decision == "approve"
        await session.execute(
            update(Run).where(Run.run_id == run_id).values(
                hitl_2_decision=payload.decision,
                hitl_2_notes=payload.notes,
                hitl_2_comments=comments_json,
                hitl_2_iteration=new_iteration,
                approved_at=datetime.now(UTC) if is_approve else None,
                # Real approver identity (email) — only stamped on approve, the
                # event the compliance log records. Falls back to "unknown" when
                # the sidecar runs without an authenticated identity.
                approved_by=(payload.editor_email or "unknown") if is_approve else None,
                wp_publish_status=payload.wp_publish_status,
                wp_author_id=payload.wp_author_id,
                wp_category_ids=payload.wp_category_ids,
                wp_tag_ids=payload.wp_tag_ids,
                wp_featured_media_id=payload.wp_featured_media_id,
                wp_slug=payload.wp_slug,
                wp_excerpt=payload.wp_excerpt,
                wp_publish_at=payload.wp_publish_at,
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

    await runner.resume(run_id, state_update)
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


@router.get("/{run_id}/hitl2-snapshots", response_model=list[Hitl2SnapshotOut])
async def list_hitl2_snapshots(
    run_id: UUID,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[Hitl2Snapshot]:
    """List the run's autosave / version-history snapshots, newest first."""
    async with sf() as session:
        rows = (
            await session.execute(
                select(Hitl2Snapshot)
                .where(Hitl2Snapshot.run_id == run_id)
                .order_by(Hitl2Snapshot.created_at.desc())
                .limit(_HITL2_SNAPSHOT_KEEP)
            )
        ).scalars().all()
        return list(rows)


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
    seo_plugin = request.app.state.seo_plugin

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

        try:
            result = await publish_to_wordpress(
                session=session,
                run_id=run_id,
                wp_client=wp_client,
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
    target_base = request.app.state.wp_client.base_url
    target_label = request.app.state.wp_target
    seo_plugin = request.app.state.seo_plugin

    async with sf() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
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

    meta_key = (
        "_yoast_wpseo_metadesc" if seo_plugin == "yoast"
        else ("rank_math_description" if seo_plugin == "rankmath" else None)
    )
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


async def _resolve_wp_names(
    request: Request,
    author_id: int | None,
    category_id: int | None,
) -> tuple[str | None, str | None]:
    """Best-effort resolution of WP author / category display names.

    Uses single-resource GETs (cached on app.state.wp_options_cache) so a
    blocked /wp-json/wp/v2/users list endpoint doesn't take out the page.
    Any upstream failure → None so the UI falls back to the raw ID.
    """
    from content_tool.wordpress.client import WordPressError

    cache = request.app.state.wp_options_cache
    wp = request.app.state.wp_client

    async def _author() -> str | None:
        if author_id is None:
            return None
        try:
            user = await cache.get_or_set(
                f"user:{author_id}", lambda: wp.get_user(author_id)
            )
        except WordPressError as e:
            logger.warning("WP get_user(%s) failed: %s", author_id, e)
            return None
        return user.name if user else None

    async def _category() -> str | None:
        if category_id is None:
            return None
        try:
            cat = await cache.get_or_set(
                f"category:{category_id}", lambda: wp.get_category(category_id)
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

    cats = fa.wp_categories or []
    first_cat_id = (
        cats[0]["id"]
        if cats and isinstance(cats[0], dict) and "id" in cats[0]
        else None
    )

    author_name, category_name = await _resolve_wp_names(
        request, fa.wp_author_id, first_cat_id
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

        wp = request.app.state.wp_client
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
        request, post.author, first_cat_id
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
