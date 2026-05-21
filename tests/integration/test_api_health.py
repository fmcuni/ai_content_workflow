import pytest
from httpx import ASGITransport, AsyncClient

from content_tool.api.main import create_app


@pytest.mark.asyncio
async def test_health_returns_ok():
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
