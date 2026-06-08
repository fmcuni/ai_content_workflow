"""DB-backed source-policy store — the runtime source of truth for the source policy.

Mirrors :mod:`content_tool.prompts_store`: one row per voice in
``content_tool.source_policy`` (PK ``voice_slug``) holds the canonical compact
JSON of the policy object (``{deny, prefer, community_exception}``). The runtime
(writer prompt assembly + citation-domain evaluation) and the ``/prompts``
"Source Policy" tab both read from here, so an edit reaches Gemini and the
citation evaluator without a redeploy.

Per-voice resolution follows a strict fallback chain so a voice created before a
policy row existed (or any read during the deploy window) still resolves and the
app keeps booting::

    voice_slug  ->  '__shared__'  ->  config/source_policy.yaml

The reserved sentinel ``__shared__`` holds the seed-of-record. The canonical
serializer matches the TypeScript Workers serializer byte-for-byte, so the
``sha256`` optimistic-concurrency token and the rendered prompt block stay in
parity across both backends reading the same DB row.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, cast

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool.db.models import SourcePolicyRecord
from content_tool.policy.source_policy import DEFAULT_POLICY_PATH, SourcePolicy

# Reserved sentinel voice for the global / seed-of-record policy row. Mirrors the
# migration default and the Workers ``SHARED_VOICE``.
SHARED_VOICE = "__shared__"

# Retained only as the ``policy_id`` *history label* written into
# ``source_policy_versions`` (the live ``source_policy`` table no longer has a
# ``policy_id`` column — PK is ``voice_slug``). Kept importable so the Phase-4
# route module that still references it does not fail at import.
POLICY_ID = "default"


def _clean_list(section: dict[str, Any], key: str, *, lower: bool) -> list[str]:
    """Coerce ``section[key]`` to a list of trimmed (optionally lowercased)
    strings, dropping blanks and de-duplicating while preserving order.
    """
    raw = section.get(key, [])
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in cast(list[object], raw):
        s = str(item).strip()
        if lower:
            s = s.lower()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _section(raw: dict[str, Any], key: str) -> dict[str, Any]:
    val = raw.get(key, {})
    return cast("dict[str, Any]", val) if isinstance(val, dict) else {}


def clean(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalise an arbitrary policy mapping into the canonical structure.

    Lowercases + trims domains/TLDs/categories, drops blanks, de-dups, and
    enforces the fixed key order. Idempotent on already-clean input — the seed
    row therefore round-trips to the same bytes (and sha) it was created with.
    """
    deny = _section(raw, "deny")
    prefer = _section(raw, "prefer")
    ce = _section(raw, "community_exception")
    cleaned: dict[str, Any] = {
        "deny": {
            "domains": _clean_list(deny, "domains", lower=True),
            "tlds": _clean_list(deny, "tlds", lower=True),
        },
        "prefer": {
            "tlds": _clean_list(prefer, "tlds", lower=True),
            "domains": _clean_list(prefer, "domains", lower=True),
        },
        "community_exception": {
            "topic_categories": _clean_list(ce, "topic_categories", lower=True),
            "allowed_domains": _clean_list(ce, "allowed_domains", lower=True),
        },
    }
    # Optional editable prompt-block template. Trimmed and emitted ONLY when
    # non-empty, always as the LAST key, so policies without one round-trip to
    # the exact same bytes (and sha) as before this field existed. NOT lowercased
    # — it is 繁體中文 prose, unlike the domain/TLD lists. Mirrors the TS
    # ``cleanPolicy``.
    pb = raw.get("prompt_block")
    if isinstance(pb, str):
        pb = pb.strip()
        if pb:
            cleaned["prompt_block"] = pb
    return cleaned


def canonical_json(raw: dict[str, Any]) -> str:
    """Canonical compact JSON of a (cleaned) policy mapping.

    Matches Python ``json.dumps(separators=(",", ":"))`` and the TypeScript
    ``JSON.stringify`` of the same cleaned object — verified byte-identical.
    """
    return json.dumps(clean(raw), ensure_ascii=False, separators=(",", ":"))


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PolicySnapshot:
    """Immutable snapshot of one voice's live source-policy row."""

    voice_slug: str
    raw: dict[str, Any]
    body: str
    sha256: str
    bytes: int


# Module-level cache (same lifecycle contract as prompts_store): configure() at
# startup registers the session factory for standalone callers; invalidate()
# drops the snapshot after an editor save so this process serves the new policy
# immediately. Per-process cache — acceptable for a single FastAPI process.
_session_factory: async_sessionmaker[AsyncSession] | None = None
# Per-voice cache, keyed by the requested voice_slug (a voice that fell back to
# the shared row is cached under its own key so the next read is still one hop).
_cache: dict[str, PolicySnapshot] | None = None


def configure(session_factory: async_sessionmaker[AsyncSession] | None) -> None:
    """Register the session factory used by the ``*_standalone`` helpers.

    Pass ``None`` to de-register (e.g. test teardown after the engine is
    disposed) so a stale/disposed factory is never reused.
    """
    global _session_factory
    _session_factory = session_factory


def clear_cache() -> None:
    """Drop the in-process snapshot; the next read reloads from the DB."""
    global _cache
    _cache = None


def invalidate() -> None:
    """Invalidate the cached policy after an edit."""
    clear_cache()


def fallback_snapshot(voice_slug: str = SHARED_VOICE) -> PolicySnapshot:
    """Snapshot built from the bundled YAML when no DB row resolves."""
    try:
        with open(DEFAULT_POLICY_PATH, encoding="utf-8") as f:
            raw_obj = yaml.safe_load(f)
    except FileNotFoundError:
        raw_obj = {}
    raw: dict[str, Any] = cast("dict[str, Any]", raw_obj) if isinstance(raw_obj, dict) else {}
    cleaned = clean(raw)
    body = json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))
    return PolicySnapshot(
        voice_slug=voice_slug,
        raw=cleaned,
        body=body,
        sha256=sha256_hex(body),
        bytes=len(body.encode("utf-8")),
    )


def snapshot_from_row(row: SourcePolicyRecord) -> PolicySnapshot:
    parsed = json.loads(row.body)
    raw: dict[str, Any] = cast("dict[str, Any]", parsed) if isinstance(parsed, dict) else {}
    return PolicySnapshot(
        voice_slug=row.voice_slug,
        raw=clean(raw),
        body=row.body,
        sha256=row.sha256,
        bytes=row.bytes,
    )


async def _load_one(session: AsyncSession, voice_slug: str) -> PolicySnapshot | None:
    """Load exactly one voice's policy row, or ``None`` if it has none."""
    row = (
        await session.execute(
            select(SourcePolicyRecord).where(SourcePolicyRecord.voice_slug == voice_slug)
        )
    ).scalar_one_or_none()
    return snapshot_from_row(row) if row is not None else None


async def _resolve(session: AsyncSession, voice_slug: str) -> PolicySnapshot:
    """Resolve a voice's policy via ``voice -> __shared__ -> YAML``."""
    snap = await _load_one(session, voice_slug)
    if snap is None and voice_slug != SHARED_VOICE:
        snap = await _load_one(session, SHARED_VOICE)
    if snap is None:
        return fallback_snapshot(voice_slug)
    return snap


async def snapshot(*, voice_slug: str = SHARED_VOICE, session: AsyncSession) -> PolicySnapshot:
    """Return ``voice_slug``'s policy snapshot, loading + caching on first use."""
    global _cache
    if _cache is None:
        _cache = {}
    if voice_slug not in _cache:
        _cache[voice_slug] = await _resolve(session, voice_slug)
    return _cache[voice_slug]


async def _snapshot_standalone(voice_slug: str = SHARED_VOICE) -> PolicySnapshot:
    global _cache
    if _cache is None:
        _cache = {}
    if voice_slug in _cache:
        return _cache[voice_slug]
    if _session_factory is None:
        raise RuntimeError(
            "source_policy_store is not configured; call configure(session_factory) at startup"
        )
    async with _session_factory() as session:
        _cache[voice_slug] = await _resolve(session, voice_slug)
    return _cache[voice_slug]


async def get_policy(*, voice_slug: str = SHARED_VOICE, session: AsyncSession) -> SourcePolicy:
    """The live :class:`SourcePolicy` for ``voice_slug`` (caller holds a session)."""
    return SourcePolicy((await snapshot(voice_slug=voice_slug, session=session)).raw)


async def get_policy_standalone(voice_slug: str = SHARED_VOICE) -> SourcePolicy:
    """The live :class:`SourcePolicy` for ``voice_slug`` (opens from factory)."""
    return SourcePolicy((await _snapshot_standalone(voice_slug)).raw)
