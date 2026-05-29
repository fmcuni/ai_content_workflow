"""Local JSON config store for the desktop app.

Persists non-repo configuration (Supabase URL, Gemini key, optional WordPress
credentials) to a single JSON file outside the repository. Secret *values* are
never written to logs.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, cast

from content_tool.config import desktop_config_path

logger = logging.getLogger(__name__)

# Owner read/write only — basic hygiene for a file that may hold an API key.
_FILE_MODE = 0o600


class DesktopConfigStore:
    """Atomic load/save of the desktop config JSON file."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or desktop_config_path()

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> dict[str, Any]:
        """Return parsed config, or ``{}`` when absent/unreadable/invalid."""
        if not self._path.is_file():
            return {}
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("desktop config unreadable or invalid JSON; treating as empty")
            return {}
        if not isinstance(data, dict):
            logger.warning("desktop config is not a JSON object; treating as empty")
            return {}
        return cast("dict[str, Any]", data)

    def save(self, values: dict[str, Any]) -> None:
        """Atomically write ``values`` as JSON with owner-only permissions."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(self._path.name + ".tmp")
        tmp.write_text(json.dumps(values, indent=2, ensure_ascii=False), encoding="utf-8")
        os.chmod(tmp, _FILE_MODE)
        os.replace(tmp, self._path)
        os.chmod(self._path, _FILE_MODE)
        logger.info("desktop config saved (%d keys)", len(values))
