from datetime import UTC, datetime, timedelta

import pytest
import respx
from httpx import Response
from sqlalchemy import select

from content_tool.agents.url_resolver import UrlResolver
from content_tool.db.models import UrlResolutionCache


@pytest.mark.asyncio
async def test_resolves_vertex_redirect(db_session):
    vertex = "https://vertexaisearch.cloud.google.com/abc123"
    final = "https://www.ia.org.hk/tc/about-us/role.html"

    resolver = UrlResolver(session=db_session, timeout=5.0)

    with respx.mock(assert_all_called=True) as router:
        router.head(vertex).mock(return_value=Response(302, headers={"Location": final}))
        router.head(final).mock(return_value=Response(200))
        resolved = await resolver.resolve(vertex)

    assert resolved.final_url == final
    assert resolved.domain == "ia.org.hk"


@pytest.mark.asyncio
async def test_uses_cache_on_second_call(db_session):
    vertex = "https://vertexaisearch.cloud.google.com/cached"
    db_session.add(UrlResolutionCache(
        vertex_uri=vertex, final_url="https://cached.gov.hk/x", domain="cached.gov.hk",
        expires_at=datetime.now(UTC) + timedelta(days=7),
    ))
    await db_session.commit()

    resolver = UrlResolver(session=db_session, timeout=5.0)
    with respx.mock(assert_all_called=False) as router:
        resolved = await resolver.resolve(vertex)
        assert router.calls.call_count == 0

    assert resolved.final_url == "https://cached.gov.hk/x"


@pytest.mark.asyncio
async def test_resolve_does_not_commit_callers_session(db_session):
    """resolve() must NOT commit the caller's session — it only flushes the cache
    upsert, leaving the commit boundary to the caller (resolve_citations commits
    once after the whole grounding loop). A premature commit here would persist
    earlier iterations' Citation rows. Proof: a row staged before resolve() and
    the resolver's own write both vanish after a rollback."""
    sentinel = "https://vertexaisearch.cloud.google.com/sentinel"
    target = "https://vertexaisearch.cloud.google.com/target"

    # Stage an uncommitted row alongside what the resolver will write.
    db_session.add(UrlResolutionCache(
        vertex_uri=sentinel, final_url="https://x.gov.hk", domain="x.gov.hk",
        expires_at=datetime.now(UTC) + timedelta(days=7),
    ))

    resolver = UrlResolver(session=db_session, timeout=5.0)
    with respx.mock(assert_all_called=True) as router:
        router.head(target).mock(return_value=Response(200))
        await resolver.resolve(target)  # cache miss → flushes, must NOT commit

    await db_session.rollback()

    rows = (await db_session.execute(
        select(UrlResolutionCache).where(
            UrlResolutionCache.vertex_uri.in_([sentinel, target])
        )
    )).scalars().all()
    # If resolve() had committed, these would survive the rollback.
    assert rows == []
