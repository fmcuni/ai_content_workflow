"""Read-only endpoints for WP users / categories.

Backed by the content_tool.wp_users / content_tool.wp_categories tables,
which are refreshed by `scripts/sync_wp_taxonomy.py`. We do *not* call
WordPress directly here — the upstream list endpoints are CloudFront/WAF
gated and would fail intermittently.

Optional ?q=foo filters by case-insensitive substring match on name OR
exact match on id (so reviewers can search by either).
"""

import logging

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import or_, select

from content_tool.db.models import WpCategoryCache, WpUserCache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/wp-options", tags=["wp-options"])


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


def _id_or_name_filter(model, q: str):  # noqa: ANN001, ANN202
    """Return a SQLAlchemy clause matching id==int(q) OR name ILIKE %q%."""
    clauses = [model.name.ilike(f"%{q}%")]
    if q.isdigit():
        clauses.append(model.id == int(q))
    return or_(*clauses)


@router.get("/users")
async def list_users(
    q: str | None = Query(default=None, max_length=100),
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[dict]:
    stmt = select(WpUserCache).order_by(WpUserCache.name)
    if q:
        stmt = stmt.where(_id_or_name_filter(WpUserCache, q))
    async with sf() as session:
        rows = (await session.execute(stmt)).scalars().all()
    return [{"id": r.id, "name": r.name, "slug": r.slug} for r in rows]


@router.get("/categories")
async def list_categories(
    q: str | None = Query(default=None, max_length=100),
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[dict]:
    stmt = select(WpCategoryCache).order_by(WpCategoryCache.name)
    if q:
        stmt = stmt.where(_id_or_name_filter(WpCategoryCache, q))
    async with sf() as session:
        rows = (await session.execute(stmt)).scalars().all()
    return [{"id": r.id, "name": r.name, "slug": r.slug} for r in rows]
