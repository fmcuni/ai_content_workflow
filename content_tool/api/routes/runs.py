import logging
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from content_tool.api.schemas import (
    CreateRunRequest,
    CreateRunResponse,
    DryPublishRequest,
    DryPublishResponse,
    ExistingPostOut,
    Hitl2Request,
    ResumeRequest,
)
from content_tool.api.sse import sse_stream
from content_tool.db.models import (
    AuditRun,
    Draft,
    FetchedArticle,
    GapAnalysisRow,
    OutlineRow,
    RefreshEvaluation,
    Render,
    Run,
)
from content_tool.refresh.inventory import upsert_article

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

        await session.execute(
            update(Run).where(Run.run_id == run_id).values(
                hitl_2_decision=payload.decision,
                hitl_2_notes=payload.notes,
                hitl_2_comments=comments_json,
                hitl_2_iteration=new_iteration,
                approved_at=datetime.now(UTC) if payload.decision == "approve" else None,
                approved_by="placeholder-editor",  # Plan 4 binds real identity
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
        return {"payload": row.payload, "edited_by_human": row.edited_by_human}


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
            "excerpt_suggestion": render.excerpt_suggestion,
            "slug_suggestion": render.slug_suggestion,
        }


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
    meta = {meta_key: meta_desc} if meta_key else {}

    body: dict = {
        "title": title,
        "content": content,
        "status": status,
        "categories": categories,
        "tags": tags,
        "meta": meta,
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
