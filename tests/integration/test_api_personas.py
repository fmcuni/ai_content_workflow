import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.db.models import Persona


@pytest.mark.asyncio
async def test_list_personas_includes_seed(api_client: AsyncClient):
    r = await api_client.get("/personas")
    assert r.status_code == 200
    slugs = [p["slug"] for p in r.json()]
    assert "bowtie-editor" in slugs


@pytest.mark.asyncio
async def test_get_persona_by_slug(api_client: AsyncClient):
    r = await api_client.get("/personas/bowtie-editor")
    assert r.status_code == 200
    assert r.json()["name"] == "Bowtie 編輯"


@pytest.mark.asyncio
async def test_create_persona_round_trip(api_client: AsyncClient, pg_session_factory: async_sessionmaker):
    payload = {
        "slug": "test-voice",
        "name": "Test Voice",
        "voice_rules": ["clear"],
        "banned_terms": ["X"],
        "required_phrasings": ["Y"],
        "disclaimer_templates": {"medical": "z"},
        "tone_examples": {"good": ["a"], "bad": ["b"]},
    }
    try:
        r = await api_client.post("/personas", json=payload)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["slug"] == "test-voice"
        assert body["is_archived"] is False

        r2 = await api_client.get(f"/personas/{payload['slug']}")
        assert r2.status_code == 200
        assert r2.json()["name"] == "Test Voice"
    finally:
        async with pg_session_factory() as s:
            await s.execute(delete(Persona).where(Persona.slug == "test-voice"))
            await s.commit()


@pytest.mark.asyncio
async def test_create_persona_slug_collision_409(api_client: AsyncClient):
    payload = {
        "slug": "bowtie-editor",  # seeded
        "name": "Dup", "voice_rules": [], "banned_terms": [],
        "required_phrasings": [], "disclaimer_templates": {},
        "tone_examples": {"good": [], "bad": []},
    }
    r = await api_client.post("/personas", json=payload)
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_update_persona_name(api_client: AsyncClient, pg_session_factory: async_sessionmaker):
    create = {
        "slug": "edit-me", "name": "Old",
        "voice_rules": [], "banned_terms": [], "required_phrasings": [],
        "disclaimer_templates": {}, "tone_examples": {"good": [], "bad": []},
    }
    try:
        await api_client.post("/personas", json=create)

        r = await api_client.put("/personas/edit-me", json={"name": "New"})
        assert r.status_code == 200
        assert r.json()["name"] == "New"
    finally:
        async with pg_session_factory() as s:
            await s.execute(delete(Persona).where(Persona.slug == "edit-me"))
            await s.commit()


@pytest.mark.asyncio
async def test_archive_hides_from_default_list(api_client: AsyncClient, pg_session_factory: async_sessionmaker):
    try:
        await api_client.post("/personas", json={
            "slug": "archived-one", "name": "x",
            "voice_rules": [], "banned_terms": [], "required_phrasings": [],
            "disclaimer_templates": {}, "tone_examples": {"good": [], "bad": []},
        })
        r = await api_client.post("/personas/archived-one/archive")
        assert r.status_code == 200
        assert r.json()["is_archived"] is True

        r2 = await api_client.get("/personas")
        assert all(p["slug"] != "archived-one" for p in r2.json())

        r3 = await api_client.get("/personas?include_archived=true")
        assert any(p["slug"] == "archived-one" for p in r3.json())
    finally:
        async with pg_session_factory() as s:
            await s.execute(delete(Persona).where(Persona.slug == "archived-one"))
            await s.commit()


@pytest.mark.asyncio
async def test_usage_endpoint_counts_runs(api_client: AsyncClient):
    r = await api_client.get("/personas/bowtie-editor/usage")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == "bowtie-editor"
    assert "by_status" in body
    assert "total" in body


@pytest.mark.asyncio
async def test_get_unknown_slug_404(api_client: AsyncClient):
    r = await api_client.get("/personas/does-not-exist")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_update_unknown_slug_404(api_client: AsyncClient):
    r = await api_client.put("/personas/does-not-exist", json={"name": "X"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_archive_unknown_slug_404(api_client: AsyncClient):
    r = await api_client.post("/personas/does-not-exist/archive")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_restore_unknown_slug_404(api_client: AsyncClient):
    r = await api_client.post("/personas/does-not-exist/restore")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_usage_unknown_slug_404(api_client: AsyncClient):
    r = await api_client.get("/personas/does-not-exist/usage")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_put_with_slug_field_is_silently_ignored(
    api_client: AsyncClient, pg_session_factory
):
    create = {
        "slug": "immutable-test", "name": "Original",
        "voice_rules": [], "banned_terms": [], "required_phrasings": [],
        "disclaimer_templates": {}, "tone_examples": {"good": [], "bad": []},
    }
    await api_client.post("/personas", json=create)
    try:
        r = await api_client.put(
            "/personas/immutable-test",
            json={"slug": "renamed", "name": "Updated"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["slug"] == "immutable-test"  # slug NOT changed
        assert body["name"] == "Updated"
        # And the "renamed" slug shouldn't exist
        r2 = await api_client.get("/personas/renamed")
        assert r2.status_code == 404
    finally:
        async with pg_session_factory() as s:
            await s.execute(
                delete(Persona).where(Persona.slug == "immutable-test")
            )
            await s.commit()
