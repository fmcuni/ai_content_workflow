import json
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Article, Draft, FetchedArticle, Render, Run
from content_tool.wordpress.client import (
    SCHEMA_JSONLD_META_KEY,
    WP_DEFAULT_PAGE_TEMPLATE,
    PublishPayload,
    WordPressClient,
    WordPressConflictError,
    WordPressError,
)
from content_tool.wordpress.seo_plugin import SeoPlugin, seo_meta_key


async def publish_to_wordpress(
    *,
    session: AsyncSession,
    run_id: UUID,
    wp_client: WordPressClient,
    seo_plugin: SeoPlugin | None,
    if_unmodified_since: str | None,
) -> dict[str, object]:
    run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
    # Create-mode runs (Task 4) have no FetchedArticle row (we never fetched
    # an upstream post). Refresh mode behaviour is unchanged — it still
    # requires a fetched article.
    is_create_mode = run.start_mode == "create"
    if is_create_mode:
        fa = None
    else:
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
    key = seo_meta_key(seo_plugin)
    if key:
        meta[key] = render.meta_description
    # Ship the structured-data graph out-of-band. The companion mu-plugin reads
    # this meta and merges it into the page <head> graph (Yoast/RankMath schema
    # filter), so we never inline a raw <script> into the post body.
    if render.schema_jsonld:
        meta[SCHEMA_JSONLD_META_KEY] = json.dumps(render.schema_jsonld, ensure_ascii=False)

    date_gmt: str | None = None
    if run.wp_publish_at is not None:
        date_gmt = run.wp_publish_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")

    if is_create_mode:
        # Brand-new post on first publish (no post_id). On a post-hoc re-push the
        # run already minted a post, so reuse its id to UPDATE that post instead
        # of creating a duplicate.
        post_id: int | None = run.wp_pushed_post_id
    else:
        post_id = fa.wp_post_id if fa is not None else None
    # Honor the operator's status choice for both create and refresh runs
    # (defaulting to draft) so a "publish" selection is never silently demoted.
    status = run.wp_publish_status or "draft"

    payload = PublishPayload(
        post_id=post_id,
        title=render.seo_title,
        content=render.html_body,
        excerpt=run.wp_excerpt or render.excerpt_suggestion,
        status=status,
        slug=run.wp_slug,
        categories=run.wp_category_ids or [],
        tags=run.wp_tag_ids or [],
        author=run.wp_author_id,
        featured_media=run.wp_featured_media_id,
        meta=meta,
        if_unmodified_since=if_unmodified_since,
        date_gmt=date_gmt,
        # Force the theme default page template on both create and refresh/update
        # so published articles never inherit a stale post template.
        template=WP_DEFAULT_PAGE_TEMPLATE,
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
    except WordPressError as e:
        # WP returned a non-2xx that wasn't a 412 conflict (e.g. 401 auth,
        # 403 forbidden, 404 invalid post id, 5xx). Persist it so the run
        # row carries the failure signal even when no SSE subscriber is
        # listening.
        await session.execute(update(Run).where(Run.run_id == run_id).values(
            status="failed",
            wp_push_error={"code": "wp_error", "message": str(e)},
        ))
        await session.commit()
        raise
    except Exception as e:  # also catches transport-level errors
        await session.execute(update(Run).where(Run.run_id == run_id).values(
            status="failed",
            wp_push_error={
                "code": "transport_error",
                "type": type(e).__name__,
                "message": str(e),
            },
        ))
        await session.commit()
        raise

    update_values: dict[str, object] = {
        "wp_pushed_post_id": result.id,
        "wp_pushed_at": datetime.now(UTC),
        "status": "published",
    }
    # Create-mode: WP just minted a brand-new draft post. Backfill the URL
    # onto the run row so downstream UI ("View in WP") and ops have a link.
    if is_create_mode:
        update_values["article_url"] = result.link
    await session.execute(update(Run).where(Run.run_id == run_id).values(**update_values))

    # Refresh mode re-publishes an existing inventory article: stamp its
    # last_persisted_at so the refresh scanner's staleness reference
    # (scanner.py: `article.last_persisted_at or first_seen_at`) tracks the
    # republish instead of drifting off first_seen_at forever. No-op if the URL
    # isn't in the inventory. (Create mode has no inventory Article row yet.)
    if not is_create_mode and run.article_url:
        await session.execute(
            update(Article)
            .where(Article.article_url == run.article_url)
            .values(last_persisted_at=datetime.now(UTC))
        )

    await session.commit()
    return {"id": result.id, "link": result.link, "status": result.status}
