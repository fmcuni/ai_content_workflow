#!/usr/bin/env bash
# Build the Next.js frontend as a standalone server and assemble a self-contained
# tree (server + static + public + a bundled Node binary) under
# src-tauri/resources/frontend, which the Rust shell runs with `node server.js`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/web"

# Bake the loopback API base into the client bundle (NEXT_PUBLIC_* is inlined at
# build time). The desktop backend always listens here.
export NEXT_PUBLIC_API_BASE="http://127.0.0.1:8000"
npm run build

DEST="$ROOT/src-tauri/resources/frontend"
rm -rf "$DEST"
mkdir -p "$DEST"

# Standalone server + the node_modules it traced. outputFileTracingRoot is set to
# the web dir in next.config.mjs, so server.js sits at the standalone root.
cp -R .next/standalone/. "$DEST/"

# Standalone output excludes static assets and public/ — copy them in.
mkdir -p "$DEST/.next"
cp -R .next/static "$DEST/.next/static"
if [ -d public ]; then
  cp -R public "$DEST/public"
fi

# Bundle the Node runtime used to run the server (same arch as the host build).
cp "$(command -v node)" "$DEST/node"
chmod +x "$DEST/node"

echo "Assembled frontend sidecar at ${DEST}"
