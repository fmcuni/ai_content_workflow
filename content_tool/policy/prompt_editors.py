"""Lightweight allowlist for ``/prompts`` editor RBAC.

Mirrors the shape of :mod:`content_tool.policy.source_policy`: a small
dataclass loaded from YAML once at import time. ``dev_mode`` reads from
the ``PROMPT_EDITOR_DEV_MODE`` env var so CI and production can override
the file without editing it; tests toggle the same env var to exercise
the auth gate.

This is **not** real auth — it trusts an ``X-Editor-Email`` header set
by the reverse proxy in front of the API. When real OIDC lands the
``_require_editor`` dependency becomes a one-line swap.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

import yaml

DEFAULT_EDITORS_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "prompt_editors.yaml"
)


@dataclass
class PromptEditorPolicy:
    editors: set[str] = field(default_factory=set[str])
    _yaml_dev_mode: bool = True

    @classmethod
    def load_from(cls, path: str | Path) -> "PromptEditorPolicy":
        with open(path, encoding="utf-8") as f:
            raw_obj = yaml.safe_load(f)
        raw: dict[str, object] = (
            cast(dict[str, object], raw_obj) if isinstance(raw_obj, dict) else {}
        )
        editors_raw = raw.get("editors", [])
        editors: set[str] = (
            {str(e).strip().lower() for e in cast(list[object], editors_raw)}
            if isinstance(editors_raw, list)
            else set()
        )
        yaml_dev = bool(raw.get("dev_mode", True))
        return cls(editors=editors, _yaml_dev_mode=yaml_dev)

    @property
    def dev_mode(self) -> bool:
        """Resolve dev mode from env first, fall back to YAML.

        Reading on every call lets tests flip the gate without re-importing
        the module; cost is one ``os.environ`` lookup per write request,
        which is dwarfed by the disk + DB work that follows.
        """
        env = os.getenv("PROMPT_EDITOR_DEV_MODE")
        if env is not None:
            return env.strip().lower() not in {"false", "0", "no", ""}
        return self._yaml_dev_mode

    def is_allowed(self, email: str) -> bool:
        return email.strip().lower() in self.editors


_cached: PromptEditorPolicy | None = None


def load_policy(path: str | Path = DEFAULT_EDITORS_PATH) -> PromptEditorPolicy:
    """Cached loader. Tests can pass an override path or call ``reset()``."""
    global _cached
    if _cached is None:
        _cached = PromptEditorPolicy.load_from(path)
    return _cached


def reset() -> None:
    """Drop the cached policy — tests use this when they overwrite the file."""
    global _cached
    _cached = None
