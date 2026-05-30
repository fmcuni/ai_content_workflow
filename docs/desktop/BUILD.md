# Building the Bowtie Content Tool desktop app (macOS)

Packages the app as a native macOS `.app` / `.dmg` using a Tauri shell that
launches two local sidecars:

- **Backend** — the FastAPI/uvicorn app frozen by PyInstaller (`content-tool-api`),
  listening on `127.0.0.1:8000`.
- **Frontend** — the Next.js standalone server run by a bundled Node binary,
  listening on `127.0.0.1:3000`. The WebView loads the frontend; the frontend
  proxies `/api/*` to the backend exactly as in dev.

The app connects to **remote Supabase** and Gemini using credentials the editor
enters on first launch (Phase 1/2). No secrets are baked into the bundle.

> This app handles public marketing/editorial content only — no PII/PHI. The app
> is **unsigned** (trusted internal editors, no Apple Developer ID). See
> "First launch (unsigned)" below.

## Prerequisites (build machine)

- macOS on Apple Silicon (primary target: `aarch64-apple-darwin`).
- **Rust** toolchain: <https://rustup.rs>
- **Tauri CLI 2.x**: `cargo install tauri-cli --version '^2'` (gives `cargo tauri`).
- **Node** (matches the repo's web version) and `npm`.
- **Python 3.13** with the project installed in a venv:
  `uv venv && source .venv/bin/activate && uv pip install -e ".[dev]"`.
- **PyInstaller** (the backend build script installs it into the active venv).
- **App icons** generated once: `cd src-tauri && cargo tauri icon path/to/logo.png`.

## One-shot build

```bash
source .venv/bin/activate          # backend build needs the project venv
./scripts/desktop/build_app.sh
```

Output: `src-tauri/target/release/bundle/dmg/*.dmg` (and `.../macos/*.app`).

## What each script does

| Script | Action |
|---|---|
| `scripts/desktop/build_backend.sh` | PyInstaller → `src-tauri/binaries/content-tool-api-<triple>` |
| `scripts/desktop/build_frontend.sh` | `npm run build` (standalone) → `src-tauri/resources/frontend/` (+ bundled `node`) |
| `scripts/desktop/build_app.sh` | runs both, then `cargo tauri build` |

`TARGET_TRIPLE` overrides the externalBin suffix for cross-arch builds
(default: the host triple from `rustc -Vv`).

## First launch (unsigned)

Because the app is unsigned, Gatekeeper blocks the first open. Either:

- Right-click the app → **Open** → confirm; or
- `xattr -dr com.apple.quarantine "/Applications/Bowtie Content Tool.app"`.

On first run the window shows the setup screen (no DB/Gemini credentials yet).
Enter the Gemini API key + Supabase URL (and optionally WordPress), click
**Test connection**, then **Save & continue**. Credentials are written to
`~/Library/Application Support/BowtieContentTool/config.json` (mode `0600`).

## DMG bundling needs an interactive session

`cargo tauri build` builds the `.app` headlessly, but the `.dmg` step runs
Tauri's `bundle_dmg.sh`, which executes an AppleScript that tells **Finder** to
arrange the disk-image window. That requires a GUI login **and** Automation
permission to control Finder, so it fails in non-interactive contexts (ssh, CI,
detached agents) with `Failed running AppleScript` (exit 64).

- **Interactive Terminal (normal case):** run `./scripts/desktop/build_app.sh`
  from Terminal.app. macOS prompts *"Terminal wants to control Finder"* the first
  time — click **Allow** (or pre-grant under System Settings → Privacy &
  Security → Automation) and the `.dmg` builds.
- **Headless / CI fallback:** build only the `.app` (`cargo tauri build
  --bundles app`) and wrap it into a plain DMG without the Finder cosmetics:

  ```bash
  APP="src-tauri/target/release/bundle/macos/Bowtie Content Tool.app"
  STAGE="$(mktemp -d)"; cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "Bowtie Content Tool" -srcfolder "$STAGE" \
    -ov -format UDZO "Bowtie Content Tool.dmg"
  ```

  The result installs identically (drag to Applications); it just lacks the
  custom background/icon layout.

## Notes / known limitations

- **Bundle size:** ships a full Node runtime (the official self-contained
  nodejs.org build, ~110 MB) plus the PyInstaller backend — the `.dmg` is large
  (hundreds of MB). Acceptable for an internal tool; a future phase could swap
  Node for a single-file compile.
- **Backend warm-up:** the frozen backend cold-boots in ~25 s (PyInstaller
  unpacks the one-file archive and imports heavy deps). The shell reveals the
  window as soon as the **frontend** is ready (~few seconds) so first paint is
  fast; the setup form is static, but **Test connection / Save** may briefly
  return a proxy error until the backend finishes booting. Just retry.
- **Ports:** `3000` (frontend) and `8000` (backend) on loopback. If taken, the
  sidecars fail to bind. The backend port is baked into the frontend client
  bundle (`NEXT_PUBLIC_API_BASE`) at build time, so runtime port overrides need
  a rebuild — env-overridable ports remain a follow-up.
- **Single instance:** not enforced in v1 (single-user assumption).
- **Verification status:** first real build verified on macOS Apple Silicon
  (2026-05-30): `.app` launches, both sidecars bind, the in-app proxy reaches the
  backend, and the first-run setup screen renders. Building from the committed
  scaffold required removing an invalid capability permission
  (`core:webview:allow-navigate`) and a Rust borrow fix in the exit handler;
  both are in tree. `cargo tauri` validates `tauri.conf.json` and `capabilities/`
  and reports exactly what (if anything) still needs adjusting.
