from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Draft, FetchedArticle, Render, Run
from content_tool.wordpress.client import PublishPayload, WordPressClient, WordPressConflictError


def _seo_meta_key(plugin: Literal["yoast", "rankmath"] | None) -> str | None:
    if plugin == "yoast":
        return "_yoast_wpseo_metadesc"
    if plugin == "rankmath":
        return "rank_math_description"
    return None


async def publish_to_wordpress(
    *,
    session: AsyncSession,
    run_id: UUID,
    wp_client: WordPressClient,
    seo_plugin: Literal["yoast", "rankmath"] | None,
    if_unmodified_since: str | None,
) -> dict:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    fa = (await session.execute(
        select(FetchedArticle).where(FetchedArticle.run_id == run_id)
    )).scalar_one()
    latest_draft = (await session.execute(
        select(Draft).where(Draft.run_id == run_id).order_by(Draft.iteration.desc()).limit(1)
    )).scalar_one()
    render = (await session.execute(
        select(Render).where(Render.draft_id == latest_draft.draft_id)
    )).scalar_one()

    meta: dict[str, str] = {}
    key = _seo_meta_key(seo_plugin)
    if key:
        meta[key] = render.meta_description

    payload = PublishPayload(
        post_id=fa.wp_post_id,
        title=render.seo_title,
        content=render.html_body,
        excerpt=run.wp_excerpt or render.excerpt_suggestion,
        status=run.wp_publish_status or "draft",
        slug=run.wp_slug,
        categories=run.wp_category_ids or [],
        tags=run.wp_tag_ids or [],
        author=run.wp_author_id,
        featured_media=run.wp_featured_media_id,
        meta=meta,
        if_unmodified_since=if_unmodified_since,
    )

    try:
        result = await wp_client.upsert(payload)
    except WordPressConflictError as e:
        await session.execute(update(Run).where(Run.run_id == run_id).values(
            status="failed",
            wp_push_error={"code": "conflict", "message": str(e)},
        ))
        await session.commit()
        raise

    await session.execute(update(Run).where(Run.run_id == run_id).values(
        wp_pushed_post_id=result.id,
        wp_pushed_at=datetime.utcnow(),
        status="published",
    ))
    await session.commit()
    return {"id": result.id, "link": result.link, "status": result.status}
