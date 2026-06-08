"""Read-only listing of CMS publish targets (Phase 1).

Powers the publish-target dropdown in the voice editor. Targets are seeded via
migration; self-service create/edit is a Phase 2 follow-up. Only non-secret
config is exposed — credentials live in the environment under ``auth_ref``.
"""

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.api.schemas import PublishTargetOut
from content_tool.db.models import PublishTarget

router = APIRouter(prefix="/publish-targets", tags=["publish-targets"])


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


@router.get("", response_model=list[PublishTargetOut])
async def list_(
    include_archived: bool = Query(False),
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> list[PublishTargetOut]:
    async with sf() as session:
        q = select(PublishTarget).order_by(PublishTarget.created_at.asc())
        if not include_archived:
            q = q.where(PublishTarget.is_archived.is_(False))
        rows = (await session.execute(q)).scalars().all()
        return [
            PublishTargetOut(
                publish_target_id=r.publish_target_id,
                name=r.name,
                kind=r.kind,
                auth_ref=r.auth_ref,
                status=r.status,
                is_archived=r.is_archived,
            )
            for r in rows
        ]
