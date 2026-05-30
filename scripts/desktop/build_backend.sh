#!/usr/bin/env bash
# Build the Python backend as a single-file binary and place it where Tauri's
# externalBin mechanism expects it: src-tauri/binaries/content-tool-api-<triple>.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Tauri appends the Rust target triple to externalBin names. Default to the host.
TRIPLE="${TARGET_TRIPLE:-$(rustc -Vv | sed -n 's/host: //p')}"
echo "Building backend for target triple: ${TRIPLE}"

# PyInstaller is a build-only dependency; install it into the active venv.
python3 -m pip install --quiet pyinstaller

pyinstaller packaging/pyinstaller/content-tool-api.spec \
  --noconfirm \
  --distpath build/desktop/backend \
  --workpath build/desktop/_work

mkdir -p src-tauri/binaries
cp "build/desktop/backend/content-tool-api" "src-tauri/binaries/content-tool-api-${TRIPLE}"
chmod +x "src-tauri/binaries/content-tool-api-${TRIPLE}"
echo "Placed src-tauri/binaries/content-tool-api-${TRIPLE}"
