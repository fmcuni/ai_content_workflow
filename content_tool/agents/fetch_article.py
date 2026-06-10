from typing import Any
from uuid import UUID

import httpx
from markdownify import markdownify as md
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.config import get_settings
from content_tool.db.models import FetchedArticle, Run
from content_tool.publishers.wp_factory import resolve_wp_target
from content_tool.wordpress.client import WordPressClient

# Direct live-page fetch timeout (s) used when the URL isn't a WP post.
_LIVE_FETCH_TIMEOUT = 20.0

# A browser User-Agent — Cloudflare-fronted sites (e.g. gobowtie.com/my) return
# an Error 1010 challenge to non-browser agents.
_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


async def _fetch_live_html(
    article_url: str, client: httpx.AsyncClient | None = None
) -> str:
    """Fetch the live page HTML directly. Degrade to "" on any failure (WAF
    block, timeout, non-HTML) — gap_analysis reads the URL via Gemini
    urlContext as a second source, so this must never raise."""
    own_client = client is None
    http_client = client or httpx.AsyncClient(timeout=_LIVE_FETCH_TIMEOUT)
    try:
        resp = await http_client.get(
            article_url,
            headers={
                "User-Agent": _BROWSER_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            follow_redirects=True,
        )
        if resp.status_code != 200:
            return ""
        if "html" not in resp.headers.get("content-type", ""):
            return ""
        return resp.text
    except httpx.HTTPError:
        return ""
    finally:
        if own_client:
            await http_client.aclose()


async def fetch_article(
    *,
    session: AsyncSession,
    run_id: UUID,
    article_url: str,
    client: httpx.AsyncClient | None = None,
    wp_client: WordPressClient | None = None,
) -> dict[str, Any]:
    # Short-circuit if this run already has a fetched-article row.
    # Lets the pipeline recover from partial failures and supports seeding
    # the article out-of-band (e.g. when the live URL is behind a WAF).
    existing = (
        await session.execute(
            select(FetchedArticle).where(FetchedArticle.run_id == run_id)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return {
            "wp_post_id": existing.wp_post_id,
            "wp_categories": existing.wp_categories or [],
            "raw_html": existing.raw_html or "",
            "markdown": existing.markdown,
        }

    # Build WordPressClient from settings if not provided. Resolve the voice's
    # OWN CMS (via the run's persona) so a refresh looks up the existing post on
    # the right WordPress. Otherwise a non-default voice (e.g. VHIS101) never
    # finds its post → wp_post_id stays NULL → publish mints a NEW post instead
    # of updating the article being refreshed. Mirrors the publish target.
    if wp_client is None:
        settings = get_settings()
        default_client = WordPressClient(
            settings.wp_base_url,
            username=settings.wp_username,
            app_password=settings.wp_app_password,
            timeout=settings.wp_timeout,
        )
        persona_slug = (
            await session.execute(
                select(Run.persona).where(Run.run_id == run_id)
            )
        ).scalar_one_or_none()
        resolved = await resolve_wp_target(
            session=session,
            persona_slug=persona_slug,
            default_client=default_client,
            default_label=settings.wp_target,
            timeout=settings.wp_timeout,
        )
        wp_client = resolved.client or default_client

    # Fetch post via slug. A transient/transport error is treated like
    # "not found" so a CMS hiccup never hard-blocks the run.
    try:
        post = await wp_client.fetch_post_by_url(article_url)
    except Exception:
        post = None

    # External source: the URL isn't a post on the configured WordPress (e.g. it
    # lives on a different site such as gobowtie.com/my). Don't block the run —
    # fetch the live page directly and persist a row with wp_post_id = NULL (no
    # existing CMS post to update; publish, if later approved, mints a new draft).
    if post is None:
        live_html = await _fetch_live_html(article_url, client=client)
        live_md = md(live_html, heading_style="ATX") if live_html else ""
        session.add(
            FetchedArticle(
                run_id=run_id,
                wp_post_id=None,
                wp_categories=[],
                wp_author_id=None,
                wp_slug=None,
                wp_link=article_url,
                raw_html=live_html,
                markdown=live_md,
            )
        )
        await session.commit()
        return {
            "wp_post_id": None,
            "wp_categories": [],
            "raw_html": live_html,
            "markdown": live_md,
        }

    # Fetch full category objects (id/name/slug) to preserve existing behaviour
    cat_ids = post.categories
    cats: list[dict[str, Any]] = []
    if cat_ids:
        # Hydrate categories from the SAME WordPress the post came from (the
        # voice's resolved target) — not the default base. Otherwise a
        # non-default voice (e.g. VHIS101) gets its category names from the
        # wrong CMS. Mirrors hydrateCategories in the TS backend.
        own_client = client is None
        http_client = client or httpx.AsyncClient(timeout=15.0)
        try:
            cat_resp = await http_client.get(
                f"{wp_client.base_url}/wp-json/wp/v2/categories",
                params={"include": ",".join(map(str, cat_ids)), "_fields": "id,name,slug"},
            )
            cat_resp.raise_for_status()
            cats = cat_resp.json()
        finally:
            if own_client:
                await http_client.aclose()

    html = post.content_html
    markdown = md(html, heading_style="ATX")

    session.add(
        FetchedArticle(
            run_id=run_id,
            wp_post_id=post.id,
            wp_categories=cats,
            wp_author_id=post.author,
            wp_slug=post.slug,
            wp_link=post.link,
            raw_html=html,
            markdown=markdown,
        )
    )
    await session.commit()

    return {
        "wp_post_id": post.id,
        "wp_categories": cats,
        "raw_html": html,
        "markdown": markdown,
    }
