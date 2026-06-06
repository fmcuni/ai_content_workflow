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
async def test_create_persona_round_trip(
    api_client: AsyncClient, pg_session_factory: async_sessionmaker
):
    payload = {
        "slug": "test-voice",
        "name": "Test Voice",
        "voice_rules": ["clear"],
        "banned_terms": ["X"],
        "required_phrasings": ["Y"],
        "disclaimer_templates": {"medical": {"condition": "", "disclaimer": "z"}},
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
async def test_archive_hides_from_default_list(
    api_client: AsyncClient, pg_session_factory: async_sessionmaker
):
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


# ---------------------------------------------------------------------------
# Duplicate voice
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_duplicate_clones_persona_templates_and_policy(
    api_client: AsyncClient, duplicated_voice: str
):
    """Duplicate creates the persona row + its own agent/partial templates +
    source policy, with seeded history — all independent of the source."""
    # Persona row exists with the new name.
    p = await api_client.get(f"/personas/{duplicated_voice}")
    assert p.status_code == 200
    assert p.json()["name"] == "Dup Test Voice"
    assert p.json()["is_archived"] is False

    # The clone owns its own prompt templates (not a shared fallback).
    tpls = (
        await api_client.get("/prompts/templates", params={"voice": duplicated_voice})
    ).json()
    by_id = {i["template_id"]: i for i in tpls["templates"]}
    assert by_id["writer_small_refresh"]["voice_slug"] == duplicated_voice

    # Seeded version history exists for a cloned template under the new voice.
    hist = (
        await api_client.get(
            "/prompts/templates/writer_small_refresh/history",
            params={"voice": duplicated_voice},
        )
    ).json()
    assert len(hist["versions"]) >= 1

    # The clone owns its own source-policy row.
    sp = (
        await api_client.get("/source-policy", params={"voice": duplicated_voice})
    ).json()
    assert sp["voice_slug"] == duplicated_voice


@pytest.mark.asyncio
async def test_duplicate_to_existing_slug_409(api_client: AsyncClient):
    r = await api_client.post(
        "/personas/bowtie-editor/duplicate",
        json={"slug": "bowtie-editor", "name": "Dup"},
    )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_duplicate_unknown_source_404(api_client: AsyncClient):
    r = await api_client.post(
        "/personas/does-not-exist/duplicate",
        json={"slug": "whatever", "name": "X"},
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Last-voice archive guard
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cannot_archive_last_voice(api_client: AsyncClient):
    """Archiving is rejected (409) when it would remove the last active voice.

    Archives every active voice except the last, asserts the final archive
    409s, then restores everything it archived (try/finally) so the global
    seed state is left intact for other tests.
    """
    active = [p["slug"] for p in (await api_client.get("/personas")).json()]
    assert active, "expected at least one active voice (the seed)"

    archived: list[str] = []
    try:
        for slug in active[:-1]:
            r = await api_client.post(f"/personas/{slug}/archive")
            assert r.status_code == 200, r.text
            archived.append(slug)
        # Only one active voice remains — archiving it must be rejected.
        last = await api_client.post(f"/personas/{active[-1]}/archive")
        assert last.status_code == 409
        assert (await api_client.get(f"/personas/{active[-1]}")).json()["is_archived"] is False
    finally:
        for slug in archived:
            await api_client.post(f"/personas/{slug}/restore")
