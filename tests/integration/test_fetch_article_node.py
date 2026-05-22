from datetime import date
from uuid import uuid4

import pytest
import respx
from httpx import Response
from sqlalchemy import select

from content_tool.agents.fetch_article import fetch_article
from content_tool.db.models import FetchedArticle, Run
from content_tool.wordpress.client import WordPressClient

_WP_BASE = "https://www.bowtie.com.hk/blog"


@pytest.mark.asyncio
async def test_fetch_article_resolves_via_slug_and_writes(db_session):
    run_id = uuid4()
    db_session.add(
        Run(
            run_id=run_id,
            created_by="x",
            status="fetching",
            article_url="https://www.bowtie.com.hk/blog/zh/cancer-screening/",
            topic="x",
            keywords=["x"],
            mode="auto",
            acf_adv_id=1,
            acf_widget_id=2,
            persona="bowtie-editor",
            today_date=date(2026, 5, 21),
        )
    )
    await db_session.commit()

    wp_client = WordPressClient(
        _WP_BASE,
        username="user",
        app_password="pass",
    )

    with respx.mock(assert_all_called=True) as router:
        # 1. Slug-based WP post fetch (new flow — no shortlink resolution)
        router.get(f"{_WP_BASE}/wp-json/wp/v2/posts").mock(
            return_value=Response(
                200,
                json=[
                    {
                        "id": 98785,
                        "slug": "cancer-screening",
                        "categories": [42, 7],
                        "link": "https://www.bowtie.com.hk/blog/zh/cancer-screening/",
                        "title": {"rendered": "大腸癌篩查指南"},
                        "status": "publish",
                        "author": 5,
                        "modified_gmt": "2026-04-12T08:30:00",
                        "content": {"rendered": "<h2>什麼是大腸癌？</h2><p>大腸癌是...</p>"},  # noqa: RUF001
                    }
                ],
            )
        )
        # 2. Categories — same endpoint as before
        router.get(f"{_WP_BASE}/wp-json/wp/v2/categories").mock(
            return_value=Response(
                200,
                json=[
                    {"id": 42, "name": "癌症", "slug": "cancer"},
                    {"id": 7, "name": "醫療保險", "slug": "medical-insurance"},
                ],
            )
        )

        result = await fetch_article(
            session=db_session,
            run_id=run_id,
            article_url="https://www.bowtie.com.hk/blog/zh/cancer-screening/",
            wp_base=f"{_WP_BASE}/wp-json/wp/v2",
            wp_client=wp_client,
        )

    assert result["wp_post_id"] == 98785
    assert "大腸癌" in result["markdown"]

    row = (
        await db_session.execute(select(FetchedArticle).where(FetchedArticle.run_id == run_id))
    ).scalar_one()
    assert row.wp_post_id == 98785
    assert row.markdown is not None
    assert any(c["slug"] == "cancer" for c in row.wp_categories)
