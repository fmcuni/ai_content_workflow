# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the desktop backend sidecar (`content-tool-api`).

Builds a single-file binary that runs uvicorn against the FastAPI app. Heavy,
dynamically imported dependencies (asyncpg, google-genai/grpc, langgraph,
opentelemetry exporters, pandas) are collected explicitly so the frozen binary
has everything it needs. Project YAML config is bundled as data; prompts now live
in the database, but the `prompts/` dir is included as a harmless fallback.

Build (on a machine with the toolchain — not run in CI authoring env):
    pip install pyinstaller
    pyinstaller packaging/pyinstaller/content-tool-api.spec --noconfirm
Output: dist/content-tool-api  (rename with target triple for Tauri externalBin)
"""

import os

from PyInstaller.utils.hooks import collect_all

# SPECPATH is injected by PyInstaller; resolve the repo root from it.
PROJECT_ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))  # noqa: F821

# Packages with data files / hidden submodules that PyInstaller's static
# analysis misses because the app imports them lazily or by string.
_COLLECT_PACKAGES = [
    "uvicorn",
    "fastapi",
    "starlette",
    "sse_starlette",
    "asyncpg",
    "sqlalchemy",
    "pydantic",
    "pydantic_settings",
    "google.genai",
    "langgraph",
    "langgraph_checkpoint_postgres",
    "opentelemetry",
    "structlog",
    "markdown_it",
    "bs4",
    "tldextract",
    "pandas",
    "yaml",
]

datas = []
binaries = []
hiddenimports = []

for pkg in _COLLECT_PACKAGES:
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

# Project runtime config (pricing, refresh, personas, source_policy) + prompt
# templates fallback. Bundled at the same relative paths the app reads from.
datas += [
    (os.path.join(PROJECT_ROOT, "config"), "config"),
    (os.path.join(PROJECT_ROOT, "prompts"), "prompts"),
]

a = Analysis(
    [os.path.join(PROJECT_ROOT, "content_tool", "desktop", "server_entry.py")],
    pathex=[PROJECT_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="content-tool-api",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,  # set by the build script for cross-arch builds
    codesign_identity=None,
    entitlements_file=None,
)
