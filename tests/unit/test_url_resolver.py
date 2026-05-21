from datetime import UTC, datetime, timedelta

import pytest
import respx
from httpx import Response

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
    # No respx mocks — should hit cache only
    resolved = await resolver.resolve(vertex)
    assert resolved.final_url == "https://cached.gov.hk/x"
