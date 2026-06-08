"""Unit tests for the per-voice WordPress publish-target factory.

The DB-querying wrapper (`resolve_wp_target`) is exercised with a lightweight
fake session so these stay pure unit tests; the pure client builder
(`build_target_client`) is tested directly against in-memory ORM instances.
"""

from uuid import UUID, uuid4

import pytest

from content_tool.db.persona_model import Persona
from content_tool.db.publish_target_model import PublishTarget
from content_tool.publishers.wp_factory import (
    ResolvedTarget,
    build_target_client,
    resolve_wp_target,
)
from content_tool.wordpress.client import WordPressClient

_ENV = {
    "VHIS101_WP_BASE_URL": "https://vhis101.example.com",
    "VHIS101_WP_USERNAME": "editor",
    "VHIS101_WP_APP_PASSWORD": "secret-app-pw",
}


def _target(**kw: object) -> PublishTarget:
    base: dict[str, object] = {
        "publish_target_id": uuid4(),
        "name": "VHIS101 WordPress",
        "kind": "wordpress",
        "auth_ref": "VHIS101_WP",
        "is_archived": False,
    }
    base.update(kw)
    return PublishTarget(**base)


def test_build_target_client_reads_env_by_auth_ref_prefix() -> None:
    resolved = build_target_client(_target(), timeout=12.0, env=_ENV)

    assert isinstance(resolved.client, WordPressClient)
    assert resolved.is_default is False
    assert resolved.label == "VHIS101 WordPress"
    assert resolved.base_url == "https://vhis101.example.com"
    assert resolved.username == "editor"
    assert resolved.app_password == "secret-app-pw"  # noqa: S105
    assert resolved.client.base_url == "https://vhis101.example.com"


def test_build_target_client_raises_when_target_archived() -> None:
    with pytest.raises(ValueError, match="archived"):
        build_target_client(_target(is_archived=True), timeout=15.0, env=_ENV)


def test_build_target_client_raises_for_unsupported_kind() -> None:
    with pytest.raises(ValueError, match="kind"):
        build_target_client(_target(kind="ghost"), timeout=15.0, env=_ENV)


def test_build_target_client_raises_when_env_var_missing() -> None:
    partial = {k: v for k, v in _ENV.items() if not k.endswith("APP_PASSWORD")}
    with pytest.raises(EnvironmentError, match="VHIS101_WP_APP_PASSWORD"):
        build_target_client(_target(), timeout=15.0, env=partial)


class _FakeResult:
    def __init__(self, value: object) -> None:
        self._value = value

    def scalar_one_or_none(self) -> object:
        return self._value


class _FakeSession:
    """Minimal stand-in: `execute(...).scalar_one_or_none()` + `get(...)`."""

    def __init__(self, persona: Persona | None, target: PublishTarget | None) -> None:
        self._persona = persona
        self._target = target

    async def execute(self, _query: object) -> _FakeResult:
        return _FakeResult(self._persona)

    async def get(self, _model: object, _pk: object) -> PublishTarget | None:
        return self._target


def _default_client() -> WordPressClient:
    return WordPressClient(
        "https://www.bowtie.com.hk/blog", username="bowtie", app_password="pw"  # noqa: S106
    )


async def test_resolve_returns_default_when_persona_slug_is_none() -> None:
    default = _default_client()
    resolved = await resolve_wp_target(
        session=_FakeSession(None, None),  # type: ignore[arg-type]
        persona_slug=None,
        default_client=default,
        default_label="Bowtie WordPress",
        env=_ENV,
    )
    assert resolved == ResolvedTarget(
        client=default, label="Bowtie WordPress", is_default=True
    )


async def test_resolve_returns_default_when_persona_has_no_target() -> None:
    default = _default_client()
    persona = Persona(slug="bowtie-editor", publish_target_id=None)
    resolved = await resolve_wp_target(
        session=_FakeSession(persona, None),  # type: ignore[arg-type]
        persona_slug="bowtie-editor",
        default_client=default,
        default_label="Bowtie WordPress",
        env=_ENV,
    )
    assert resolved.is_default is True
    assert resolved.client is default


async def test_resolve_builds_client_for_assigned_target() -> None:
    target = _target()
    persona = Persona(slug="vhis101", publish_target_id=target.publish_target_id)
    resolved = await resolve_wp_target(
        session=_FakeSession(persona, target),  # type: ignore[arg-type]
        persona_slug="vhis101",
        default_client=_default_client(),
        default_label="Bowtie WordPress",
        env=_ENV,
    )
    assert resolved.is_default is False
    assert resolved.label == "VHIS101 WordPress"
    assert resolved.client.base_url == "https://vhis101.example.com"


async def test_resolve_raises_when_referenced_target_missing() -> None:
    missing_id: UUID = uuid4()
    persona = Persona(slug="vhis101", publish_target_id=missing_id)
    with pytest.raises(ValueError, match="not found"):
        await resolve_wp_target(
            session=_FakeSession(persona, None),  # type: ignore[arg-type]
            persona_slug="vhis101",
            default_client=_default_client(),
            default_label="Bowtie WordPress",
            env=_ENV,
        )
