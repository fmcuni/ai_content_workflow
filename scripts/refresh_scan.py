#!/usr/bin/env python
"""CLI entrypoint: run a refresh scan tick.

Invocation:
    uv run python -m scripts.refresh_scan
Or via cron, with env vars set in the cron environment.

Exits 0 on success (including when nothing was due to scan), non-zero only on
unrecoverable errors. Per-article errors are logged and result in evaluation
rows with the error captured; they do NOT fail the tick.
"""
from __future__ import annotations

import asyncio
import os
import sys

import click

from content_tool import prompts_store
from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.gemini.client import RealGeminiClient
from content_tool.observability.logging import configure_logging
from content_tool.observability.tracing import configure_tracing
from content_tool.refresh.scanner import scan_tick
from content_tool.wordpress.client import WordPressClient


@click.command()
@click.option(
    "--article-id", "article_ids", multiple=True,
    help="Limit to these articles (repeatable).",
)
@click.option(
    "--force", is_flag=True,
    help="Bypass next_scan_due_at gate (still honors dismissed_until + in-progress).",
)
@click.option("--dry-run", is_flag=True, help="Print what would be scanned; no DB writes.")
def main(article_ids: tuple[str, ...], force: bool, dry_run: bool) -> None:
    """Run a single refresh tick."""
    if os.getenv("REFRESH_CRON_ENABLED", "true").lower() != "true":
        click.echo("REFRESH_CRON_ENABLED=false; exiting 0 without scanning.")
        sys.exit(0)

    configure_logging(os.getenv("LOG_LEVEL", "info"))
    configure_tracing()

    asyncio.run(_run(article_ids=article_ids, force=force, dry_run=dry_run))


async def _run(*, article_ids: tuple[str, ...], force: bool, dry_run: bool) -> None:
    settings = get_settings()
    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    prompts_store.configure(sf)
    try:
        wp_client = WordPressClient(
            settings.wp_base_url,
            username=settings.wp_username,
            app_password=settings.wp_app_password,
            timeout=settings.wp_timeout,
        )
        gemini = RealGeminiClient(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            thinking_level=settings.gemini_thinking_level,
        )
        from uuid import UUID
        forced = [UUID(s) for s in article_ids] if article_ids else None

        if dry_run:
            from sqlalchemy import select

            from content_tool.db.models import Article
            from content_tool.refresh.scanner import select_due_articles
            async with sf() as s:
                if forced:
                    stmt = select(Article).where(Article.article_id.in_(forced))
                    rows = (await s.execute(stmt)).scalars().all()
                else:
                    rows = await select_due_articles(s, batch_size=200)
                click.echo(f"Would scan {len(rows)} article(s):")
                for r in rows:
                    click.echo(f"  - {r.article_id} {r.article_url}")
            return

        result = await scan_tick(
            sf, wp_client=wp_client, gemini_client=gemini,
            trigger_source="cron",
            forced_article_ids=forced, force_bypass_due=force,
        )
        click.echo(
            f"tick {result.tick_id}: scanned={result.scanned} "
            f"evals={result.evaluations_created} llm={result.llm_calls} "
            f"skipped={len(result.skipped or [])}"
        )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    main()
