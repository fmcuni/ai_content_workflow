import json

import pytest
from httpx import ASGITransport, AsyncClient

from content_tool.api.main import create_app
from content_tool.api.routes import setup as setup_routes
from content_tool.config import Settings


@pytest.fixture
def app_and_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BOWTIE_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    app = create_app()
    # Deterministic settings: ignore repo .env.local, read only env + tmp json file.
    app.dependency_overrides[setup_routes.settings_provider] = lambda: Settings(_env_file=None)
    return app, tmp_path


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_health_ok_when_unconfigured(app_and_dir):
    app, _ = app_and_dir
    async with _client(app) as ac:
        r = await ac.get("/health")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_status_reports_unconfigured(app_and_dir):
    app, _ = app_and_dir
    async with _client(app) as ac:
        r = await ac.get("/setup/status")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is False
    assert set(body["missing"]) == {"postgres_url", "gemini_api_key"}


@pytest.mark.asyncio
async def test_post_bad_body_returns_422(app_and_dir):
    app, _ = app_and_dir
    async with _client(app) as ac:
        r = await ac.post("/setup", json={"postgres_url": "postgresql://u@h/db"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_post_verification_failure_does_not_persist(app_and_dir, monkeypatch):
    app, tmp = app_and_dir

    async def fake_verify(**_):
        return {"postgres": False, "gemini": True}

    monkeypatch.setattr(setup_routes.verify_mod, "verify_credentials", fake_verify)
    async with _client(app) as ac:
        r = await ac.post(
            "/setup",
            json={"postgres_url": "postgresql://u@h/db", "gemini_api_key": "k"},
        )
    assert r.status_code == 400
    body = r.json()
    assert body["detail"] == "verification_failed"
    assert body["checks"] == {"postgres": False, "gemini": True}
    assert not (tmp / "config.json").exists()


@pytest.mark.asyncio
async def test_verify_endpoint_does_not_persist(app_and_dir, monkeypatch):
    app, tmp = app_and_dir

    async def fake_verify(**_):
        return {"postgres": True, "gemini": True}

    monkeypatch.setattr(setup_routes.verify_mod, "verify_credentials", fake_verify)
    async with _client(app) as ac:
        r = await ac.post(
            "/setup/verify",
            json={"postgres_url": "postgresql://u@h/db", "gemini_api_key": "k"},
        )
    assert r.status_code == 200
    assert r.json() == {"postgres": True, "gemini": True}
    assert not (tmp / "config.json").exists()


@pytest.mark.asyncio
async def test_post_happy_path_persists_inits_and_hides_secret(app_and_dir, monkeypatch):
    app, tmp = app_and_dir
    secret = "secret-gemini-key-xyz"  # noqa: S105 — synthetic test value

    async def fake_verify(**_):
        return {"postgres": True, "gemini": True}

    init_calls = {"count": 0}

    async def fake_init(_app, _settings):
        init_calls["count"] += 1

    monkeypatch.setattr(setup_routes.verify_mod, "verify_credentials", fake_verify)
    monkeypatch.setattr("content_tool.api.main.init_runtime", fake_init)

    async with _client(app) as ac:
        r = await ac.post(
            "/setup",
            json={"postgres_url": "postgresql://u@h/db", "gemini_api_key": secret},
        )
        assert r.status_code == 200
        assert r.json() == {"configured": True}
        status = await ac.get("/setup/status")

    assert status.json()["configured"] is True
    assert secret not in status.text  # never echo the secret
    assert init_calls["count"] == 1
    saved = json.loads((tmp / "config.json").read_text())
    assert saved["postgres_url"] == "postgresql://u@h/db"
    assert saved["gemini_api_key"] == secret
