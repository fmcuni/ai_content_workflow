# content_tool/policy/personas.py
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Persona
from content_tool.models.persona import PersonaPack

_DEFAULT_PERSONA_DIR = Path(__file__).resolve().parents[2] / "config" / "personas"

_PERSONA_PATCH_KEYS = {
    "name",
    "voice_rules",
    "banned_terms",
    "required_phrasings",
    "disclaimer_templates",
    "tone_examples",
    "glossary",
    "is_archived",
}


def load_persona_from_yaml(
    name: str, base_dir: Path = _DEFAULT_PERSONA_DIR
) -> PersonaPack:
    """Synchronous YAML fallback. Used at cold-start and in unit tests."""
    path = base_dir / f"{name}.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return PersonaPack.model_validate(raw)


def _row_to_pack(row: Persona) -> PersonaPack:
    return PersonaPack.model_validate({
        "name": row.name,
        "voice_rules": row.voice_rules,
        "banned_terms": row.banned_terms,
        "required_phrasings": row.required_phrasings,
        "disclaimer_templates": row.disclaimer_templates,
        "tone_examples": row.tone_examples,
        "glossary": row.glossary or [],
    })


async def load_persona(
    slug: str,
    *,
    session: AsyncSession,
) -> PersonaPack:
    """DB-first lookup with YAML fallback when no row exists for this slug."""
    row = (
        await session.execute(select(Persona).where(Persona.slug == slug))
    ).scalar_one_or_none()
    if row is not None:
        return _row_to_pack(row)
    return load_persona_from_yaml(slug)


async def list_personas(
    *, session: AsyncSession, include_archived: bool = False
) -> list[Persona]:
    q = select(Persona).order_by(Persona.created_at.asc())
    if not include_archived:
        q = q.where(Persona.is_archived.is_(False))
    return list((await session.execute(q)).scalars().all())


async def get_persona(*, session: AsyncSession, slug: str) -> Persona | None:
    return (
        await session.execute(select(Persona).where(Persona.slug == slug))
    ).scalar_one_or_none()


async def create_persona(
    *,
    session: AsyncSession,
    slug: str,
    name: str,
    voice_rules: list[str],
    banned_terms: list[str],
    required_phrasings: list[str],
    disclaimer_templates: dict[str, dict[str, str]],
    tone_examples: dict[str, list[str]],
    glossary: list[dict[str, Any]] | None = None,
    created_by: str | None = None,
) -> Persona:
    row = Persona(
        slug=slug,
        name=name,
        voice_rules=voice_rules,
        banned_terms=banned_terms,
        required_phrasings=required_phrasings,
        disclaimer_templates=disclaimer_templates,
        tone_examples=tone_examples,
        glossary=glossary or [],
        created_by=created_by,
        updated_by=created_by,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def update_persona(
    *,
    session: AsyncSession,
    slug: str,
    patch: dict[str, Any],
    updated_by: str | None = None,
) -> Persona:
    row = await get_persona(session=session, slug=slug)
    if row is None:
        raise LookupError(f"persona '{slug}' not found")
    # slug is immutable post-create
    for key, value in patch.items():
        if key == "slug":
            continue
        if key not in _PERSONA_PATCH_KEYS:
            raise ValueError(f"unknown persona field: {key!r}")
        setattr(row, key, value)
    row.updated_at = datetime.now(UTC)
    row.updated_by = updated_by
    await session.commit()
    await session.refresh(row)
    return row


async def set_archived(
    *, session: AsyncSession, slug: str, archived: bool, updated_by: str | None = None,
) -> Persona:
    return await update_persona(
        session=session, slug=slug, patch={"is_archived": archived}, updated_by=updated_by,
    )
