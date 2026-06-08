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
import os
import sys
from datetime import UTC, datetime

import click
from dotenv import dotenv_values
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from content_tool.config import get_settings
from content_tool.db.connection import make_engine, make_session_factory
from content_tool.db.models import WpCategoryCache, WpUserCache
from content_tool.db.publish_target_model import PublishTarget
from content_tool.observability.logging import configure_logging
from content_tool.publishers.wp_factory import build_target_client
from content_tool.wordpress.client import WordPressClient, WordPressError

logger = logging.getLogger(__name__)

# Env-prefix of the legacy Bowtie target. A NULL/unassigned voice resolves here,
# and existing cache rows backfill to it (see the per-target migration).
DEFAULT_AUTH_REF = "WP"


def _build_env(env_file: str) -> dict[str, str]:
    """Process env overlaid on the settings dotenv file.

    Per-target credentials (``{auth_ref}_BASE_URL`` / ``_USERNAME`` /
    ``_APP_PASSWORD``) are read here by ``build_target_client``. They never reach
    ``os.environ`` on their own because the Settings model uses ``extra="ignore"``,
    so we merge the dotenv file (lower precedence) under the real process env.
    """
    file_vals = {k: v for k, v in dotenv_values(env_file).items() if v is not None}
    return {**file_vals, **os.environ}


async def _sync() -> int:
    """Refresh the user/category cache once per active WordPress publish target.

    Each target is keyed by its ``auth_ref`` (the env-prefix its creds live
    under). One upstream WP failure (e.g. WAF blocking the outbound IP) is logged
    and skipped so the other targets still refresh; the exit code reflects it.
    """
    settings = get_settings()
    env_file = str(settings.model_config.get("env_file", ".env.local") or ".env.local")
    env = _build_env(env_file)
    # The legacy Bowtie target ('WP') must resolve even when WP_* are absent from
    # the dotenv file / process env — fall back to the Settings defaults.
    env.setdefault("WP_BASE_URL", settings.wp_base_url)
    env.setdefault("WP_USERNAME", settings.wp_username)
    env.setdefault("WP_APP_PASSWORD", settings.wp_app_password)

    engine = make_engine(settings.postgres_url)
    sf = make_session_factory(engine)
    now = datetime.now(tz=UTC)
    rc = 0

    try:
        async with sf() as session:
            targets = (
                await session.execute(
                    select(PublishTarget).where(PublishTarget.is_archived.is_(False))
                )
            ).scalars().all()

            # (auth_ref, client) pairs to refresh. One client per active WordPress
            # target; a build failure (missing creds / archived) is logged + skipped.
            specs: list[tuple[str, WordPressClient]] = []
            seen: set[str] = set()
            for t in targets:
                if t.kind != "wordpress":
                    continue
                try:
                    resolved = build_target_client(t, timeout=settings.wp_timeout, env=env)
                except (ValueError, OSError) as e:
                    logger.error(
                        "Target %r (auth_ref=%s): cannot build client: %s",
                        t.name,
                        t.auth_ref,
                        e,
                    )
                    rc = 2
                    continue
                assert resolved.client is not None
                specs.append((t.auth_ref, resolved.client))
                seen.add(t.auth_ref)

            # Unseeded DB (no 'WP' target row): fall back to the legacy WP_* env so
            # the Bowtie cache still refreshes — preserves the pre-Phase-1.5 behaviour.
            if DEFAULT_AUTH_REF not in seen and settings.wp_base_url:
                specs.append(
                    (
                        DEFAULT_AUTH_REF,
                        WordPressClient(
                            settings.wp_base_url,
                            username=settings.wp_username,
                            app_password=settings.wp_app_password,
                            timeout=settings.wp_timeout,
                        ),
                    )
                )

            if not specs:
                logger.error("No active WordPress targets and no WP_BASE_URL — nothing to sync")
                return 1

            for auth_ref, client in specs:
                try:
                    users = await client.list_users()
                    cats = await client.list_categories()
                except WordPressError as e:
                    logger.error("WordPress upstream failed for target %s: %s", auth_ref, e)
                    logger.error(
                        "This usually means CloudFront/WAF is challenging the backend's "
                        "outbound IP. Get the backend allowlisted on the WP side."
                    )
                    rc = 2
                    continue

                logger.info(
                    "Target %s: fetched %d users, %d categories", auth_ref, len(users), len(cats)
                )

                # Per-target hard refresh: clear just this auth_ref's rows, re-insert.
                await session.execute(
                    delete(WpUserCache).where(WpUserCache.auth_ref == auth_ref)
                )
                if users:
                    await session.execute(
                        insert(WpUserCache).values(
                            [
                                {
                                    "auth_ref": auth_ref,
                                    "id": u.id,
                                    "name": u.name,
                                    "slug": u.slug,
                                    "synced_at": now,
                                }
                                for u in users
                            ]
                        )
                    )
                await session.execute(
                    delete(WpCategoryCache).where(WpCategoryCache.auth_ref == auth_ref)
                )
                if cats:
                    await session.execute(
                        insert(WpCategoryCache).values(
                            [
                                {
                                    "auth_ref": auth_ref,
                                    "id": c.id,
                                    "name": c.name,
                                    "slug": c.slug,
                                    "synced_at": now,
                                }
                                for c in cats
                            ]
                        )
                    )
            await session.commit()
            logger.info("Sync complete (rc=%d) — %d target(s) processed", rc, len(specs))
    finally:
        await engine.dispose()

    return rc


@click.command()
def main() -> None:
    """Refresh the WP users / categories cache."""
    configure_logging()
    rc = asyncio.run(_sync())
    sys.exit(rc)


if __name__ == "__main__":
    main()
