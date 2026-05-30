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

## Notes / known limitations

- **Bundle size:** ships a full Node runtime plus the PyInstaller backend — the
  `.dmg` is large (hundreds of MB). Acceptable for an internal tool; a future
  phase could swap Node for a single-file compile.
- **Ports:** `3000` (frontend) and `8000` (backend) on loopback. If taken, the
  sidecars fail to bind; env-overridable ports are a follow-up.
- **Single instance:** not enforced in v1 (single-user assumption).
- **Verification status:** the scaffold (Rust shell, `tauri.conf.json`,
  capabilities, PyInstaller spec, scripts) was authored without a Tauri/
  PyInstaller toolchain in CI. Expect to reconcile minor schema/permission
  details against `cargo tauri`'s generated schemas on the first real build —
  the Tauri CLI validates `tauri.conf.json` and `capabilities/` and will report
  exactly what (if anything) needs adjusting.
