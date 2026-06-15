from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool import prompts_store, source_policy_store
from content_tool.api.schemas import (
    PersonaIn,
    PersonaOut,
    PersonaPatch,
    PersonaUsage,
)
from content_tool.db.models import Persona, Run
from content_tool.policy.personas import (
    DuplicateSlugError,
    count_active_personas,
    create_persona,
    duplicate_persona,
    get_persona,
    list_personas,
    set_archived,
    update_persona,
)

router = APIRouter(prefix="/personas", tags=["personas"])


def get_session_factory(request: Request):  # noqa: ANN201
    return request.app.state.session_factory


def _to_out(row: Persona) -> PersonaOut:
    return PersonaOut.model_validate({
        "persona_id": row.persona_id,
        "slug": row.slug,
        "name": row.name,
        "voice_rules": row.voice_rules,
        "banned_terms": row.banned_terms,
        "required_phrasings": row.required_phrasings,
        "disclaimer_templates": row.disclaimer_templates,
        "tone_examples": row.tone_examples,
        "glossary": row.glossary or [],
        "locale": row.locale or {},
        "publish_target_id": row.publish_target_id,
        "is_archived": row.is_archived,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "created_by": row.created_by,
        "updated_by": row.updated_by,
    })


@router.get("", response_model=list[PersonaOut])
async def list_(
    include_archived: bool = Query(False),
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> list[PersonaOut]:
    async with sf() as session:
        rows = await list_personas(session=session, include_archived=include_archived)
        return [_to_out(r) for r in rows]


@router.get("/{slug}", response_model=PersonaOut)
async def get_(slug: str, sf=Depends(get_session_factory)) -> PersonaOut:  # noqa: ANN001, B008
    async with sf() as session:
        row = await get_persona(session=session, slug=slug)
        if row is None:
            raise HTTPException(404, "persona not found")
        return _to_out(row)


@router.post("", response_model=PersonaOut, status_code=201)
async def create_(
    payload: PersonaIn,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> PersonaOut:
    async with sf() as session:
        try:
            row = await create_persona(
                session=session,
                slug=payload.slug,
                name=payload.name,
                voice_rules=payload.voice_rules,
                banned_terms=payload.banned_terms,
                required_phrasings=payload.required_phrasings,
                disclaimer_templates={
                    k: v.model_dump() for k, v in payload.disclaimer_templates.items()
                },
                tone_examples=payload.tone_examples,
                glossary=[g.model_dump() for g in payload.glossary],
                locale=payload.locale.model_dump(),
            )
        except IntegrityError as e:
            raise HTTPException(409, f"slug '{payload.slug}' already exists") from e
        return _to_out(row)


class _DuplicateRequest(BaseModel):
    slug: str
    name: str


@router.post("/{slug}/duplicate", response_model=PersonaOut, status_code=201)
async def duplicate_(
    slug: str,
    payload: _DuplicateRequest,
    sf: async_sessionmaker[Any] = Depends(get_session_factory),  # noqa: B008
) -> PersonaOut:
    """Create a new voice as a deep copy of ``slug``.

    Clones the persona row plus the source voice's agent/partial prompt templates
    and source policy (with seeded history rows) under the new slug, all in one
    transaction. 404 if the source voice is unknown; 409 if the target slug
    already exists. The prompt + policy caches are busted so the new voice's rows
    are immediately visible to ``/prompts`` and ``/source-policy``.
    """
    async with sf() as session:
        try:
            row = await duplicate_persona(
                session=session,
                source_slug=slug,
                new_slug=payload.slug,
                new_name=payload.name,
            )
        except LookupError as e:
            raise HTTPException(404, str(e)) from e
        except (DuplicateSlugError, IntegrityError) as e:
            raise HTTPException(409, f"slug '{payload.slug}' already exists") from e
    prompts_store.invalidate()
    source_policy_store.invalidate()
    return _to_out(row)


@router.put("/{slug}", response_model=PersonaOut)
async def update_(
    slug: str,
    payload: PersonaPatch,
    sf=Depends(get_session_factory),  # noqa: ANN001, B008
) -> PersonaOut:
    async with sf() as session:
        patch = payload.model_dump(exclude_unset=True)
        try:
            row = await update_persona(session=session, slug=slug, patch=patch)
        except LookupError as e:
            raise HTTPException(404, str(e)) from e
        return _to_out(row)


@router.post("/{slug}/archive", response_model=PersonaOut)
async def archive_(slug: str, sf=Depends(get_session_factory)) -> PersonaOut:  # noqa: ANN001, B008
    """Archive (soft-delete) a voice.

    409 if it is the last non-archived voice — the app must always keep at least
    one usable voice. Archiving an already-archived voice is a no-op and skips
    the guard.
    """
    async with sf() as session:
        row = await get_persona(session=session, slug=slug)
        if row is None:
            raise HTTPException(404, "persona not found")
        if not row.is_archived and await count_active_personas(session=session) <= 1:
            raise HTTPException(409, "cannot archive the last remaining voice")
        try:
            updated = await set_archived(session=session, slug=slug, archived=True)
        except LookupError as e:
            raise HTTPException(404, str(e)) from e
        return _to_out(updated)


@router.post("/{slug}/restore", response_model=PersonaOut)
async def restore_(slug: str, sf=Depends(get_session_factory)) -> PersonaOut:  # noqa: ANN001, B008
    async with sf() as session:
        try:
            row = await set_archived(session=session, slug=slug, archived=False)
        except LookupError as e:
            raise HTTPException(404, str(e)) from e
        return _to_out(row)


@router.get("/{slug}/usage", response_model=PersonaUsage)
async def usage_(slug: str, sf=Depends(get_session_factory)) -> PersonaUsage:  # noqa: ANN001, B008
    async with sf() as session:
        row = await get_persona(session=session, slug=slug)
        if row is None:
            raise HTTPException(404, "persona not found")
        q = (
            select(Run.status, func.count())
            .where(Run.persona == slug)
            .group_by(Run.status)
        )
        rows = (await session.execute(q)).all()
        by_status = {status: int(n) for (status, n) in rows}
        return PersonaUsage(slug=slug, by_status=by_status, total=sum(by_status.values()))
