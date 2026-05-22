import re
from typing import Any
from uuid import UUID

import httpx
from markdownify import markdownify as md
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import FetchedArticle

_WP_BASE_DEFAULT = "https://www.bowtie.com.hk/blog/wp-json/wp/v2"
_SHORTLINK_RE = re.compile(r"[?&]p=(\d+)")


async def fetch_article(
    *,
    session: AsyncSession,
    run_id: UUID,
    article_url: str,
    wp_base: str = _WP_BASE_DEFAULT,
    client: httpx.AsyncClient | None = None,
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

    own_client = client is None
    client = client or httpx.AsyncClient(timeout=15.0, follow_redirects=True)
    try:
        # Resolve to post id
        resolve = await client.get(article_url)
        link_header = resolve.headers.get("Link") or resolve.headers.get("link") or ""
        m = _SHORTLINK_RE.search(link_header)
        if not m:
            raise RuntimeError(f"Cannot resolve post id from {article_url}")
        post_id = int(m.group(1))

        # Fetch post
        post_resp = await client.get(
            f"{wp_base}/posts/{post_id}",
            params={"_fields": "id,slug,categories,link,title,status,author,modified_gmt,content"},
        )
        post_resp.raise_for_status()
        post = post_resp.json()

        # Fetch categories
        cat_ids = post.get("categories", [])
        cats: list[dict[str, Any]] = []
        if cat_ids:
            cat_resp = await client.get(
                f"{wp_base}/categories",
                params={"include": ",".join(map(str, cat_ids)), "_fields": "id,name,slug"},
            )
            cat_resp.raise_for_status()
            cats = cat_resp.json()

        html = post["content"]["rendered"]
        markdown = md(html, heading_style="ATX")

        session.add(
            FetchedArticle(
                run_id=run_id,
                wp_post_id=post_id,
                wp_categories=cats,
                raw_html=html,
                markdown=markdown,
            )
        )
        await session.commit()

        return {
            "wp_post_id": post_id,
            "wp_categories": cats,
            "raw_html": html,
            "markdown": markdown,
        }
    finally:
        if own_client:
            await client.aclose()
