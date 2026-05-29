# Desktop App — Phase 3: Tauri Shell + Sidecar Packaging

**Date:** 2026-05-29
**Status:** Proposed → implementing (scaffold + build pipeline; full bundle build
requires a toolchain not present in the authoring environment — see Verification)
**Branch:** `feat/desktop-phase-1-setup` (continues)
**Depends on:** Phase 1 (credential-less boot) + Phase 2 (setup screen, `output:'standalone'`)

## Context

Ship the Bowtie AI Content Tool as a native macOS app for non-technical editors.
Phase 0 feasibility (per Phase 1 doc) confirmed: a **Tauri** shell hosting **two
sidecars** — the Next.js frontend as a Node `.next/standalone` server, and the
Python backend as a standalone binary running uvicorn — connecting to **remote
Supabase**. Editors are trusted; **no Apple Developer ID / code signing** (the
unsigned-app Gatekeeper warning is acceptable per the user's decision).

## Decisions

- **Shell:** Tauri 2.x (system WKWebView; small bundle; Rust sidecar lifecycle).
- **Backend sidecar:** PyInstaller one-folder build of a uvicorn entrypoint,
  exposed to Tauri as an `externalBin` with the platform target triple suffix
  (e.g. `content-tool-api-aarch64-apple-darwin`).
- **Frontend sidecar:** Next standalone server run by a **bundled Node binary**.
  Node is not trivially a single file, so we ship `node` + `.next/standalone` +
  `.next/static` + `public` as Tauri **resources** and have the Rust shell spawn
  `node server.js`. (Alternative single-file compilers like Bun were rejected to
  avoid changing the web runtime.)
- **Config dir:** the app sets `BOWTIE_CONFIG_DIR` to
  `~/Library/Application Support/BowtieContentTool` (already Phase 1's default, so
  this is belt-and-suspenders) and creates it on first launch.
- **Ports:** backend `127.0.0.1:8000`, frontend `127.0.0.1:3000` (loopback only).
  The frontend sidecar is started with `NEXT_PUBLIC_API_BASE` baked at build time
  to `http://127.0.0.1:8000`; the WebView loads `http://127.0.0.1:3000`.
- **No telemetry / external calls** added by the shell beyond what the app already
  does. No secrets embedded in the bundle (credentials live in the config file
  the user enters via the Phase 2 screen).

## Architecture

```
Tauri app (Rust)
 ├─ on setup(): ensure BOWTIE_CONFIG_DIR exists; spawn sidecars
 │    ├─ backend  : externalBin  content-tool-api   (uvicorn → 127.0.0.1:8000)
 │    └─ frontend : node (resource) server.js       (Next → 127.0.0.1:3000)
 ├─ wait for 127.0.0.1:3000 to accept connections (poll, timeout)
 ├─ WebView → http://127.0.0.1:3000
 └─ on exit(): kill both child processes
```

The frontend talks to the backend exactly as in dev: browser → `/api/*` →
Next rewrite → `http://127.0.0.1:8000/*`. The Phase 2 SetupGate drives first-run.

## Files / artifacts

| Path | Purpose |
|---|---|
| `content_tool/desktop/server_entry.py` | **new** — uvicorn entrypoint for PyInstaller (`run()`), no reload, host/port from env |
| `packaging/pyinstaller/content-tool-api.spec` | **new** — PyInstaller spec; collects FastAPI/langgraph/google-genai data + hidden imports |
| `src-tauri/Cargo.toml` | **new** — Rust crate (tauri, tauri-plugin-shell) |
| `src-tauri/tauri.conf.json` | **new** — bundle (dmg/app), identifier, externalBin, resources, window |
| `src-tauri/build.rs` | **new** — `tauri_build::build()` |
| `src-tauri/src/main.rs` | **new** — spawn sidecars, readiness poll, lifecycle, load WebView |
| `src-tauri/.gitignore` | **new** — ignore `target/`, copied `binaries/`, `resources/` |
| `src-tauri/icons/` | app icons (generated via `tauri icon`; documented, not committed binary placeholders) |
| `scripts/desktop/build_backend.sh` | **new** — PyInstaller build → place binary as target-triple externalBin |
| `scripts/desktop/build_frontend.sh` | **new** — `npm run build` (standalone) → assemble Node resource tree |
| `scripts/desktop/build_app.sh` | **new** — orchestrate both + `cargo tauri build`; emits `.dmg` |
| `docs/desktop/BUILD.md` | **new** — prerequisites, step-by-step, troubleshooting |
| `.gitignore` (root) | ignore `src-tauri/target/`, `src-tauri/binaries/`, `src-tauri/resources/`, `build/desktop/` |

> **WP target note:** per repo policy, build docs must **not** default or recommend
> `wp_target=staging`. Credentials are entered at runtime via the setup screen; the
> packaging layer never bakes a WP target.

## Backend sidecar detail

`server_entry.py`:
```python
def run() -> None:
    import os, uvicorn
    host = os.environ.get("CONTENT_TOOL_HOST", "127.0.0.1")
    port = int(os.environ.get("CONTENT_TOOL_PORT", "8000"))
    uvicorn.run("content_tool.api.main:app", host=host, port=port, log_level="info")

if __name__ == "__main__":
    run()
```
PyInstaller hidden-imports/collect-all the dynamically imported packages
(uvicorn workers, asyncpg, google.genai, langgraph, opentelemetry exporters,
pydantic). The app still reads creds from `BOWTIE_CONFIG_DIR/config.json` (Phase 1),
so the binary embeds **no** secrets and boots into "awaiting setup" cleanly.

## Frontend sidecar detail

`output:'standalone'` (added Phase 2) yields `.next/standalone/server.js`. The
build script assembles a self-contained tree:
```
resources/frontend/
  server.js
  .next/...            (standalone server chunks)
  .next/static/...     (copied — standalone does not include static)
  public/...           (copied)
  node                 (the Node binary used to run it)
```
The Rust shell runs `node server.js` with `PORT=3000 HOSTNAME=127.0.0.1`.
`NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000` is baked at build time (it is a
`NEXT_PUBLIC_` var → inlined during `npm run build`).

## Rust shell detail (`src-tauri/src/main.rs`)

- Use `tauri-plugin-shell` to spawn the backend `externalBin` (`sidecar(...)`),
  and the shell plugin to run the bundled `node server.js` from the resource dir.
- Resolve `BOWTIE_CONFIG_DIR` to the app-support path, `create_dir_all`, pass it
  into the backend child's env.
- **Readiness:** poll `TcpStream::connect("127.0.0.1:3000")` (and `:8000`) with a
  bounded retry/backoff before navigating the WebView; show the window only once
  the frontend answers (avoids a flash of connection-refused).
- **Lifecycle:** keep `CommandChild` handles in Tauri state; on `RunEvent::Exit`
  / window close, kill both children so no orphan uvicorn/node survives.
- Single instance: acceptable to skip for v1 (single-user); document as a known
  limitation.

## Verification (honest about environment limits)

Authoring environment has Node, npm, cargo/rustc, uv, python3.13 — but **no
`tauri` CLI and no `pyinstaller`**. Therefore:

**Run here (must pass):**
- `tauri.conf.json` parses as valid JSON; required keys present.
- `Cargo.toml` parses as valid TOML.
- All `scripts/desktop/*.sh` pass `bash -n` (syntax) and `shellcheck` if available.
- `server_entry.py`: `python -m py_compile` + import check.
- PyInstaller spec: `python -m py_compile` (it is a Python file).
- `cd web && npm run build` with `output:'standalone'` produces `.next/standalone/server.js`.

**Documented, NOT run here (need toolchain on a build machine):**
- `pip install pyinstaller && pyinstaller packaging/pyinstaller/content-tool-api.spec`
- `cargo install tauri-cli` (or `npm i -g @tauri-apps/cli`) then `scripts/desktop/build_app.sh`
- Producing/opening the `.dmg`.

`docs/desktop/BUILD.md` records the full machine procedure and prerequisites so a
maintainer can produce the artifact. **No `.dmg` is claimed to be built in this
session.**

## Risks / notes

- **Node-as-resource size:** bundling Node plus the PyInstaller backend makes a
  large `.dmg`. Acceptable for an internal tool; noted in BUILD.md. A future phase
  could swap Node for a single-file compile.
- **Unsigned app:** first launch needs right-click→Open (or `xattr -dr
  com.apple.quarantine`). Documented; no Dev ID per user.
- **Apple Silicon first:** target `aarch64-apple-darwin`. Intel/universal is a
  later add (build script keeps the triple in one place).
- **Port conflicts:** if 3000/8000 are taken, sidecars fail; document and consider
  env-overridable ports in a follow-up.
- **No stash/reset against pre-existing unstaged files** during implementation
  (repo memory: prior near-miss). Implementation only adds new files + small,
  reviewed edits to `.gitignore`.
