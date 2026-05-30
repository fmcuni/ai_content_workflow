"""Uvicorn entrypoint for the packaged desktop backend sidecar.

PyInstaller bundles this module as the standalone ``content-tool-api`` binary
that the Tauri shell spawns. Host/port come from the environment so the shell
can place the backend on loopback without code changes. The app boots into the
"awaiting setup" state (Phase 1) when no credentials are present, so this
entrypoint embeds no secrets.
"""

from __future__ import annotations

import os
import threading
import time

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000

# How often the supervisor watchdog checks that the desktop shell is still alive.
_WATCHDOG_INTERVAL_S = 2.0


def _start_supervisor_watchdog() -> None:
    """Force-exit when the desktop shell that spawned us dies.

    PyInstaller's one-file bootloader forks the real application as a child
    process, so when the Tauri shell kills the bootloader on quit the frozen
    child can be reparented (to launchd) and orphaned — leaving a stray backend
    holding the loopback port. The shell passes its own PID as
    ``BOWTIE_SUPERVISOR_PID``; we poll it and exit once it is gone.

    No-op when the variable is unset (e.g. the CLI or a direct/debug run).
    """
    raw = os.environ.get("BOWTIE_SUPERVISOR_PID")
    if not raw:
        return
    try:
        supervisor_pid = int(raw)
    except ValueError:
        return

    def _watch() -> None:
        while True:
            time.sleep(_WATCHDOG_INTERVAL_S)
            try:
                # Signal 0 performs liveness error-checking without delivering a signal.
                os.kill(supervisor_pid, 0)
            except ProcessLookupError:
                os._exit(0)  # supervisor gone — take the backend down with it
            except PermissionError:
                continue  # exists but owned by another user — still alive
            except OSError:
                os._exit(0)

    threading.Thread(target=_watch, name="supervisor-watchdog", daemon=True).start()


def run() -> None:
    import uvicorn

    # Start before serving so a quit during the (slow) cold boot is still caught.
    _start_supervisor_watchdog()

    host = os.environ.get("CONTENT_TOOL_HOST", DEFAULT_HOST)
    port = int(os.environ.get("CONTENT_TOOL_PORT", str(DEFAULT_PORT)))
    # Import the app object directly (not the "module:app" string): the frozen
    # binary has no import path for uvicorn's string-based app loader.
    from content_tool.api.main import create_app

    uvicorn.run(create_app(), host=host, port=port, log_level="info")


if __name__ == "__main__":
    run()
