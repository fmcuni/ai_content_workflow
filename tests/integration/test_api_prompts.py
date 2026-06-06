import hashlib

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.db.models import PromptTemplate


def _sha256(text_: str) -> str:
    return hashlib.sha256(text_.encode("utf-8")).hexdigest()


@pytest_asyncio.fixture
async def clean_prompt_versions(
    pg_session_factory: async_sessionmaker[AsyncSession],
):
    """Truncate prompt_versions before and after each test that touches history.

    The base conftest truncate is scoped to runs/articles/wp tables only, so
    history rows would otherwise accumulate across tests and break count
    assertions.
    """
    async with pg_session_factory() as s:
        await s.execute(text("TRUNCATE TABLE content_tool.prompt_versions"))
        await s.commit()
    yield
    async with pg_session_factory() as s:
        await s.execute(text("TRUNCATE TABLE content_tool.prompt_versions"))
        await s.commit()


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
async def test_user_example_missing_inputs_422(
    api_client: AsyncClient, persisted_strategy_only_run
):
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
async def test_put_template_round_trip(
    api_client: AsyncClient,
    restore_template,
    pg_session_factory: async_sessionmaker[AsyncSession],
):
    await restore_template("_writer_brand_block")
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

    # DB row reflects the new content (the default voice the API edits)
    async with pg_session_factory() as s:
        row = (
            await s.execute(
                select(PromptTemplate).where(
                    PromptTemplate.voice_slug == "bowtie-editor",
                    PromptTemplate.template_id == "_writer_brand_block",
                )
            )
        ).scalar_one()
    assert row.body == new_body
    assert row.sha256 == _sha256(new_body)


@pytest.mark.asyncio
async def test_put_template_missing_placeholder_400(
    api_client: AsyncClient, restore_template
):
    await restore_template("writer_small_refresh")
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
async def test_put_template_stale_sha_409(api_client: AsyncClient, restore_template):
    await restore_template("_writer_seo")
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
    api_client: AsyncClient, restore_template
):
    await restore_template("writer_create")
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


# ---------------------------------------------------------------------------
# RBAC — _require_editor / X-Editor-Email header
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_missing_header_in_non_dev_mode_401(
    api_client: AsyncClient, restore_template, clean_prompt_versions, monkeypatch
):
    monkeypatch.setenv("PROMPT_EDITOR_DEV_MODE", "false")
    await restore_template("_writer_seo")
    g = await api_client.get("/prompts/templates/_writer_seo")
    sha = g.json()["sha256"]
    body = g.json()["template"]
    r = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": body + "\n# touched\n", "expected_sha256": sha},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_put_unauthorised_editor_403(
    api_client: AsyncClient, restore_template, clean_prompt_versions, monkeypatch
):
    monkeypatch.setenv("PROMPT_EDITOR_DEV_MODE", "false")
    await restore_template("_writer_seo")
    g = await api_client.get("/prompts/templates/_writer_seo")
    sha = g.json()["sha256"]
    body = g.json()["template"]
    r = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": body + "\n# touched\n", "expected_sha256": sha},
        headers={"X-Editor-Email": "nobody@example.com"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_put_allowed_editor_stamps_version(
    api_client: AsyncClient, restore_template, clean_prompt_versions, monkeypatch
):
    """An allowed editor saves successfully and the version row records the
    email; future history reads should attribute the change to that user."""
    monkeypatch.setenv("PROMPT_EDITOR_DEV_MODE", "false")
    await restore_template("_writer_seo")
    g = await api_client.get("/prompts/templates/_writer_seo")
    sha = g.json()["sha256"]
    body = g.json()["template"]
    new_body = body + "\n# allowed-editor\n"
    r = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": new_body, "expected_sha256": sha},
        headers={"X-Editor-Email": "franco.ma@bowtie.com.sg"},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["saved_by"] == "franco.ma@bowtie.com.sg"
    assert out["sha256"] == _sha256(new_body)
    # And the history endpoint sees the same email.
    h = await api_client.get("/prompts/templates/_writer_seo/history")
    versions = h.json()["versions"]
    assert versions[0]["saved_by"] == "franco.ma@bowtie.com.sg"


# ---------------------------------------------------------------------------
# Version history
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_inserts_history_row(
    api_client: AsyncClient, restore_template, clean_prompt_versions
):
    await restore_template("_writer_seo")
    g = await api_client.get("/prompts/templates/_writer_seo")
    sha = g.json()["sha256"]
    body = g.json()["template"]
    new_body = body + "\n# touched\n"
    r = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": new_body, "expected_sha256": sha},
    )
    assert r.status_code == 200, r.text

    h = await api_client.get("/prompts/templates/_writer_seo/history")
    assert h.status_code == 200
    versions = h.json()["versions"]
    assert len(versions) == 1
    row = versions[0]
    assert row["sha256"] == _sha256(new_body)
    assert row["parent_sha256"] == sha
    assert row["kind"] == "save"
    assert "body" not in row  # list endpoint omits body for payload size


@pytest.mark.asyncio
async def test_history_orders_newest_first(
    api_client: AsyncClient, restore_template, clean_prompt_versions
):
    await restore_template("_writer_seo")
    # Save three times so we can verify ordering.
    for i in range(3):
        g = await api_client.get("/prompts/templates/_writer_seo")
        sha = g.json()["sha256"]
        body = g.json()["template"]
        r = await api_client.put(
            "/prompts/templates/_writer_seo",
            json={"template": body + f"\n# touched-{i}\n", "expected_sha256": sha},
        )
        assert r.status_code == 200

    h = await api_client.get("/prompts/templates/_writer_seo/history")
    versions = h.json()["versions"]
    assert len(versions) == 3
    # saved_at is a timestamptz iso string; lexicographic compare works.
    timestamps = [v["saved_at"] for v in versions]
    assert timestamps == sorted(timestamps, reverse=True)


@pytest.mark.asyncio
async def test_get_version_returns_body(
    api_client: AsyncClient, restore_template, clean_prompt_versions
):
    await restore_template("_writer_seo")
    g = await api_client.get("/prompts/templates/_writer_seo")
    sha = g.json()["sha256"]
    body = g.json()["template"]
    new_body = body + "\n# fetched-by-version-id\n"
    r = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": new_body, "expected_sha256": sha},
    )
    version_id = r.json()["version_id"]

    v = await api_client.get(f"/prompts/templates/_writer_seo/versions/{version_id}")
    assert v.status_code == 200
    payload = v.json()
    assert payload["body"] == new_body
    assert payload["sha256"] == _sha256(new_body)


@pytest.mark.asyncio
async def test_get_version_wrong_template_404(
    api_client: AsyncClient, restore_template, clean_prompt_versions
):
    """A version row belongs to one template; asking for it under another
    template id must 404 to avoid leaking unrelated bodies."""
    await restore_template("_writer_seo")
    g = await api_client.get("/prompts/templates/_writer_seo")
    sha = g.json()["sha256"]
    body = g.json()["template"]
    r = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": body + "\n# x\n", "expected_sha256": sha},
    )
    version_id = r.json()["version_id"]

    cross = await api_client.get(
        f"/prompts/templates/_writer_brand_block/versions/{version_id}"
    )
    assert cross.status_code == 404


# ---------------------------------------------------------------------------
# Revert
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_revert_restores_previous_body(
    api_client: AsyncClient,
    restore_template,
    clean_prompt_versions,
    pg_session_factory: async_sessionmaker[AsyncSession],
):
    await restore_template("_writer_seo")
    # Save A, then save B, then revert to A.
    g = await api_client.get("/prompts/templates/_writer_seo")
    sha0 = g.json()["sha256"]
    body0 = g.json()["template"]
    body_a = body0 + "\n# version A\n"
    r_a = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": body_a, "expected_sha256": sha0},
    )
    assert r_a.status_code == 200
    version_a_id = r_a.json()["version_id"]
    sha_a = r_a.json()["sha256"]

    body_b = body_a + "\n# version B\n"
    r_b = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": body_b, "expected_sha256": sha_a},
    )
    assert r_b.status_code == 200
    sha_b = r_b.json()["sha256"]

    rev = await api_client.post(
        "/prompts/templates/_writer_seo/revert",
        json={"target_version_id": version_a_id, "expected_sha256": sha_b},
    )
    assert rev.status_code == 200, rev.text
    assert rev.json()["sha256"] == sha_a

    async with pg_session_factory() as s:
        row = (
            await s.execute(
                select(PromptTemplate).where(
                    PromptTemplate.voice_slug == "bowtie-editor",
                    PromptTemplate.template_id == "_writer_seo",
                )
            )
        ).scalar_one()
    assert row.body == body_a

    h = await api_client.get("/prompts/templates/_writer_seo/history")
    versions = h.json()["versions"]
    # newest-first: revert row, then B, then A
    assert [v["kind"] for v in versions] == ["revert", "save", "save"]


@pytest.mark.asyncio
async def test_revert_stale_sha_409(
    api_client: AsyncClient, restore_template, clean_prompt_versions
):
    await restore_template("_writer_seo")
    g = await api_client.get("/prompts/templates/_writer_seo")
    sha0 = g.json()["sha256"]
    body0 = g.json()["template"]
    r = await api_client.put(
        "/prompts/templates/_writer_seo",
        json={"template": body0 + "\n# v1\n", "expected_sha256": sha0},
    )
    version_id = r.json()["version_id"]

    rev = await api_client.post(
        "/prompts/templates/_writer_seo/revert",
        json={"target_version_id": version_id, "expected_sha256": "0" * 64},
    )
    assert rev.status_code == 409
    assert rev.json()["detail"]["error"] == "stale_sha"


@pytest.mark.asyncio
async def test_revert_unknown_version_404(
    api_client: AsyncClient, restore_template, clean_prompt_versions
):
    await restore_template("_writer_seo")
    g = await api_client.get("/prompts/templates/_writer_seo")
    sha = g.json()["sha256"]
    rev = await api_client.post(
        "/prompts/templates/_writer_seo/revert",
        json={
            "target_version_id": "00000000-0000-0000-0000-000000000000",
            "expected_sha256": sha,
        },
    )
    assert rev.status_code == 404


# ---------------------------------------------------------------------------
# Per-voice scoping
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_templates_default_voice_and_shared_judges(api_client: AsyncClient):
    """Default voice (bowtie-editor) lists its agent/partial set; judges are a
    separate read-only group resolved under __shared__."""
    r = await api_client.get("/prompts/templates", params={"voice": "bowtie-editor"})
    assert r.status_code == 200
    body = r.json()
    assert body["voice"] == "bowtie-editor"
    # Every editable item resolves to a real row; bowtie-editor owns the full
    # backfilled set, so each entry is voice-owned (not a shared fallback).
    by_id = {i["template_id"]: i for i in body["templates"]}
    assert by_id["writer_small_refresh"]["voice_slug"] == "bowtie-editor"
    assert all(i["category"] in {"agent", "partial"} for i in body["templates"])
    # Judges are global + read-only.
    assert body["judges"], "expected shared judges in their own group"
    judge_ids = {j["template_id"] for j in body["judges"]}
    assert "judge_brand_voice" in judge_ids
    assert all(j["read_only"] is True for j in body["judges"])
    assert all(j["voice_slug"] == "__shared__" for j in body["judges"])


@pytest.mark.asyncio
async def test_get_template_shared_voice_is_seed_of_record(api_client: AsyncClient):
    """The __shared__ voice exposes the canonical seed-of-record rows."""
    r = await api_client.get(
        "/prompts/templates/writer_small_refresh", params={"voice": "__shared__"}
    )
    assert r.status_code == 200
    assert r.json()["voice_slug"] == "__shared__"


@pytest.mark.asyncio
async def test_put_judge_is_read_only_404(api_client: AsyncClient):
    """Judges ignore voice and are never editable here — PUT 404s for any voice."""
    for voice in ("bowtie-editor", "__shared__"):
        r = await api_client.put(
            "/prompts/templates/judge_brand_voice",
            params={"voice": voice},
            json={"template": "x", "expected_sha256": "0" * 64},
        )
        assert r.status_code == 404, (voice, r.text)


@pytest.mark.asyncio
async def test_edit_is_isolated_between_voices(
    api_client: AsyncClient,
    restore_template,
    clean_prompt_versions,
    duplicated_voice: str,
):
    """Editing a template under one voice must not touch another voice's row."""
    await restore_template("_writer_seo", "bowtie-editor")
    editor_before = (
        await api_client.get(
            "/prompts/templates/_writer_seo", params={"voice": "bowtie-editor"}
        )
    ).json()

    g = await api_client.get(
        "/prompts/templates/_writer_seo", params={"voice": duplicated_voice}
    )
    assert g.status_code == 200
    assert g.json()["voice_slug"] == duplicated_voice  # the clone owns its own row
    new_body = g.json()["template"] + "\n# dup-voice-only\n"
    r = await api_client.put(
        "/prompts/templates/_writer_seo",
        params={"voice": duplicated_voice},
        json={"template": new_body, "expected_sha256": g.json()["sha256"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["voice"] == duplicated_voice

    # The duplicate voice changed; bowtie-editor's row is untouched.
    dup_after = (
        await api_client.get(
            "/prompts/templates/_writer_seo", params={"voice": duplicated_voice}
        )
    ).json()
    editor_after = (
        await api_client.get(
            "/prompts/templates/_writer_seo", params={"voice": "bowtie-editor"}
        )
    ).json()
    assert dup_after["template"] == new_body
    assert editor_after["sha256"] == editor_before["sha256"]
    assert editor_after["template"] == editor_before["template"]


@pytest.mark.asyncio
async def test_history_and_stale_sha_scoped_per_voice(
    api_client: AsyncClient,
    restore_template,
    clean_prompt_versions,
    duplicated_voice: str,
):
    """History + the optimistic-concurrency token are per (voice, template)."""
    await restore_template("_writer_seo", "bowtie-editor")
    g = await api_client.get(
        "/prompts/templates/_writer_seo", params={"voice": duplicated_voice}
    )
    dup_sha = g.json()["sha256"]
    save = await api_client.put(
        "/prompts/templates/_writer_seo",
        params={"voice": duplicated_voice},
        json={"template": g.json()["template"] + "\n# v\n", "expected_sha256": dup_sha},
    )
    assert save.status_code == 200, save.text

    # History under the duplicate voice records the save (newest, chained off the
    # pre-save sha) on top of the seed version the duplicate endpoint stamped;
    # bowtie-editor's history for the same template stays empty (clean fixture).
    dup_hist = (
        await api_client.get(
            "/prompts/templates/_writer_seo/history", params={"voice": duplicated_voice}
        )
    ).json()
    assert dup_hist["voice"] == duplicated_voice
    assert dup_hist["versions"][0]["kind"] == "save"
    assert dup_hist["versions"][0]["parent_sha256"] == dup_sha
    editor_hist = (
        await api_client.get(
            "/prompts/templates/_writer_seo/history", params={"voice": "bowtie-editor"}
        )
    ).json()
    assert editor_hist["versions"] == []

    # The duplicate voice's sha moved; re-using the now-stale sha conflicts.
    stale = await api_client.put(
        "/prompts/templates/_writer_seo",
        params={"voice": duplicated_voice},
        json={"template": g.json()["template"] + "\n# again\n", "expected_sha256": dup_sha},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["error"] == "stale_sha"


@pytest.mark.asyncio
async def test_preview_resolves_voice_source_policy(
    api_client: AsyncClient, duplicated_voice: str
):
    """Preview for a voice substitutes that voice's source-policy block."""
    g = await api_client.get(
        "/prompts/templates/writer_small_refresh", params={"voice": duplicated_voice}
    )
    body = g.json()["template"]
    r = await api_client.post(
        "/prompts/templates/writer_small_refresh/preview",
        params={"voice": duplicated_voice},
        json={"template": body},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["voice"] == duplicated_voice
    assert "引用與資料來源規則" in payload["resolved"]
    assert "{source_policy_block}" not in payload["resolved"]
