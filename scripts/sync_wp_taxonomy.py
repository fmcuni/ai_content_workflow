#!/usr/bin/env python
"""CLI entrypoint: refresh the WP users / categories cache tables.

Pulls the full user + category lists from WordPress via the REST API and
upserts them into content_tool.wp_users / content_tool.wp_categories. The
HITL-2 reviewer dropdowns read from these tables, so this script must be
run periodically (e.g. nightly cron) to keep the lists fresh.

Invocation:
    uv run python -m scripts.sync_wp_taxonomy

Exits 0 on success, 2 on WordPress upstream failure (typically AWS WAF
challenging the backend's IP), 1 on any other error.
"""
from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timezone

import click
from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert

from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import WpCategoryCache, WpUserCache
from content_tool.observability.logging import configure_logging
from content_tool.wordpress.client import WordPressClient, WordPressError

logger = logging.getLogger(__name__)


async def _sync() -> int:
    settings = get_settings()
    if not settings.wp_base_url:
        logger.error("WP_BASE_URL not set — cannot sync")
        return 1

    wp = WordPressClient(
        settings.wp_base_url,
        username=settings.wp_username,
        app_password=settings.wp_app_password,
        timeout=settings.wp_timeout,
    )

    try:
        users = await wp.list_users()
        cats = await wp.list_categories()
    except WordPressError as e:
        logger.error("WordPress upstream failed: %s", e)
        logger.error(
            "This usually means CloudFront/WAF is challenging the backend's "
            "outbound IP. Get the backend allowlisted on the WP side."
        )
        return 2

    logger.info("Fetched %d users, %d categories from WP", len(users), len(cats))

    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    now = datetime.now(tz=timezone.utc)

    try:
        async with sf() as session:
            # Hard refresh: delete + insert. The table is small (~250 rows)
            # so transactional truncate is fine and keeps a clean snapshot.
            await session.execute(delete(WpUserCache))
            if users:
                await session.execute(
                    insert(WpUserCache).values(
                        [
                            {"id": u.id, "name": u.name, "slug": u.slug, "synced_at": now}
                            for u in users
                        ]
                    )
                )
            await session.execute(delete(WpCategoryCache))
            if cats:
                await session.execute(
                    insert(WpCategoryCache).values(
                        [
                            {"id": c.id, "name": c.name, "slug": c.slug, "synced_at": now}
                            for c in cats
                        ]
                    )
                )
            await session.commit()
    finally:
        await engine.dispose()

    logger.info("Sync complete — %d users + %d categories written", len(users), len(cats))
    return 0


@click.command()
def main() -> None:
    """Refresh the WP users / categories cache."""
    configure_logging()
    rc = asyncio.run(_sync())
    sys.exit(rc)


if __name__ == "__main__":
    main()
