"""Integration tests for refresh.scanner.scan_article."""
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import respx

from content_tool.db.models import Article
from content_tool.refresh.scanner import SCANNER_VERSION, scan_article
from content_tool.wordpress.client import WordPressClient


@pytest.mark.asyncio
@respx.mock
async def test_scan_article_ok_writes_evaluation_ok(pg_session_factory, fake_gemini):
    sf = pg_session_factory
    wp_client = WordPressClient(
        base_url="https://wp.test",
        username="u",
        app_password="p",  # noqa: S106
        timeout=5.0,
    )

    # Seed article
    async with sf() as s:
        a = Article(
            article_url="https://bowtie.com.hk/x/",
            next_scan_due_at=datetime.now(UTC) - timedelta(days=1),
            persona="bowtie-editor",
            last_persisted_at=datetime.now(UTC) - timedelta(days=10),
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        aid = a.article_id

    # Mock WP fetch returning ok html
    fixture = json.loads(
        Path("tests/fixtures/wp_responses/post_by_slug.json").read_text()  # noqa: ASYNC240
    )
    fixture[0]["content"]["rendered"] = Path(  # noqa: ASYNC240
        "tests/fixtures/html/article_ok.html"
    ).read_text()
    respx.get("https://wp.test/wp-json/wp/v2/posts").mock(
        return_value=httpx.Response(200, json=fixture)
    )
    respx.head("https://bowtie.com.hk/about/").mock(
        return_value=httpx.Response(200)
    )
    respx.head("https://www.ia.org.hk/").mock(return_value=httpx.Response(200))

    async with sf() as s:
        a = await s.get(Article, aid)
        ev, llm_used = await scan_article(
            s,
            article=a,
            wp_client=wp_client,
            gemini_client=fake_gemini,
            trigger_source="manual_per_article",
            llm_budget_remaining=20,
            tick_id=uuid4(),
        )
        await s.commit()
        await s.refresh(ev)
        assert ev.recommended_action == "ok"
        assert ev.llm_skipped_reason == "deterministic_passed"
        assert llm_used == 0
        assert ev.scanner_version == SCANNER_VERSION


@pytest.mark.asyncio
@respx.mock
async def test_scan_article_broken_links_invokes_llm(
    pg_session_factory, fake_gemini
):
    sf = pg_session_factory
    wp_client = WordPressClient(
        base_url="https://wp.test",
        username="u",
        app_password="p",  # noqa: S106
        timeout=5.0,
    )

    async with sf() as s:
        a = Article(
            article_url="https://bowtie.com.hk/y/",
            next_scan_due_at=datetime.now(UTC) - timedelta(days=1),
            persona="bowtie-editor",
            last_persisted_at=datetime.now(UTC) - timedelta(days=200),
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        aid = a.article_id

    fixture = json.loads(
        Path("tests/fixtures/wp_responses/post_by_slug.json").read_text()  # noqa: ASYNC240
    )
    fixture[0]["content"]["rendered"] = Path(  # noqa: ASYNC240
        "tests/fixtures/html/article_broken_links.html"
    ).read_text()
    respx.get("https://wp.test/wp-json/wp/v2/posts").mock(
        return_value=httpx.Response(200, json=fixture)
    )
    for url in [
        "https://broken.example.invalid/page",
        "https://another-broken.invalid",
        "https://yet-another.invalid",
    ]:
        respx.head(url).mock(return_value=httpx.Response(404))
        respx.get(url).mock(return_value=httpx.Response(404))

    # Configure fake gemini to return a passing audit (no high/medium findings)
    fake_gemini.set_audit_response({"findings": [], "overall_pass": True})

    async with sf() as s:
        a = await s.get(Article, aid)
        ev, llm_used = await scan_article(
            s,
            article=a,
            wp_client=wp_client,
            gemini_client=fake_gemini,
            trigger_source="cron",
            llm_budget_remaining=20,
            tick_id=uuid4(),
        )
        await s.commit()
        await s.refresh(ev)
        assert ev.llm_findings is not None
        assert llm_used == 1
        # 3 broken links (severity medium) → det failed → LLM ran → no high
        # severity → action depends on age + det weights
        assert ev.recommended_action in ("monitor", "refresh")
