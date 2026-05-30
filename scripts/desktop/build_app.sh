#!/usr/bin/env bash
# Orchestrate a full desktop build: backend binary, frontend sidecar tree, then
# the Tauri bundle (.app + .dmg). Run on a macOS build machine with the Rust
# toolchain, Node, a Python venv, and the Tauri CLI installed.
#
# Prereqs (see docs/desktop/BUILD.md):
#   - rustup target + cargo
#   - Tauri CLI:  cargo install tauri-cli --version '^2'   (provides `cargo tauri`)
#   - app icons generated into src-tauri/icons (cargo tauri icon path/to/logo.png)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"$ROOT/scripts/desktop/build_backend.sh"
"$ROOT/scripts/desktop/build_frontend.sh"

cd "$ROOT/src-tauri"
cargo tauri build

echo "Build complete. Bundle output: src-tauri/target/release/bundle/"
echo "DMG: src-tauri/target/release/bundle/dmg/"
