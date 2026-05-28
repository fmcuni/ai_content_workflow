import hashlib
from pathlib import Path

import pytest
from httpx import AsyncClient

_PROMPT_DIR = Path(__file__).resolve().parents[2] / "prompts"


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@pytest.fixture
def restore_prompt():
    """Snapshot a prompt file's content and restore it after the test.

    PUT /prompts/templates writes a real file on disk; without restore the
    repo's prompts would drift on every failed run.
    """
    snapshots: dict[Path, str] = {}

    def _snap(filename: str) -> Path:
        path = _PROMPT_DIR / filename
        snapshots[path] = path.read_text(encoding="utf-8")
        return path

    yield _snap

    for path, body in snapshots.items():
        path.write_text(body, encoding="utf-8")


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


@pytest.mark.asyncio
async def test_list_templates_returns_agents_and_partials(api_client: AsyncClient):
    r = await api_client.get("/prompts/templates")
    assert r.status_code == 200
    body = r.json()
    items = body["templates"]
    assert len(items) >= 10
    by_id = {i["template_id"]: i for i in items}
    assert by_id["writer_small_refresh"]["category"] == "agent"
    assert by_id["_writer_brand_block"]["category"] == "partial"
    assert len(by_id["writer_small_refresh"]["sha256"]) == 64


@pytest.mark.asyncio
async def test_template_schema_writer_small_refresh(api_client: AsyncClient):
    r = await api_client.get("/prompts/templates/writer_small_refresh/schema")
    assert r.status_code == 200
    body = r.json()
    assert set(body["required_placeholders"]) == {
        "persona_block", "today_date", "source_policy_block",
    }
    assert "_writer_brand_block" in body["found_includes"]
    assert body["unknown_includes"] == []


@pytest.mark.asyncio
async def test_template_consumers_partial_lists_three_writer_routes(api_client: AsyncClient):
    r = await api_client.get("/prompts/templates/_writer_brand_block/consumers")
    assert r.status_code == 200
    assert set(r.json()["consumers"]) == {
        "writer_small_refresh", "writer_full_rewrite", "writer_create",
    }


@pytest.mark.asyncio
async def test_template_consumers_agent_is_self(api_client: AsyncClient):
    r = await api_client.get("/prompts/templates/audit/consumers")
    assert r.status_code == 200
    assert r.json()["consumers"] == ["audit"]


@pytest.mark.asyncio
async def test_put_template_round_trip(api_client: AsyncClient, restore_prompt):
    restore_prompt("_writer_brand_block.md")
    # Read current
    g = await api_client.get("/prompts/templates/_writer_brand_block")
    assert g.status_code == 200
    sha = g.json()["sha256"]
    body = g.json()["template"]

    new_body = body + "\n# touched-by-test\n"
    r = await api_client.put(
        "/prompts/templates/_writer_brand_block",
        json={"template": new_body, "expected_sha256": sha},
    )
    assert r.status_code == 200, r.text
    assert r.json()["sha256"] == _sha256(new_body)

    # Disk reflects the new content
    on_disk = (_PROMPT_DIR / "_writer_brand_block.md").read_text(encoding="utf-8")
    assert on_disk == new_body


@pytest.mark.asyncio
async def test_put_template_missing_placeholder_400(
    api_client: AsyncClient, restore_prompt
):
    restore_prompt("writer_small_refresh.md")
    g = await api_client.get("/prompts/templates/writer_small_refresh")
    sha = g.json()["sha256"]
    body = g.json()["template"]

    # Strip a required placeholder
    stripped = body.replace("{persona_block}", "")
    r = await api_client.put(
        "/prompts/templates/writer_small_refresh",
        json={"template": stripped, "expected_sha256": sha},
    )
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["error"] == "missing_placeholders"
    assert "persona_block" in detail["missing"]


@pytest.mark.asyncio
async def test_put_template_stale_sha_409(api_client: AsyncClient, restore_prompt):
    restore_prompt("_writer_seo.md")
    g = await api_client.get("/prompts/templates/_writer_seo")
    body = g.json()["template"]
    r = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": body + "\n", "expected_sha256": "0" * 64},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "stale_sha"


@pytest.mark.asyncio
async def test_put_template_unknown_include_400(
    api_client: AsyncClient, restore_prompt
):
    restore_prompt("writer_create.md")
    g = await api_client.get("/prompts/templates/writer_create")
    sha = g.json()["sha256"]
    body = g.json()["template"]
    bad = body + "\n{{include:_does_not_exist}}\n"
    r = await api_client.put(
        "/prompts/templates/writer_create",
        json={"template": bad, "expected_sha256": sha},
    )
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["error"] == "unknown_includes"
    assert "_does_not_exist" in detail["unknown"]


@pytest.mark.asyncio
async def test_preview_agent_prompt_resolves_source_policy(api_client: AsyncClient):
    g = await api_client.get("/prompts/templates/writer_small_refresh")
    body = g.json()["template"]
    r = await api_client.post(
        "/prompts/templates/writer_small_refresh/preview",
        json={"template": body},
    )
    assert r.status_code == 200
    resolved = r.json()["resolved"]
    # Live source_policy_block was substituted in (text starts with the
    # 引用與資料來源規則 header rendered by SourcePolicy.to_prompt_block).
    assert "引用與資料來源規則" in resolved
    # And no literal placeholders remain.
    assert "{persona_block}" not in resolved
    assert "{source_policy_block}" not in resolved
    assert "{today_date}" not in resolved


@pytest.mark.asyncio
async def test_preview_partial_swaps_into_route(api_client: AsyncClient):
    sentinel = "SENTINEL-BRAND-BLOCK-XYZ"
    r = await api_client.post(
        "/prompts/templates/_writer_brand_block/preview",
        json={"template": sentinel, "route": "writer_small_refresh"},
    )
    assert r.status_code == 200
    resolved = r.json()["resolved"]
    assert sentinel in resolved
    # Other partials still come from disk — assert one of their distinctive
    # strings is present so we know the rest of the route assembled.
    assert "FAQ" in resolved or "JSON-LD" in resolved
    assert r.json()["route"] == "writer_small_refresh"


@pytest.mark.asyncio
async def test_preview_partial_requires_route(api_client: AsyncClient):
    r = await api_client.post(
        "/prompts/templates/_writer_brand_block/preview",
        json={"template": "x"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_preview_partial_route_must_be_consumer(api_client: AsyncClient):
    # audit.md does not include _writer_brand_block, so previewing the partial
    # against audit should be rejected.
    r = await api_client.post(
        "/prompts/templates/_writer_brand_block/preview",
        json={"template": "x", "route": "audit"},
    )
    assert r.status_code == 400
