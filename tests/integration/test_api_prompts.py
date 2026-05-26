import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_graph_metadata(api_client: AsyncClient):
    r = await api_client.get("/prompts/graph")
    assert r.status_code == 200
    body = r.json()
    assert {"nodes", "edges", "gates"}.issubset(body.keys())
    persona_bound = {n["id"] for n in body["nodes"] if n.get("uses_persona")}
    assert persona_bound == {"writer", "audit"}


@pytest.mark.asyncio
async def test_template_audit_loads(api_client: AsyncClient):
    r = await api_client.get("/prompts/templates/audit")
    assert r.status_code == 200
    body = r.json()
    assert "{persona_block}" in body["template"]
    assert body["template_id"] == "audit"


@pytest.mark.asyncio
async def test_template_unknown_id_404s(api_client: AsyncClient):
    r = await api_client.get("/prompts/templates/does_not_exist")
    assert r.status_code == 404
