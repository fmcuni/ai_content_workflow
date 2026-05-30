"""Uvicorn entrypoint for the packaged desktop backend sidecar.

PyInstaller bundles this module as the standalone ``content-tool-api`` binary
that the Tauri shell spawns. Host/port come from the environment so the shell
can place the backend on loopback without code changes. The app boots into the
"awaiting setup" state (Phase 1) when no credentials are present, so this
entrypoint embeds no secrets.
"""

from __future__ import annotations

import os

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000


def run() -> None:
    import uvicorn

    host = os.environ.get("CONTENT_TOOL_HOST", DEFAULT_HOST)
    port = int(os.environ.get("CONTENT_TOOL_PORT", str(DEFAULT_PORT)))
    # Import the app object directly (not the "module:app" string): the frozen
    # binary has no import path for uvicorn's string-based app loader.
    from content_tool.api.main import create_app

    uvicorn.run(create_app(), host=host, port=port, log_level="info")


if __name__ == "__main__":
    run()
