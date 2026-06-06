import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool import source_policy_store

# The voice the /source-policy endpoints edit when ?voice= is omitted.
_DEFAULT_VOICE = "bowtie-editor"


@pytest_asyncio.fixture(autouse=True)
async def reset_source_policy(
    pg_session_factory: async_sessionmaker[AsyncSession],
):
    """Restore the per-voice policy rows to the bundled seed + drop history.

    Every test in this module mutates a voice's row and the in-process cache, so
    reset the default voice (and the shared seed it falls back to) to a known
    baseline before and after each one.
    """

    async def _reset() -> None:
        seed = source_policy_store.fallback_snapshot()
        async with pg_session_factory() as s:
            await s.execute(text("TRUNCATE TABLE content_tool.source_policy_versions"))
            await s.execute(
                text(
                    "UPDATE content_tool.source_policy "
                    "SET body = :body, sha256 = :sha, bytes = :bytes, updated_by = NULL "
                    "WHERE voice_slug IN ('__shared__', :voice)"
                ),
                {
                    "body": seed.body,
                    "sha": seed.sha256,
                    "bytes": seed.bytes,
                    "voice": _DEFAULT_VOICE,
                },
            )
            await s.commit()
        source_policy_store.clear_cache()

    await _reset()
    yield
    await _reset()


@pytest.mark.asyncio
async def test_get_returns_policy_and_rendered_block(api_client: AsyncClient):
    r = await api_client.get("/source-policy")
    assert r.status_code == 200
    body = r.json()
    assert body["voice"] == _DEFAULT_VOICE
    assert body["voice_slug"] == _DEFAULT_VOICE
    assert len(body["sha256"]) == 64
    # Seeded competitor + authority lists are present.
    assert "manulife.com.hk" in body["policy"]["deny"]["domains"]
    assert "who.int" in body["policy"]["prefer"]["domains"]
    # Rendered block is the 繁體中文 source-policy guidance.
    assert "引用與資料來源規則" in body["rendered"]
    assert "manulife.com.hk" not in body["rendered"]  # deny list isn't dumped verbatim


@pytest.mark.asyncio
async def test_preview_renders_without_saving(api_client: AsyncClient):
    before = (await api_client.get("/source-policy")).json()
    policy = {
        "deny": {"domains": ["competitor.example"]},
        "prefer": {"tlds": [".gov.hk"], "domains": ["who.int"]},
        "community_exception": {"topic_categories": [], "allowed_domains": []},
    }
    r = await api_client.post("/source-policy/preview", json={"policy": policy})
    assert r.status_code == 200
    body = r.json()
    assert "引用與資料來源規則" in body["rendered"]
    # Preview must not mutate the stored policy.
    after = (await api_client.get("/source-policy")).json()
    assert after["sha256"] == before["sha256"]


@pytest.mark.asyncio
async def test_save_updates_policy_and_records_version(api_client: AsyncClient):
    current = (await api_client.get("/source-policy")).json()
    new_policy = dict(current["policy"])
    new_policy["deny"] = {"domains": [*current["policy"]["deny"]["domains"], "newco.com.hk"]}

    r = await api_client.put(
        "/source-policy",
        json={"policy": new_policy, "expected_sha256": current["sha256"]},
    )
    assert r.status_code == 200
    saved = r.json()
    assert saved["sha256"] != current["sha256"]
    assert "newco.com.hk" in saved["policy"]["deny"]["domains"]

    # The change is now the live policy.
    reread = (await api_client.get("/source-policy")).json()
    assert "newco.com.hk" in reread["policy"]["deny"]["domains"]
    assert reread["sha256"] == saved["sha256"]

    # And a save version was recorded.
    hist = (await api_client.get("/source-policy/history")).json()
    assert len(hist["versions"]) == 1
    assert hist["versions"][0]["kind"] == "save"


@pytest.mark.asyncio
async def test_save_lowercases_and_dedupes_domains(api_client: AsyncClient):
    current = (await api_client.get("/source-policy")).json()
    new_policy = {
        "deny": {"domains": ["Manulife.com.HK", "manulife.com.hk", "  AXA.com.hk "]},
        "prefer": {"tlds": [], "domains": []},
        "community_exception": {"topic_categories": [], "allowed_domains": []},
    }
    r = await api_client.put(
        "/source-policy",
        json={"policy": new_policy, "expected_sha256": current["sha256"]},
    )
    assert r.status_code == 200
    domains = r.json()["policy"]["deny"]["domains"]
    assert domains == ["manulife.com.hk", "axa.com.hk"]


@pytest.mark.asyncio
async def test_stale_sha_conflicts(api_client: AsyncClient):
    current = (await api_client.get("/source-policy")).json()
    bogus = "0" * 64
    r = await api_client.put(
        "/source-policy",
        json={"policy": current["policy"], "expected_sha256": bogus},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "stale_sha"


@pytest.mark.asyncio
async def test_invalid_policy_rejected(api_client: AsyncClient):
    current = (await api_client.get("/source-policy")).json()
    bad = {"deny": {"domains": "not-a-list"}}
    r = await api_client.put(
        "/source-policy",
        json={"policy": bad, "expected_sha256": current["sha256"]},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "invalid_policy"


@pytest.mark.asyncio
async def test_revert_restores_prior_version(api_client: AsyncClient):
    base = (await api_client.get("/source-policy")).json()

    # Save a change, capturing the version_id of the baseline-to-changed save.
    changed = dict(base["policy"])
    changed["prefer"] = {"tlds": [".gov.hk"], "domains": ["who.int", "newauth.org"]}
    saved = (
        await api_client.put(
            "/source-policy",
            json={"policy": changed, "expected_sha256": base["sha256"]},
        )
    ).json()
    assert "newauth.org" in saved["policy"]["prefer"]["domains"]

    # The first save's parent is the baseline sha; revert to that save then
    # confirm we can roll the live row back via a fresh version.
    hist = (await api_client.get("/source-policy/history")).json()
    target = hist["versions"][0]["version_id"]

    # Mutate again so revert has something to undo.
    second = dict(saved["policy"])
    second["prefer"] = {"tlds": [], "domains": []}
    after_second = (
        await api_client.put(
            "/source-policy",
            json={"policy": second, "expected_sha256": saved["sha256"]},
        )
    ).json()

    r = await api_client.post(
        "/source-policy/revert",
        json={"target_version_id": target, "expected_sha256": after_second["sha256"]},
    )
    assert r.status_code == 200
    reverted = r.json()
    assert reverted["reverted_from_version_id"] == target
    assert "newauth.org" in reverted["policy"]["prefer"]["domains"]


# ---------------------------------------------------------------------------
# Per-voice scoping
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_voice_falls_back_to_shared(api_client: AsyncClient):
    """A voice with no policy row resolves the __shared__ seed (and says so)."""
    r = await api_client.get("/source-policy", params={"voice": "ghost-voice"})
    assert r.status_code == 200
    body = r.json()
    assert body["voice"] == "ghost-voice"
    assert body["voice_slug"] == "__shared__"  # resolved via fallback


@pytest.mark.asyncio
async def test_save_is_isolated_between_voices(
    api_client: AsyncClient, duplicated_voice: str
):
    """Saving a voice's policy must not mutate another voice's policy."""
    editor_before = (await api_client.get("/source-policy")).json()

    dup = (await api_client.get("/source-policy", params={"voice": duplicated_voice})).json()
    assert dup["voice_slug"] == duplicated_voice  # the clone owns its own row
    new_policy = dict(dup["policy"])
    new_policy["deny"] = {"domains": [*dup["policy"]["deny"]["domains"], "dup-only.example"]}
    saved = await api_client.put(
        "/source-policy",
        params={"voice": duplicated_voice},
        json={"policy": new_policy, "expected_sha256": dup["sha256"]},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["voice"] == duplicated_voice
    assert "dup-only.example" in saved.json()["policy"]["deny"]["domains"]

    # The duplicate voice changed; bowtie-editor's policy is untouched.
    editor_after = (await api_client.get("/source-policy")).json()
    assert editor_after["sha256"] == editor_before["sha256"]
    assert "dup-only.example" not in editor_after["policy"]["deny"]["domains"]

    # And the duplicate voice's history records the save (newest) on top of the
    # seed version the duplicate endpoint stamped, all under its own voice.
    dup_hist = (
        await api_client.get("/source-policy/history", params={"voice": duplicated_voice})
    ).json()
    assert dup_hist["voice"] == duplicated_voice
    assert dup_hist["versions"][0]["kind"] == "save"
    assert dup_hist["versions"][0]["sha256"] == saved.json()["sha256"]
