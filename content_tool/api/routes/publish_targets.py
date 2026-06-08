"""CMS publish targets — list + self-service CRUD (Phase 2).

Powers the publish-target dropdown in the voice editor and the
``/settings/publish-targets`` admin page. Only NON-SECRET config is stored or
exposed — base URL + credentials live in the environment under the ``auth_ref``
prefix (``{auth_ref}_BASE_URL`` / ``_USERNAME`` / ``_APP_PASSWORD``) and are
resolved at publish time. The readiness endpoint reports only whether those env
vars are *present*, never their values.

Phase 2 ships WordPress only (``kind='wordpress'``); Ghost lands later behind
the same row ``kind``. Mutations are admin-gated at the Workers edge (RBAC is
Workers-authoritative); this Python backend is the local-dev / parity surface.
"""

import os
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.api.schemas import (
    PublishTargetCreate,
    PublishTargetOut,
    PublishTargetReadiness,
    PublishTargetUpdate,
    PublishTargetUsage,
)
from content_tool.db.models import Persona, PublishTarget

router = APIRouter(prefix="/publish-targets", tags=["publish-targets"])

# Phase 2 supports WordPress only; widen alongside the DB CHECK when Ghost ships.
_DEFAULT_KIND = "wordpress"


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


def _to_out(row: PublishTarget) -> PublishTargetOut:
    return PublishTargetOut(
        publish_target_id=row.publish_target_id,
        name=row.name,
        kind=row.kind,
        auth_ref=row.auth_ref,
        status=row.status,
        is_archived=row.is_archived,
    )


async def _get_or_404(session: AsyncSession, target_id: UUID) -> PublishTarget:
    row = await session.get(PublishTarget, target_id)
    if row is None:
        raise HTTPException(404, "publish target not found")
    return row


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
        return [_to_out(r) for r in rows]


@router.post("", response_model=PublishTargetOut, status_code=201)
async def create_(
    payload: PublishTargetCreate,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> PublishTargetOut:
    """Register a new WordPress target. ``auth_ref`` must be unique. The row is
    inert until its credential env vars are provisioned (see ``/readiness``)."""
    async with sf() as session:
        existing = (
            await session.execute(
                select(PublishTarget).where(PublishTarget.auth_ref == payload.auth_ref)
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(
                409, f"auth_ref '{payload.auth_ref}' is already in use"
            )
        row = PublishTarget(
            name=payload.name,
            kind=_DEFAULT_KIND,
            auth_ref=payload.auth_ref,
            status=payload.status,
            is_archived=False,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return _to_out(row)


@router.patch("/{target_id}", response_model=PublishTargetOut)
async def update_(
    target_id: UUID,
    payload: PublishTargetUpdate,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> PublishTargetOut:
    """Edit name / status only. ``auth_ref`` and ``kind`` are immutable here."""
    async with sf() as session:
        row = await _get_or_404(session, target_id)
        fields = payload.model_dump(exclude_unset=True)
        if "name" in fields and fields["name"] is not None:
            row.name = fields["name"]
        if "status" in fields and fields["status"] is not None:
            row.status = fields["status"]
        await session.commit()
        await session.refresh(row)
        return _to_out(row)


@router.post("/{target_id}/archive", response_model=PublishTargetOut)
async def archive_(
    target_id: UUID,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> PublishTargetOut:
    """Soft-archive a target. Voices assigned to it keep their FK, but resolving
    an archived target at publish time raises — the web layer warns with the
    assigned-voice count (see ``/usage``) before calling this."""
    async with sf() as session:
        row = await _get_or_404(session, target_id)
        row.is_archived = True
        await session.commit()
        await session.refresh(row)
        return _to_out(row)


@router.post("/{target_id}/restore", response_model=PublishTargetOut)
async def restore_(
    target_id: UUID,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> PublishTargetOut:
    async with sf() as session:
        row = await _get_or_404(session, target_id)
        row.is_archived = False
        await session.commit()
        await session.refresh(row)
        return _to_out(row)


@router.get("/{target_id}/usage", response_model=PublishTargetUsage)
async def usage_(
    target_id: UUID,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> PublishTargetUsage:
    """How many voices (personas) are assigned to this target — used to warn
    before archiving."""
    async with sf() as session:
        await _get_or_404(session, target_id)
        count = (
            await session.execute(
                select(func.count())
                .select_from(Persona)
                .where(Persona.publish_target_id == target_id)
            )
        ).scalar_one()
        return PublishTargetUsage(
            publish_target_id=target_id, assigned_voice_count=int(count)
        )


@router.get("/{target_id}/readiness", response_model=PublishTargetReadiness)
async def readiness_(
    target_id: UUID,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> PublishTargetReadiness:
    """Presence-only check of the target's credential env vars. Returns booleans
    only — credential values are never read into the response."""
    async with sf() as session:
        row = await _get_or_404(session, target_id)
        ref = row.auth_ref
        base_url = bool(os.environ.get(f"{ref}_BASE_URL"))
        username = bool(os.environ.get(f"{ref}_USERNAME"))
        app_password = bool(os.environ.get(f"{ref}_APP_PASSWORD"))
        return PublishTargetReadiness(
            publish_target_id=target_id,
            auth_ref=ref,
            base_url=base_url,
            username=username,
            app_password=app_password,
            ready=base_url and username and app_password,
        )
