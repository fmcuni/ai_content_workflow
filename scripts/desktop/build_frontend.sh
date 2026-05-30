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

# Bundle a self-contained Node runtime to run the server. We deliberately do NOT
# copy `$(command -v node)`: package-manager Node builds (e.g. Homebrew) are thin
# launchers dynamically linked against libnode + a web of Cellar dylibs, so they
# break the moment the .app is relocated to another machine. The official
# nodejs.org build is statically linked against libnode/V8 and depends only on
# system libraries, so it is safe to relocate.
NODE_VERSION="$(node --version)"          # e.g. v22.22.0
case "${TARGET_TRIPLE:-$(rustc -Vv | sed -n 's/host: //p')}" in
  aarch64-*) NODE_ARCH="arm64" ;;
  x86_64-*)  NODE_ARCH="x64" ;;
  *) echo "Unsupported target triple for Node bundling" >&2; exit 1 ;;
esac
NODE_PKG="node-${NODE_VERSION}-darwin-${NODE_ARCH}"
NODE_CACHE="${ROOT}/build/desktop/node-cache"
mkdir -p "$NODE_CACHE"
if [ ! -x "$NODE_CACHE/$NODE_PKG/bin/node" ]; then
  echo "Fetching official Node ${NODE_VERSION} (${NODE_ARCH})…"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_PKG}.tar.gz" \
    | tar -xz -C "$NODE_CACHE"
fi
cp "$NODE_CACHE/$NODE_PKG/bin/node" "$DEST/node"
chmod +x "$DEST/node"

echo "Assembled frontend sidecar at ${DEST}"
