from typing import Any
from uuid import UUID

import httpx
from markdownify import markdownify as md
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.config import get_settings
from content_tool.db.models import FetchedArticle
from content_tool.wordpress.client import WordPressClient

_WP_BASE_DEFAULT = "https://www.bowtie.com.hk/blog/wp-json/wp/v2"


async def fetch_article(
    *,
    session: AsyncSession,
    run_id: UUID,
    article_url: str,
    wp_base: str = _WP_BASE_DEFAULT,
    client: httpx.AsyncClient | None = None,
    wp_client: WordPressClient | None = None,
) -> dict[str, Any]:
    # Build WordPressClient from settings if not provided
    if wp_client is None:
        settings = get_settings()
        wp_client = WordPressClient(
            settings.wp_base_url,
            username=settings.wp_username,
            app_password=settings.wp_app_password,
            timeout=settings.wp_timeout,
        )

    # Fetch post via slug
    post = await wp_client.fetch_post_by_url(article_url)
    if post is None:
        raise ValueError(f"WP post not found for {article_url}")

    # Fetch full category objects (id/name/slug) to preserve existing behaviour
    cat_ids = post.categories
    cats: list[dict[str, Any]] = []
    if cat_ids:
        # Use wp_base for the categories endpoint (keeps backwards-compat with tests)
        own_client = client is None
        http_client = client or httpx.AsyncClient(timeout=15.0)
        try:
            cat_resp = await http_client.get(
                f"{wp_base}/categories",
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
