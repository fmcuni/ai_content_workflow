from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from content_tool.api.schemas import (
    PersonaIn,
    PersonaOut,
    PersonaPatch,
    PersonaUsage,
)
from content_tool.db.models import Persona, Run
from content_tool.policy.personas import (
    create_persona,
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
            )
        except IntegrityError as e:
            raise HTTPException(409, f"slug '{payload.slug}' already exists") from e
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
    async with sf() as session:
        try:
            row = await set_archived(session=session, slug=slug, archived=True)
        except LookupError as e:
            raise HTTPException(404, str(e)) from e
        return _to_out(row)


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
