from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import tldextract
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import UrlResolutionCache


@dataclass
class ResolvedUrl:
    vertex_uri: str
    final_url: str | None
    domain: str | None
    error: str | None = None


class UrlResolver:
    def __init__(self, session: AsyncSession, timeout: float = 5.0,
                 ttl_days: int = 7, client: httpx.AsyncClient | None = None) -> None:
        self._session = session
        self._timeout = timeout
        self._ttl = timedelta(days=ttl_days)
        self._client = client

    async def resolve(self, vertex_uri: str) -> ResolvedUrl:
        # Cache lookup
        row = (await self._session.execute(
            select(UrlResolutionCache).where(UrlResolutionCache.vertex_uri == vertex_uri)
        )).scalar_one_or_none()
        if row and row.expires_at > datetime.now(UTC):
            return ResolvedUrl(vertex_uri, row.final_url, row.domain, row.error)

        own = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self._timeout, follow_redirects=True)
        try:
            try:
                resp = await client.head(vertex_uri)
                final = str(resp.url)
                ext = tldextract.extract(final)
                domain = f"{ext.domain}.{ext.suffix}".lower() if ext.suffix else None
                error = None
            except Exception as e:
                final = None
                domain = None
                error = str(e)

            # Only cache *successful* resolutions. A transient failure — a HEAD
            # timeout, a network blip, or Cloudflare's "Too many subrequests by
            # single Worker invocation" per-invocation cap — must NOT be
            # persisted: the 7-day TTL would poison the URL so every later
            # lookup returns a null domain, the existing article is dropped from
            # the candidate list, and topic-dedup wrongly answers "no". Skipping
            # the write lets the next encounter retry instead.
            if error is None:
                stmt = insert(UrlResolutionCache).values(
                    vertex_uri=vertex_uri, final_url=final, domain=domain, error=error,
                    expires_at=datetime.now(UTC) + self._ttl,
                ).on_conflict_do_update(
                    index_elements=["vertex_uri"],
                    set_={"final_url": final, "domain": domain, "error": error,
                          "resolved_at": datetime.now(UTC),
                          "expires_at": datetime.now(UTC) + self._ttl},
                )
                await self._session.execute(stmt)
                # flush (not commit): resolve() runs inside the caller's transaction
                # (resolve_citations accumulates Citation rows across the grounding
                # loop and commits once at the end). Committing here would prematurely
                # persist earlier iterations' Citations, so a later failure could leave
                # a partial, un-rollback-able write. flush makes the cache row visible
                # to subsequent lookups within this transaction while leaving the
                # commit boundary to the caller. Mirrors the Workers port, where the
                # cache upsert and citation inserts are separate statements that only
                # land together when the surrounding step succeeds.
                await self._session.flush()
            return ResolvedUrl(vertex_uri, final, domain, error)
        finally:
            if own:
                await client.aclose()
