"""Resolve the WordPress publish target for a run from its voice (persona).

Phase 1 supports multiple WordPress instances. A voice maps to a
``publish_targets`` row via ``personas.publish_target_id``; the row carries an
``auth_ref`` env-var prefix from which the base URL + credentials are read at
publish time (``{auth_ref}_BASE_URL`` / ``_USERNAME`` / ``_APP_PASSWORD``).
Secrets never live in the database.

A voice with no assigned target (NULL FK) — and any pre-existing run — resolves
to the process-default client built from the legacy ``WP_*`` settings, so
behaviour is unchanged until a voice is explicitly pointed elsewhere.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from content_tool.db.persona_model import Persona
from content_tool.db.publish_target_model import PublishTarget
from content_tool.wordpress.client import WordPressClient

# Phase 1 ships WordPress only; widen when Ghost lands (mirrors the DB CHECK).
_SUPPORTED_KINDS = frozenset({"wordpress"})


@dataclass(frozen=True)
class ResolvedTarget:
    """The WordPress client a run should publish through, plus its display label.

    ``base_url`` / ``username`` / ``app_password`` are populated only for
    non-default targets so the caller can build a matching SEO-plugin resolver
    against that instance. For the default target the caller keeps using its
    existing (process-level) SEO resolver.
    """

    client: WordPressClient | None
    label: str
    is_default: bool
    base_url: str | None = None
    username: str | None = None
    app_password: str | None = None


def _require_env(env: Mapping[str, str], key: str) -> str:
    value = env.get(key)
    if not value:
        raise OSError(
            f"publish target requires env var {key!r}, which is not set"
        )
    return value


def build_target_client(
    target: PublishTarget,
    *,
    timeout: float,
    env: Mapping[str, str],
) -> ResolvedTarget:
    """Build a :class:`ResolvedTarget` from a publish-target row + env creds.

    Pure (no DB / no process env unless ``env`` is ``os.environ``). Raises
    ``ValueError`` for an archived or unsupported-kind target and
    ``EnvironmentError`` when a required credential env var is absent.
    """
    if target.is_archived:
        raise ValueError(
            f"publish target {target.name!r} is archived and cannot be used"
        )
    if target.kind not in _SUPPORTED_KINDS:
        raise ValueError(
            f"unsupported publish target kind {target.kind!r} "
            f"(supported: {sorted(_SUPPORTED_KINDS)})"
        )
    ref = target.auth_ref
    base_url = _require_env(env, f"{ref}_BASE_URL")
    username = _require_env(env, f"{ref}_USERNAME")
    app_password = _require_env(env, f"{ref}_APP_PASSWORD")
    client = WordPressClient(
        base_url, username=username, app_password=app_password, timeout=timeout
    )
    return ResolvedTarget(
        client=client,
        label=target.name,
        is_default=False,
        base_url=base_url,
        username=username,
        app_password=app_password,
    )


async def resolve_wp_target(
    *,
    session: AsyncSession,
    persona_slug: str | None,
    default_client: WordPressClient | None,
    default_label: str,
    timeout: float = 15.0,  # noqa: ASYNC109 — WP client config, not an async cancel budget
    env: Mapping[str, str] | None = None,
) -> ResolvedTarget:
    """Resolve the publish target for a voice.

    NULL/unknown voice or unassigned target → the process-default client.
    An assigned, active target → a client built from its ``auth_ref`` env creds.
    Raises ``ValueError`` if the voice references a missing/archived target and
    ``EnvironmentError`` if its credential env vars are absent.
    """
    resolved_env: Mapping[str, str] = env if env is not None else os.environ
    default = ResolvedTarget(
        client=default_client, label=default_label, is_default=True
    )
    if not persona_slug:
        return default

    persona = (
        await session.execute(select(Persona).where(Persona.slug == persona_slug))
    ).scalar_one_or_none()
    if persona is None or persona.publish_target_id is None:
        return default

    target = await session.get(PublishTarget, persona.publish_target_id)
    if target is None:
        raise ValueError(
            f"publish target {persona.publish_target_id} referenced by voice "
            f"{persona_slug!r} was not found"
        )
    return build_target_client(target, timeout=timeout, env=resolved_env)
