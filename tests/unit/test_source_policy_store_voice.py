"""Unit tests for per-voice resolution in :mod:`content_tool.source_policy_store`.

Covers the leaf helpers (YAML fallback snapshot, row -> snapshot) and the
``voice -> __shared__ -> YAML`` fallback ordering of :func:`snapshot` with
``_load_one`` monkeypatched so no database is required.
"""

from __future__ import annotations

import pytest

from content_tool import source_policy_store
from content_tool.source_policy_store import SHARED_VOICE, PolicySnapshot


def test_clean_canonical_includes_deny_tlds_in_fixed_order() -> None:
    # deny.tlds is normalised (trim+lowercase+dedup) and serialised right after
    # deny.domains. The exact byte order must match the TS canonicalPolicyJson so
    # the cross-backend sha256 token stays portable.
    out = source_policy_store.clean({"deny": {"tlds": [" .CN ", ".cn", "RU"]}})
    assert out["deny"] == {"domains": [], "tlds": [".cn", "ru"]}
    assert source_policy_store.canonical_json({"deny": {"tlds": [".cn"]}}) == (
        '{"deny":{"domains":[],"tlds":[".cn"]},'
        '"prefer":{"tlds":[],"domains":[]},'
        '"community_exception":{"topic_categories":[],"allowed_domains":[]}}'
    )


def test_clean_keeps_nonempty_prompt_block_as_last_key() -> None:
    # The editable template is trimmed, kept only when non-empty, and serialised
    # last so default rows stay byte-identical. Must match the TS cleanPolicy.
    out = source_policy_store.clean({"prompt_block": "  只有這一行。  "})
    assert out["prompt_block"] == "只有這一行。"
    assert source_policy_store.canonical_json({"prompt_block": "只有這一行。"}) == (
        '{"deny":{"domains":[],"tlds":[]},'
        '"prefer":{"tlds":[],"domains":[]},'
        '"community_exception":{"topic_categories":[],"allowed_domains":[]},'
        '"prompt_block":"只有這一行。"}'
    )


def test_clean_drops_empty_prompt_block() -> None:
    out = source_policy_store.clean({"prompt_block": "   "})
    assert "prompt_block" not in out


def test_fallback_snapshot_reads_yaml_and_carries_voice() -> None:
    snap = source_policy_store.fallback_snapshot("ghost-voice")
    assert snap.voice_slug == "ghost-voice"
    # The bundled config/source_policy.yaml denies bowtie.com.hk.
    assert "bowtie.com.hk" in snap.body
    # body is the canonical compact JSON of the cleaned policy.
    assert snap.body == source_policy_store.canonical_json(snap.raw)
    assert snap.sha256 == source_policy_store.sha256_hex(snap.body)


@pytest.mark.asyncio
async def test_snapshot_falls_back_voice_to_shared(monkeypatch: pytest.MonkeyPatch) -> None:
    shared = PolicySnapshot(
        voice_slug=SHARED_VOICE,
        raw={"deny": {"domains": ["shared.example"]}},
        body='{"deny":{"domains":["shared.example"]}}',
        sha256="sha-shared",
        bytes=10,
    )

    async def _fake_load_one(session: object, voice_slug: str) -> PolicySnapshot | None:
        return shared if voice_slug == SHARED_VOICE else None

    monkeypatch.setattr(source_policy_store, "_load_one", _fake_load_one)
    source_policy_store.clear_cache()

    snap = await source_policy_store.snapshot(voice_slug="missing-voice", session=object())
    assert snap is shared


@pytest.mark.asyncio
async def test_snapshot_falls_back_shared_to_yaml(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _none(session: object, voice_slug: str) -> PolicySnapshot | None:
        return None

    monkeypatch.setattr(source_policy_store, "_load_one", _none)
    source_policy_store.clear_cache()

    snap = await source_policy_store.snapshot(voice_slug="any-voice", session=object())
    # Falls all the way to the bundled YAML, tagged with the requested voice.
    assert snap.voice_slug == "any-voice"
    assert "bowtie.com.hk" in snap.body
