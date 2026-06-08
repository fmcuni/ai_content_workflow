# content_tool/policy/personas.py
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import (
    Persona,
    PromptTemplate,
    PromptVersion,
    SourcePolicyRecord,
    SourcePolicyVersion,
)
from content_tool.models.persona import PersonaPack
from content_tool.source_policy_store import POLICY_ID, SHARED_VOICE

# Editable prompt categories cloned when a voice is duplicated. Judges stay
# global (``__shared__``) and are never copied per voice.
_CLONED_PROMPT_CATEGORIES = ("agent", "partial")

_DEFAULT_PERSONA_DIR = Path(__file__).resolve().parents[2] / "config" / "personas"

_PERSONA_PATCH_KEYS = {
    "name",
    "voice_rules",
    "banned_terms",
    "required_phrasings",
    "disclaimer_templates",
    "tone_examples",
    "glossary",
    "publish_target_id",
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


async def count_active_personas(*, session: AsyncSession) -> int:
    """Number of non-archived personas (voices)."""
    return int(
        (
            await session.execute(
                select(func.count()).select_from(Persona).where(Persona.is_archived.is_(False))
            )
        ).scalar_one()
    )


class DuplicateSlugError(Exception):
    """Raised when a duplicate target slug already exists (maps to HTTP 409)."""

    def __init__(self, slug: str) -> None:
        super().__init__(slug)
        self.slug = slug


def _resolved_prompt_rows(
    rows: list[PromptTemplate], source_slug: str
) -> dict[str, PromptTemplate]:
    """Resolve the agent/partial set a source voice sees: its own row wins, the
    ``__shared__`` seed fills any gap — exactly the runtime fallback chain.
    """
    resolved: dict[str, PromptTemplate] = {}
    for r in rows:
        if r.template_id not in resolved or r.voice_slug == source_slug:
            resolved[r.template_id] = r
    return resolved


def _resolved_policy_row(
    rows: list[SourcePolicyRecord], source_slug: str
) -> SourcePolicyRecord | None:
    """Resolve a source voice's policy row (its own wins over ``__shared__``)."""
    chosen: SourcePolicyRecord | None = None
    for r in rows:
        if chosen is None or r.voice_slug == source_slug:
            chosen = r
    return chosen


async def duplicate_persona(
    *,
    session: AsyncSession,
    source_slug: str,
    new_slug: str,
    new_name: str,
    created_by: str | None = None,
) -> Persona:
    """Deep-copy a voice into ``new_slug``: persona row + its agent/partial prompt
    templates + its source policy, seeding initial version-history rows.

    Cloned prompt/policy bodies are byte-identical to the source's resolved set,
    so the new voice starts with the same assembled prompts (and sha256 tokens).
    The caller is responsible for the transaction boundary's commit; this
    function commits once so the whole clone lands atomically. Raises
    :class:`DuplicateSlugError` if ``new_slug`` already exists and
    :class:`LookupError` if ``source_slug`` does not.
    """
    src = await get_persona(session=session, slug=source_slug)
    if src is None:
        raise LookupError(f"persona '{source_slug}' not found")
    if await get_persona(session=session, slug=new_slug) is not None:
        raise DuplicateSlugError(new_slug)

    actor = created_by or "system:duplicate"
    # Round-trip the source voice through the typed PersonaPack, then re-serialise
    # to fresh JSONB-ready containers. This both gives the clone its own copies
    # (never aliasing the source's mutable lists/dicts) and keeps the read fully
    # typed for the strict type checker.
    pack = _row_to_pack(src)
    clone = Persona(
        slug=new_slug,
        name=new_name,
        voice_rules=list(pack.voice_rules),
        banned_terms=list(pack.banned_terms),
        required_phrasings=list(pack.required_phrasings),
        disclaimer_templates={k: v.model_dump() for k, v in pack.disclaimer_templates.items()},
        tone_examples={k: list(v) for k, v in pack.tone_examples.items()},
        glossary=[g.model_dump() for g in pack.glossary],
        created_by=created_by,
        updated_by=created_by,
    )
    session.add(clone)

    template_rows = list(
        (
            await session.execute(
                select(PromptTemplate).where(
                    PromptTemplate.voice_slug.in_([SHARED_VOICE, source_slug]),
                    PromptTemplate.category.in_(_CLONED_PROMPT_CATEGORIES),
                )
            )
        )
        .scalars()
        .all()
    )
    for tid, r in _resolved_prompt_rows(template_rows, source_slug).items():
        session.add(
            PromptTemplate(
                voice_slug=new_slug,
                template_id=tid,
                category=r.category,
                filename=r.filename,
                body=r.body,
                sha256=r.sha256,
                bytes=r.bytes,
                updated_by=created_by,
            )
        )
        session.add(
            PromptVersion(
                voice_slug=new_slug,
                template_id=tid,
                sha256=r.sha256,
                parent_sha256=None,
                body=r.body,
                bytes=r.bytes,
                saved_by=actor,
                kind="save",
            )
        )

    policy_rows = list(
        (
            await session.execute(
                select(SourcePolicyRecord).where(
                    SourcePolicyRecord.voice_slug.in_([SHARED_VOICE, source_slug])
                )
            )
        )
        .scalars()
        .all()
    )
    policy = _resolved_policy_row(policy_rows, source_slug)
    if policy is not None:
        session.add(
            SourcePolicyRecord(
                voice_slug=new_slug,
                body=policy.body,
                sha256=policy.sha256,
                bytes=policy.bytes,
                updated_by=created_by,
            )
        )
        session.add(
            SourcePolicyVersion(
                voice_slug=new_slug,
                policy_id=POLICY_ID,
                sha256=policy.sha256,
                parent_sha256=None,
                body=policy.body,
                bytes=policy.bytes,
                saved_by=actor,
                kind="save",
            )
        )

    await session.commit()
    await session.refresh(clone)
    return clone
