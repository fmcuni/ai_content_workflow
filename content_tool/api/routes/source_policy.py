"""Editable source-policy API — the structured rules behind ``{source_policy_block}``.

Mirrors ``routes/prompts.py`` for a singleton document: GET the live policy, PUT
a structured edit (validated + optimistic-concurrency gated + version-stamped),
preview the rendered prompt block without saving, browse history, and revert.

The policy drives two things at runtime: the ``{source_policy_block}`` text
injected into the writer prompts, and the citation-domain evaluation
(``deny``/``prefer``/community exception). Both backends read the same DB row,
so an edit here changes both behaviours without a redeploy.
"""

import json
from typing import Any, cast
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from content_tool import source_policy_store
from content_tool.api.editor_auth import require_editor
from content_tool.db.models import SourcePolicyRecord, SourcePolicyVersion
from content_tool.policy.source_policy import SourcePolicy
from content_tool.source_policy_store import POLICY_ID, SHARED_VOICE

router = APIRouter(prefix="/source-policy", tags=["source-policy"])

# Default voice when the caller omits ``?voice=``. Each voice has its own policy
# row; a voice with none falls back to the ``__shared__`` seed (SHARED_VOICE).
DEFAULT_VOICE = "bowtie-editor"

_MAX_POLICY_BYTES = 64 * 1024
_LIST_FIELDS = (
    ("deny", "domains"),
    ("deny", "tlds"),
    ("prefer", "tlds"),
    ("prefer", "domains"),
    ("community_exception", "topic_categories"),
    ("community_exception", "allowed_domains"),
)


def _get_session_factory(request: Request) -> async_sessionmaker[Any]:
    return request.app.state.session_factory  # type: ignore[no-any-return]


def _validate_policy(policy: dict[str, Any]) -> dict[str, Any]:
    """Reject anything that isn't a well-formed policy object.

    Sections, when present, must be objects; their known list fields, when
    present, must be arrays of strings. Empty lists are allowed — Bowtie domains
    stay blocked regardless via the hard-coded rule in ``SourcePolicy``.
    (Pydantic already guarantees the top level is an object.)
    """
    for section_key in ("deny", "prefer", "community_exception"):
        if section_key in policy and not isinstance(policy[section_key], dict):
            raise HTTPException(
                400,
                {"error": "invalid_policy", "message": f"'{section_key}' must be an object"},
            )
    for section_key, field_key in _LIST_FIELDS:
        section = policy.get(section_key)
        if not isinstance(section, dict):
            continue
        value = cast("dict[str, Any]", section).get(field_key)
        if value is None:
            continue
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in cast("list[Any]", value)
        ):
            raise HTTPException(
                400,
                {
                    "error": "invalid_policy",
                    "message": f"'{section_key}.{field_key}' must be an array of strings",
                },
            )
    pb = policy.get("prompt_block")
    if pb is not None and not isinstance(pb, str):
        raise HTTPException(
            400,
            {"error": "invalid_policy", "message": "'prompt_block' must be a string"},
        )
    return policy


def _snapshot_payload(snap: source_policy_store.PolicySnapshot, voice: str) -> dict[str, Any]:
    return {
        "voice": voice,
        "voice_slug": snap.voice_slug,
        "policy": snap.raw,
        "sha256": snap.sha256,
        "bytes": snap.bytes,
        "rendered": SourcePolicy(snap.raw).to_prompt_block(),
    }


@router.get("")
async def get_source_policy(
    voice: str = Query(DEFAULT_VOICE),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """The voice's live source policy + its rendered prompt block + sha256 token.

    Resolves ``voice -> __shared__ -> bundled YAML``; ``voice_slug`` in the
    response reveals which row actually answered (a shared fallback for a voice
    that has not customised its policy).
    """
    async with sf() as session:
        snap = await source_policy_store.snapshot(voice_slug=voice, session=session)
    return _snapshot_payload(snap, voice)


class _PreviewRequest(BaseModel):
    policy: dict[str, Any]


@router.post("/preview")
async def preview_source_policy(
    body: _PreviewRequest,
    voice: str = Query(DEFAULT_VOICE),
) -> dict[str, Any]:
    """Render the prompt block from a candidate policy without saving it.

    Stateless and voice-independent (it neither reads nor writes a DB row); the
    ``voice`` query param is accepted only so every ``/source-policy*`` endpoint
    shares one signature.
    """
    policy = _validate_policy(body.policy)
    cleaned = source_policy_store.clean(policy)
    return {"policy": cleaned, "rendered": SourcePolicy(cleaned).to_prompt_block()}


class _SaveRequest(BaseModel):
    policy: dict[str, Any]
    expected_sha256: str = Field(..., min_length=64, max_length=64)


@router.put("")
async def save_source_policy(
    body: _SaveRequest,
    voice: str = Query(DEFAULT_VOICE),
    editor: str = Depends(require_editor),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """Validate + persist a structured policy edit for ``voice``, stamping a version.

    HTTP 400 if the policy is malformed.
    HTTP 409 if ``expected_sha256`` no longer matches the live (or fallback) row.
    HTTP 413 if the canonical body exceeds the 64 KiB cap.

    The UPSERT and the version INSERT commit in one transaction; the voice's row
    is locked ``FOR UPDATE`` to serialise concurrent saves. When the voice has no
    row yet (it had been resolving the ``__shared__`` fallback) the save creates
    one. After commit the in-process cache is invalidated so this worker serves
    the new policy.
    """
    cleaned = source_policy_store.clean(_validate_policy(body.policy))
    new_body = source_policy_store.canonical_json(cleaned)
    new_bytes = new_body.encode("utf-8")
    new_sha = source_policy_store.sha256_hex(new_body)
    version_id = uuid4()

    if len(new_bytes) > _MAX_POLICY_BYTES:
        raise HTTPException(413, f"policy exceeds {_MAX_POLICY_BYTES} bytes (got {len(new_bytes)})")

    async with sf() as session:
        row = (
            await session.execute(
                select(SourcePolicyRecord)
                .where(SourcePolicyRecord.voice_slug == voice)
                .with_for_update()
            )
        ).scalar_one_or_none()
        # Optimistic concurrency: compare against the voice's live row, else the
        # baseline the GET would have shown — the shared seed row, or the bundled
        # YAML fallback. A mismatch means another editor saved meanwhile.
        current_sha = await _baseline_sha(session, voice, row)
        if current_sha != body.expected_sha256:
            raise HTTPException(
                409,
                {
                    "error": "stale_sha",
                    "message": "source policy was changed since you loaded it",
                    "current_sha256": current_sha,
                },
            )
        parent_sha = row.sha256 if row is not None else None

        if row is None:
            row = SourcePolicyRecord(voice_slug=voice)
            session.add(row)
        row.body = new_body
        row.sha256 = new_sha
        row.bytes = len(new_bytes)
        row.updated_by = editor
        version = SourcePolicyVersion(
            version_id=version_id,
            voice_slug=voice,
            policy_id=POLICY_ID,
            sha256=new_sha,
            parent_sha256=parent_sha,
            body=new_body,
            bytes=len(new_bytes),
            saved_by=editor,
            kind="save",
        )
        session.add(version)
        await session.commit()
        await session.refresh(version, attribute_names=["saved_at"])
        saved_at = version.saved_at

    source_policy_store.invalidate()

    return {
        "voice": voice,
        "policy": cleaned,
        "sha256": new_sha,
        "bytes": len(new_bytes),
        "rendered": SourcePolicy(cleaned).to_prompt_block(),
        "version_id": str(version_id),
        "saved_at": saved_at.isoformat(),
        "saved_by": editor,
    }


async def _baseline_sha(
    session: AsyncSession, voice: str, row: SourcePolicyRecord | None
) -> str:
    """sha256 the GET for ``voice`` would have returned (for the concurrency gate).

    Mirrors the loader's ``voice -> __shared__ -> bundled YAML`` resolution
    without touching the in-process cache: the voice's own row if present, else
    the shared seed row, else the bundled-config fallback.
    """
    if row is not None:
        return row.sha256
    if voice != SHARED_VOICE:
        shared = (
            await session.execute(
                select(SourcePolicyRecord).where(SourcePolicyRecord.voice_slug == SHARED_VOICE)
            )
        ).scalar_one_or_none()
        if shared is not None:
            return shared.sha256
    return source_policy_store.fallback_snapshot(voice).sha256


@router.get("/history")
async def source_policy_history(
    voice: str = Query(DEFAULT_VOICE),
    limit: int = Query(50, ge=1, le=200),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """Newest-first saves + reverts for ``voice`` (bodies omitted to stay small)."""
    async with sf() as session:
        live_row = (
            await session.execute(
                select(SourcePolicyRecord).where(SourcePolicyRecord.voice_slug == voice)
            )
        ).scalar_one_or_none()
        # The sha the GET would show (voice row → __shared__ → bundled fallback);
        # the matching history row is flagged `is_current` (the "● Live" entry).
        current_sha = await _baseline_sha(session, voice, live_row)
        total = (
            await session.execute(
                select(func.count())
                .select_from(SourcePolicyVersion)
                .where(SourcePolicyVersion.voice_slug == voice)
            )
        ).scalar_one()
        rows = (
            (
                await session.execute(
                    select(SourcePolicyVersion)
                    .where(SourcePolicyVersion.voice_slug == voice)
                    .order_by(SourcePolicyVersion.saved_at.desc())
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
    return {
        "voice": voice,
        "current_sha256": current_sha,
        "versions": [
            {
                "version_id": str(r.version_id),
                "version_number": total - i,
                "is_current": r.sha256 == current_sha,
                "sha256": r.sha256,
                "parent_sha256": r.parent_sha256,
                "bytes": r.bytes,
                "saved_by": r.saved_by,
                "saved_at": r.saved_at.isoformat(),
                "kind": r.kind,
                "note": r.note,
            }
            for i, r in enumerate(rows)
        ],
    }


@router.get("/versions/{version_id}")
async def source_policy_version(
    version_id: UUID,
    voice: str = Query(DEFAULT_VOICE),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """One version's full policy + metadata (used by the revert preview).

    Scoped to ``voice`` so a stray UUID for a different voice returns 404 rather
    than leaking another voice's policy body.
    """
    async with sf() as session:
        row = (
            await session.execute(
                select(SourcePolicyVersion).where(
                    SourcePolicyVersion.version_id == version_id,
                    SourcePolicyVersion.voice_slug == voice,
                )
            )
        ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, f"unknown version_id '{version_id}'")
    raw = source_policy_store.clean(_loads(row.body))
    return {
        "version_id": str(row.version_id),
        "voice": row.voice_slug,
        "policy_id": row.policy_id,
        "sha256": row.sha256,
        "parent_sha256": row.parent_sha256,
        "policy": raw,
        "rendered": SourcePolicy(raw).to_prompt_block(),
        "bytes": row.bytes,
        "saved_by": row.saved_by,
        "saved_at": row.saved_at.isoformat(),
        "kind": row.kind,
        "note": row.note,
    }


class _RevertRequest(BaseModel):
    target_version_id: UUID
    expected_sha256: str = Field(..., min_length=64, max_length=64)


@router.post("/revert")
async def revert_source_policy(
    body: _RevertRequest,
    voice: str = Query(DEFAULT_VOICE),
    editor: str = Depends(require_editor),
    sf: async_sessionmaker[Any] = Depends(_get_session_factory),  # noqa: B008
) -> dict[str, Any]:
    """Restore ``voice``'s live policy to a past version (stamped as revert)."""
    version_id = uuid4()

    async with sf() as session:
        row = (
            await session.execute(
                select(SourcePolicyRecord)
                .where(SourcePolicyRecord.voice_slug == voice)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(404, "source policy not initialised")
        current_sha = row.sha256
        if current_sha != body.expected_sha256:
            raise HTTPException(
                409,
                {
                    "error": "stale_sha",
                    "message": "source policy was changed since you loaded it",
                    "current_sha256": current_sha,
                },
            )

        target = (
            await session.execute(
                select(SourcePolicyVersion).where(
                    SourcePolicyVersion.version_id == body.target_version_id,
                    SourcePolicyVersion.voice_slug == voice,
                )
            )
        ).scalar_one_or_none()
        if target is None:
            raise HTTPException(404, f"unknown version_id '{body.target_version_id}'")

        new_body = target.body
        new_bytes = new_body.encode("utf-8")
        new_sha = source_policy_store.sha256_hex(new_body)
        row.body = new_body
        row.sha256 = new_sha
        row.bytes = len(new_bytes)
        row.updated_by = editor
        version = SourcePolicyVersion(
            version_id=version_id,
            voice_slug=voice,
            policy_id=POLICY_ID,
            sha256=new_sha,
            parent_sha256=current_sha,
            body=new_body,
            bytes=len(new_bytes),
            saved_by=editor,
            kind="revert",
        )
        session.add(version)
        await session.commit()
        await session.refresh(version, attribute_names=["saved_at"])
        saved_at = version.saved_at

    source_policy_store.invalidate()
    cleaned = source_policy_store.clean(_loads(new_body))
    return {
        "voice": voice,
        "policy": cleaned,
        "sha256": new_sha,
        "bytes": len(new_bytes),
        "rendered": SourcePolicy(cleaned).to_prompt_block(),
        "version_id": str(version_id),
        "saved_at": saved_at.isoformat(),
        "saved_by": editor,
        "reverted_from_version_id": str(body.target_version_id),
    }


def _loads(text: str) -> dict[str, Any]:
    parsed = json.loads(text)
    return cast("dict[str, Any]", parsed) if isinstance(parsed, dict) else {}
