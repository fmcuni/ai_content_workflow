"""Integration tests for refresh.inventory.upsert_article conflict behavior."""
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from content_tool.db.models import Article
from content_tool.refresh.inventory import upsert_article


@pytest.mark.asyncio
async def test_upsert_article_preserves_last_persisted_at_on_none(db_session):
    """A re-upsert that passes last_persisted_at=None (the run-create call) must
    NOT wipe an existing real stamp — COALESCE keeps the prior value."""
    url = "https://e.com/coalesce-preserve"
    stamped = datetime(2026, 3, 1, tzinfo=UTC)
    db_session.add(Article(
        article_url=url, topic="orig", persona="bowtie-editor",
        last_persisted_at=stamped, next_scan_due_at=stamped + timedelta(days=30),
    ))
    await db_session.commit()

    # Re-upsert as the run-create path does: metadata changes, last_persisted_at omitted.
    await upsert_article(db_session, article_url=url, topic="updated", persona="bowtie-editor")
    await db_session.commit()

    row = (await db_session.execute(
        select(Article).where(Article.article_url == url)
    )).scalar_one()
    assert row.topic == "updated"  # metadata still updates
    assert row.last_persisted_at == stamped  # but the stamp survives


@pytest.mark.asyncio
async def test_upsert_article_updates_last_persisted_at_when_provided(db_session):
    """When a real last_persisted_at is supplied, it overwrites the existing one."""
    url = "https://e.com/coalesce-update"
    old = datetime(2026, 3, 1, tzinfo=UTC)
    new = datetime(2026, 6, 1, tzinfo=UTC)
    db_session.add(Article(
        article_url=url, topic="orig", persona="bowtie-editor",
        last_persisted_at=old, next_scan_due_at=old + timedelta(days=30),
    ))
    await db_session.commit()

    await upsert_article(
        db_session, article_url=url, topic="orig", persona="bowtie-editor",
        last_persisted_at=new,
    )
    await db_session.commit()

    row = (await db_session.execute(
        select(Article).where(Article.article_url == url)
    )).scalar_one()
    assert row.last_persisted_at == new
