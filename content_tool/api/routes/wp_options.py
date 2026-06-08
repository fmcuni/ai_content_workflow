"""Read-only endpoints for WP users / categories.

Backed by the content_tool.wp_users / content_tool.wp_categories tables,
which are refreshed by `scripts/sync_wp_taxonomy.py`. We do *not* call
WordPress directly here — the upstream list endpoints are CloudFront/WAF
gated and would fail intermittently.

The cache is per publish target: each row carries an ``auth_ref`` (the
publish_targets env-prefix). A request scopes to one CMS instance via
``?run_id=`` — the run's voice resolves to a target's ``auth_ref`` — so the
HITL_2 author/category pickers show that instance's entities. No run_id, no
voice, or an unassigned voice → the legacy Bowtie default ('WP').

Optional ?q=foo filters by case-insensitive substring match on name OR
exact match on id (so reviewers can search by either).
"""

import logging

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import or_, select

from content_tool.db.models import Run, WpCategoryCache, WpUserCache
from content_tool.db.persona_model import Persona
from content_tool.db.publish_target_model import PublishTarget

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/wp-options", tags=["wp-options"])

# Env-prefix of the legacy Bowtie target; the cache's default rows + any
# unresolved request fall back here.
DEFAULT_AUTH_REF = "WP"


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


def _id_or_name_filter(model, q: str):  # noqa: ANN001, ANN202
    """Return a SQLAlchemy clause matching id==int(q) OR name ILIKE %q%."""
    clauses = [model.name.ilike(f"%{q}%")]
    if q.isdigit():
        clauses.append(model.id == int(q))
    return or_(*clauses)


async def _auth_ref_for_run(session, run_id: str | None) -> str:  # noqa: ANN001
    """Resolve which CMS instance's cached taxonomy a run should read.

    Returns the publish-target ``auth_ref`` of the run's voice, or 'WP' when
    there's no run_id, the run/voice is unknown, or the voice has no target.
    An archived target still resolves to its ``auth_ref`` — the picker just
    reads that instance's snapshot.
    """
    if not run_id:
        return DEFAULT_AUTH_REF
    run = (
        await session.execute(select(Run).where(Run.run_id == run_id))
    ).scalar_one_or_none()
    if run is None or not run.persona:
        return DEFAULT_AUTH_REF
    persona = (
        await session.execute(select(Persona).where(Persona.slug == run.persona))
    ).scalar_one_or_none()
    if persona is None or persona.publish_target_id is None:
        return DEFAULT_AUTH_REF
    target = await session.get(PublishTarget, persona.publish_target_id)
    return target.auth_ref if target is not None else DEFAULT_AUTH_REF


@router.get("/users")
async def list_users(
    q: str | None = Query(default=None, max_length=100),
    run_id: str | None = Query(default=None),
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[dict]:
    async with sf() as session:
        auth_ref = await _auth_ref_for_run(session, run_id)
        stmt = (
            select(WpUserCache)
            .where(WpUserCache.auth_ref == auth_ref)
            .order_by(WpUserCache.name)
        )
        if q:
            stmt = stmt.where(_id_or_name_filter(WpUserCache, q))
        rows = (await session.execute(stmt)).scalars().all()
    return [{"id": r.id, "name": r.name, "slug": r.slug} for r in rows]


@router.get("/categories")
async def list_categories(
    q: str | None = Query(default=None, max_length=100),
    run_id: str | None = Query(default=None),
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[dict]:
    async with sf() as session:
        auth_ref = await _auth_ref_for_run(session, run_id)
        stmt = (
            select(WpCategoryCache)
            .where(WpCategoryCache.auth_ref == auth_ref)
            .order_by(WpCategoryCache.name)
        )
        if q:
            stmt = stmt.where(_id_or_name_filter(WpCategoryCache, q))
        rows = (await session.execute(stmt)).scalars().all()
    return [{"id": r.id, "name": r.name, "slug": r.slug} for r in rows]
