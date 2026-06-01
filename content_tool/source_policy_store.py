"""DB-backed source-policy store — the runtime source of truth for the source policy.

Mirrors :mod:`content_tool.prompts_store`: a singleton ``'default'`` row in
``content_tool.source_policy`` holds the canonical compact JSON of the policy
object (``{deny, prefer, community_exception}``). The runtime (writer prompt
assembly + citation-domain evaluation) and the ``/prompts`` "Source Policy" tab
both read from here, so an edit reaches Gemini and the citation evaluator
without a redeploy.

Falls back to ``config/source_policy.yaml`` when the row is absent (e.g. the
migration has not been pushed yet) so the app still boots. The canonical
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
    return {
        "deny": {"domains": _clean_list(deny, "domains", lower=True)},
        "prefer": {
            "tlds": _clean_list(prefer, "tlds", lower=True),
            "domains": _clean_list(prefer, "domains", lower=True),
        },
        "community_exception": {
            "topic_categories": _clean_list(ce, "topic_categories", lower=True),
            "allowed_domains": _clean_list(ce, "allowed_domains", lower=True),
        },
    }


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
    """Immutable snapshot of the live source-policy row."""

    policy_id: str
    raw: dict[str, Any]
    body: str
    sha256: str
    bytes: int


# Module-level cache (same lifecycle contract as prompts_store): configure() at
# startup registers the session factory for standalone callers; invalidate()
# drops the snapshot after an editor save so this process serves the new policy
# immediately. Per-process cache — acceptable for a single FastAPI process.
_session_factory: async_sessionmaker[AsyncSession] | None = None
_cache: PolicySnapshot | None = None


def configure(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """Register the session factory used by the ``*_standalone`` helpers."""
    global _session_factory
    _session_factory = session_factory


def clear_cache() -> None:
    """Drop the in-process snapshot; the next read reloads from the DB."""
    global _cache
    _cache = None


def invalidate() -> None:
    """Invalidate the cached policy after an edit."""
    clear_cache()


def fallback_snapshot() -> PolicySnapshot:
    """Snapshot built from the bundled YAML when the DB row is absent."""
    try:
        with open(DEFAULT_POLICY_PATH, encoding="utf-8") as f:
            raw_obj = yaml.safe_load(f)
    except FileNotFoundError:
        raw_obj = {}
    raw: dict[str, Any] = cast("dict[str, Any]", raw_obj) if isinstance(raw_obj, dict) else {}
    cleaned = clean(raw)
    body = json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))
    return PolicySnapshot(
        policy_id=POLICY_ID,
        raw=cleaned,
        body=body,
        sha256=sha256_hex(body),
        bytes=len(body.encode("utf-8")),
    )


def snapshot_from_row(row: SourcePolicyRecord) -> PolicySnapshot:
    parsed = json.loads(row.body)
    raw: dict[str, Any] = cast("dict[str, Any]", parsed) if isinstance(parsed, dict) else {}
    return PolicySnapshot(
        policy_id=row.policy_id,
        raw=clean(raw),
        body=row.body,
        sha256=row.sha256,
        bytes=row.bytes,
    )


async def _load(session: AsyncSession) -> PolicySnapshot:
    row = (
        await session.execute(
            select(SourcePolicyRecord).where(SourcePolicyRecord.policy_id == POLICY_ID)
        )
    ).scalar_one_or_none()
    if row is None:
        return fallback_snapshot()
    return snapshot_from_row(row)


async def snapshot(session: AsyncSession) -> PolicySnapshot:
    """Return the live policy snapshot, loading + caching on first use."""
    global _cache
    if _cache is None:
        _cache = await _load(session)
    return _cache


async def _snapshot_standalone() -> PolicySnapshot:
    global _cache
    if _cache is not None:
        return _cache
    if _session_factory is None:
        raise RuntimeError(
            "source_policy_store is not configured; call configure(session_factory) at startup"
        )
    async with _session_factory() as session:
        _cache = await _load(session)
    return _cache


async def get_policy(*, session: AsyncSession) -> SourcePolicy:
    """The live :class:`SourcePolicy` (caller holds a session)."""
    return SourcePolicy((await snapshot(session)).raw)


async def get_policy_standalone() -> SourcePolicy:
    """The live :class:`SourcePolicy` (no caller session — opens from factory)."""
    return SourcePolicy((await _snapshot_standalone()).raw)
