import pytest
from httpx import ASGITransport, AsyncClient

from content_tool.api.main import create_app
from content_tool.api.routes import setup as setup_routes
from content_tool.config import Settings


@pytest.fixture
def app(monkeypatch):
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    application = create_app()
    # Deterministic settings: ignore repo .env.local, read only explicit values.
    application.dependency_overrides[setup_routes.settings_provider] = lambda: Settings(
        _env_file=None
    )
    return application


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_health_ok_when_unconfigured(app):
    async with _client(app) as ac:
        r = await ac.get("/health")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_status_reports_unconfigured(app):
    async with _client(app) as ac:
        r = await ac.get("/setup/status")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is False
    assert set(body["missing"]) == {"postgres_url", "gemini_api_key"}
