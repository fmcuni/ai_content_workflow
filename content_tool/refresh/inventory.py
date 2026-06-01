"""Article-table maintenance: upsert by URL, schedule advancement math."""
from datetime import UTC, datetime, timedelta

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.config import get_refresh_config
from content_tool.db.models import Article


async def upsert_article(
    session: AsyncSession,
    *,
    article_url: str,
    topic: str | None = None,
    persona: str | None = None,
    topic_category: str | None = None,
    wp_post_id: int | None = None,
    last_persisted_at: datetime | None = None,
) -> Article:
    """Insert-or-update by article_url. Sets next_scan_due_at on first insert only."""
    cfg = get_refresh_config()["scheduling"]
    default_due = (last_persisted_at or datetime.now(UTC)) + timedelta(
        days=cfg["default_interval_days"]
    )

    stmt = pg_insert(Article).values(
        article_url=article_url,
        topic=topic,
        persona=persona,
        topic_category=topic_category,
        wp_post_id=wp_post_id,
        last_persisted_at=last_persisted_at,
        next_scan_due_at=default_due,
    ).on_conflict_do_update(
        index_elements=["article_url"],
        set_={
            "topic": pg_insert(Article).excluded.topic,
            "persona": pg_insert(Article).excluded.persona,
            "topic_category": pg_insert(Article).excluded.topic_category,
            "wp_post_id": pg_insert(Article).excluded.wp_post_id,
            # COALESCE so a real incoming timestamp updates the staleness anchor,
            # but the common last_persisted_at=None call never wipes an existing
            # stamp (the publish path is what writes a real value — see publish.py).
            "last_persisted_at": func.coalesce(
                pg_insert(Article).excluded.last_persisted_at,
                Article.last_persisted_at,
            ),
            "updated_at": datetime.now(UTC),
        },
    ).returning(Article)

    row = (await session.execute(stmt)).scalar_one()
    return row


def advance_schedule(
    *,
    action: str,
    now: datetime | None = None,
) -> datetime | None:
    """Return new next_scan_due_at. None means caller should leave it untouched."""
    cfg = get_refresh_config()["scheduling"]
    now = now or datetime.now(UTC)
    if action == "refresh":
        return None
    if action == "monitor":
        return now + timedelta(days=cfg["monitor_interval_days"])
    if action == "ok":
        return now + timedelta(days=cfg["ok_interval_days"])
    raise ValueError(f"unknown action: {action!r}")


def schedule_after_retry(now: datetime | None = None) -> datetime:
    cfg = get_refresh_config()["scheduling"]
    now = now or datetime.now(UTC)
    return now + timedelta(days=cfg["retry_interval_days"])


def schedule_after_dismiss(dismissed_until: datetime) -> datetime:
    """Per spec §5.1: set next_scan_due_at = dismissed_until so the row becomes due
    the moment dismissal expires."""
    return dismissed_until
