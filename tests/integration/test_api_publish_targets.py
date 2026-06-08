"""Publish-targets self-service CRUD + readiness (Phase 2).

Mirrors the Workers backend's publish_targets_crud.test.ts. DB-backed (uses the
api_client + pg_session_factory fixtures), so it runs in CI where Postgres is up.
RBAC is Workers-authoritative, so these routes are unauthenticated here — the
admin gate is asserted on the Workers side.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker

from content_tool.db.models import PublishTarget

_AUTH_REF = "PYTEST_WP"


async def _cleanup(sf: async_sessionmaker) -> None:
    async with sf() as s:
        await s.execute(delete(PublishTarget).where(PublishTarget.auth_ref == _AUTH_REF))
        await s.commit()


@pytest.mark.asyncio
async def test_list_publish_targets_includes_seed(api_client: AsyncClient):
    r = await api_client.get("/publish-targets")
    assert r.status_code == 200
    refs = [t["auth_ref"] for t in r.json()]
    assert "WP" in refs  # seeded Bowtie WordPress


@pytest.mark.asyncio
async def test_create_publish_target_round_trip(
    api_client: AsyncClient, pg_session_factory: async_sessionmaker
):
    try:
        r = await api_client.post(
            "/publish-targets", json={"name": "Pytest WP", "auth_ref": _AUTH_REF}
        )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["kind"] == "wordpress"
        assert body["auth_ref"] == _AUTH_REF
        assert body["status"] == "active"
        assert body["is_archived"] is False
        target_id = body["publish_target_id"]

        listed = await api_client.get("/publish-targets")
        assert _AUTH_REF in [t["auth_ref"] for t in listed.json()]

        # Edit name + status; auth_ref is not a patch field (immutable).
        patch = await api_client.patch(
            f"/publish-targets/{target_id}",
            json={"name": "Renamed", "status": "inactive", "auth_ref": "HACKED"},
        )
        assert patch.status_code == 200, patch.text
        assert patch.json()["name"] == "Renamed"
        assert patch.json()["status"] == "inactive"
        assert patch.json()["auth_ref"] == _AUTH_REF  # unchanged
    finally:
        await _cleanup(pg_session_factory)


@pytest.mark.asyncio
async def test_create_duplicate_auth_ref_409(
    api_client: AsyncClient, pg_session_factory: async_sessionmaker
):
    try:
        first = await api_client.post(
            "/publish-targets", json={"name": "A", "auth_ref": _AUTH_REF}
        )
        assert first.status_code == 201
        dup = await api_client.post(
            "/publish-targets", json={"name": "B", "auth_ref": _AUTH_REF}
        )
        assert dup.status_code == 409
    finally:
        await _cleanup(pg_session_factory)


@pytest.mark.asyncio
async def test_create_malformed_auth_ref_422(api_client: AsyncClient):
    r = await api_client.post(
        "/publish-targets", json={"name": "X", "auth_ref": "9 bad-ref"}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_patch_unknown_target_404(api_client: AsyncClient):
    r = await api_client.patch(
        "/publish-targets/00000000-0000-0000-0000-0000000000ff",
        json={"name": "x"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_archive_restore_and_usage(
    api_client: AsyncClient, pg_session_factory: async_sessionmaker
):
    try:
        created = await api_client.post(
            "/publish-targets", json={"name": "Pytest WP", "auth_ref": _AUTH_REF}
        )
        target_id = created.json()["publish_target_id"]

        # No voices assigned yet.
        usage = await api_client.get(f"/publish-targets/{target_id}/usage")
        assert usage.status_code == 200
        assert usage.json()["assigned_voice_count"] == 0

        archived = await api_client.post(f"/publish-targets/{target_id}/archive")
        assert archived.status_code == 200
        assert archived.json()["is_archived"] is True

        # Archived rows are hidden from the default list, shown with the flag.
        default_list = await api_client.get("/publish-targets")
        assert _AUTH_REF not in [t["auth_ref"] for t in default_list.json()]
        with_archived = await api_client.get(
            "/publish-targets", params={"include_archived": "true"}
        )
        assert _AUTH_REF in [t["auth_ref"] for t in with_archived.json()]

        restored = await api_client.post(f"/publish-targets/{target_id}/restore")
        assert restored.status_code == 200
        assert restored.json()["is_archived"] is False
    finally:
        await _cleanup(pg_session_factory)


@pytest.mark.asyncio
async def test_readiness_presence_only(
    api_client: AsyncClient,
    pg_session_factory: async_sessionmaker,
    monkeypatch: pytest.MonkeyPatch,
):
    try:
        created = await api_client.post(
            "/publish-targets", json={"name": "Pytest WP", "auth_ref": _AUTH_REF}
        )
        target_id = created.json()["publish_target_id"]

        # Missing secrets → not ready.
        monkeypatch.delenv(f"{_AUTH_REF}_BASE_URL", raising=False)
        monkeypatch.delenv(f"{_AUTH_REF}_USERNAME", raising=False)
        monkeypatch.delenv(f"{_AUTH_REF}_APP_PASSWORD", raising=False)
        r = await api_client.get(f"/publish-targets/{target_id}/readiness")
        assert r.status_code == 200
        assert r.json()["ready"] is False
        assert r.json()["base_url"] is False

        # All present → ready. Booleans only — no values echoed.
        monkeypatch.setenv(f"{_AUTH_REF}_BASE_URL", "https://example.test")
        monkeypatch.setenv(f"{_AUTH_REF}_USERNAME", "u")
        monkeypatch.setenv(f"{_AUTH_REF}_APP_PASSWORD", "p")
        r2 = await api_client.get(f"/publish-targets/{target_id}/readiness")
        assert r2.json()["ready"] is True
        assert set(r2.json()) == {
            "publish_target_id",
            "auth_ref",
            "base_url",
            "username",
            "app_password",
            "ready",
        }
    finally:
        await _cleanup(pg_session_factory)
