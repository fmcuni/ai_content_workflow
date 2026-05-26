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


@pytest.mark.asyncio
async def test_user_example_unknown_run_404(api_client: AsyncClient):
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": "00000000-0000-0000-0000-000000000000", "agent": "writer"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_user_example_unknown_agent_400(api_client: AsyncClient, persisted_full_run):
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": persisted_full_run, "agent": "bogus"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_user_example_writer_includes_topic(api_client: AsyncClient, persisted_full_run):
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": persisted_full_run, "agent": "writer"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "topic:" in body["prompt"]
    assert body["agent"] == "writer"


@pytest.mark.asyncio
async def test_user_example_audit_includes_html(api_client: AsyncClient, persisted_full_run):
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": persisted_full_run, "agent": "audit"},
    )
    assert r.status_code == 200
    assert "# final_html" in r.json()["prompt"]


@pytest.mark.asyncio
async def test_user_example_missing_inputs_422(api_client: AsyncClient, persisted_strategy_only_run):
    # audit needs Draft + Render + Citation — none present in strategy-only run.
    r = await api_client.get(
        "/prompts/user-example",
        params={"run_id": persisted_strategy_only_run, "agent": "audit"},
    )
    assert r.status_code == 422
    assert "missing" in r.json()["detail"].lower()
