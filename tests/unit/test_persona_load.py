import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.models import Persona
from content_tool.policy.personas import (
    create_persona,
    list_personas,
    load_persona,
    load_persona_from_yaml,
    set_archived,
    update_persona,
)


@pytest.mark.asyncio
async def test_load_persona_falls_back_to_yaml_when_db_empty(db_session: AsyncSession):
    p = await load_persona("bowtie-editor", session=db_session)
    assert p.name == "Bowtie 編輯"
    assert "信息" in p.banned_terms


@pytest.mark.asyncio
async def test_load_persona_reads_from_db_when_present(db_session: AsyncSession):
    db_session.add(Persona(
        slug="ghost-writer",
        name="Ghost",
        voice_rules=["rule A"],
        banned_terms=["X"],
        required_phrasings=["Y"],
        disclaimer_templates={"medical": "..."},
        tone_examples={"good": ["g"], "bad": ["b"]},
    ))
    await db_session.commit()
    p = await load_persona("ghost-writer", session=db_session)
    assert p.name == "Ghost"
    assert p.voice_rules == ["rule A"]


def test_load_persona_from_yaml_pure_sync():
    p = load_persona_from_yaml("bowtie-editor")
    assert p.name == "Bowtie 編輯"


@pytest.mark.asyncio
async def test_create_and_update_persona(db_session: AsyncSession):
    created = await create_persona(
        session=db_session,
        slug="new-voice",
        name="New Voice",
        voice_rules=["r1"],
        banned_terms=["b1"],
        required_phrasings=["p1"],
        disclaimer_templates={},
        tone_examples={"good": [], "bad": []},
        created_by="franco@bowtie",
    )
    assert created.slug == "new-voice"

    updated = await update_persona(
        session=db_session,
        slug="new-voice",
        patch={"name": "Renamed"},
        updated_by="franco@bowtie",
    )
    assert updated.name == "Renamed"


@pytest.mark.asyncio
async def test_archive_then_restore(db_session: AsyncSession):
    db_session.add(Persona(
        slug="will-archive", name="x",
        voice_rules=[], banned_terms=[], required_phrasings=[],
        disclaimer_templates={}, tone_examples={"good": [], "bad": []},
    ))
    await db_session.commit()

    await set_archived(session=db_session, slug="will-archive", archived=True)
    rows = await list_personas(session=db_session, include_archived=False)
    assert all(r.slug != "will-archive" for r in rows)

    rows_all = await list_personas(session=db_session, include_archived=True)
    assert any(r.slug == "will-archive" and r.is_archived for r in rows_all)
