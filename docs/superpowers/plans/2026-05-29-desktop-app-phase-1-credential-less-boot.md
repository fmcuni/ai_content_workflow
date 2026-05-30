# Desktop App — Phase 1: Credential-less Boot + Setup API

**Date:** 2026-05-29
**Status:** Proposed (awaiting confirmation before implementation)
**Branch:** `feat/desktop-phase-1-setup` (to be created off `main`)

## Context

We are packaging the Bowtie AI Content Tool as a native macOS app (Tauri shell +
two sidecars: Node `.next/standalone` for the frontend, standalone Python +
uvicorn for the backend). Feasibility (Phase 0) confirmed green: all native deps
load on cp313/arm64, frontend runs as a Node standalone sidecar (static export
ruled out due to runtime-ID dynamic routes), connects to **remote Supabase**.

This phase is the first that edits app code. Goal: the backend must **boot
without credentials** and expose a **setup API** so the desktop shell can collect
config (Gemini key + Supabase URL, optional WordPress) on first launch.

## Decisions (confirmed with user)

- **Secret storage:** plaintext JSON config file (single-user local tool).
  - Location: `~/Library/Application Support/BowtieContentTool/config.json`
    (override via `BOWTIE_CONFIG_DIR` for tests).
  - File lives **outside the repo**; never committed; never logged (no secret
    values in logs at any level).
  - File mode set to `0o600` on write (owner read/write only) as basic hygiene.
- **Proceed mode:** plan doc first (this doc), confirm, then TDD implementation.
- **Route guarding:** **none** — per user, do not add a `require_configured()`
  503 guard. The frontend gates on `GET /setup/status`; credentialed routes called
  before setup will simply error (500) as they do today with missing state. Keeps
  the diff small and avoids touching every router.
- **Gemini model default:** change `Settings.gemini_model` default to
  `"gemini-3.1-pro-preview"`. Model stays default/env-only in Phase 1 (not part of
  the setup form).
- **Credential verification:** **in scope for Phase 1** — `POST /setup` verifies
  creds (Supabase reachable + cheap Gemini call) *before* persisting, and a
  standalone `POST /setup/verify` lets the UI pre-check without saving.

## Problem in current code

- `content_tool/config.py`: `Settings.postgres_url` and `Settings.gemini_api_key`
  are **required** → `get_settings()` raises `ValidationError` when unset.
- `content_tool/api/main.py::lifespan`: eagerly builds engine, `RealGeminiClient`,
  `WordPressClient`, and runs `recover_orphaned()` — all require live creds.
  `create_app()` itself needs no creds (the only well-behaved part).

## Design

### 1. Config layering (`config.py`)

Introduce a desktop config source that merges, in precedence order:

1. Process env / `.env.local` (unchanged — dev workflow keeps working)
2. Desktop JSON config file (new — written by the setup API)
3. Field defaults

Make `postgres_url` and `gemini_api_key` **optional** (`str | None = None`) so
`get_settings()` never raises on missing creds. Add a derived helper:

```python
def is_configured(s: Settings) -> bool:
    return bool(s.postgres_url) and bool(s.gemini_api_key)
```

Add a small `DesktopConfigStore` (new module `content_tool/desktop/config_store.py`):
- `load() -> dict[str, Any]` — read JSON file, `{}` if absent/invalid (log a
  warning on invalid, never crash).
- `save(values: dict[str, Any]) -> None` — atomic write (temp + rename), mode
  `0o600`, create parent dir.
- Pure I/O; no secret values in log lines.

Wire the store into `Settings` via a `settings_customise_sources` hook or an
explicit loader in `get_settings()` (prefer explicit loader for clarity — keeps
pydantic-settings behavior obvious and testable). `get_settings()` loses its
`lru_cache`-free simplicity but must remain cheap; we will **not** cache it while
setup can mutate config at runtime (re-read after `POST /setup`).

### 2. Lazy app state (`main.py::lifespan`)

Split lifespan into:
- **Always-on:** logging, tracing, routers, `/health`, `/setup/*`.
- **Credentialed init** (`init_runtime(app, settings)`): engine, session factory,
  Gemini, WP client, executor, `recover_orphaned()`. Called **only when**
  `is_configured(settings)` is true.

On boot when **not** configured: skip credentialed init, set
`app.state.run_executor = None` etc., log a single info line `"awaiting setup"`.
After a successful `POST /setup`, call `init_runtime` to bring the app up live
without a process restart (idempotent: dispose any prior engine first).

**No route guard** (per user decision). Credentialed routes called before setup
error as they would today; the frontend prevents that by gating on
`GET /setup/status`. This keeps the diff to `main.py` + new files only.

**Settings caching (from #1 audit):** no per-request tight loop exists. Closest
call sites are `api/routes/topic_batches.py:96` (request-scoped) and
`refresh/scanner.py:177,194` (twice per candidate). Cache the *parsed config file*
and invalidate it inside `DesktopConfigStore.save()`, so post-setup re-reads are
cheap and correct.

### 3. Setup API (new router `content_tool/api/routes/setup.py`)

- `GET /setup/status` → `{ "configured": bool, "missing": ["postgres_url", ...],
  "wp_configured": bool }`. **Never** returns secret values.
- `POST /setup` → body validated by a Pydantic `SetupRequest`:
  - `gemini_api_key: str` (min length check; required)
  - `postgres_url: str` (required; basic `postgresql://` scheme validation)
  - optional WP: `wp_base_url`, `wp_target` (`staging|production`),
    `wp_username`, `wp_app_password`
  - On schema-valid input: **verify creds first** (see below); only on success
    persist via `DesktopConfigStore.save`, re-read settings, call `init_runtime`,
    return `{ "configured": true }`.
  - On schema failure: 422 with field errors (no secret echoed back).
  - On verification failure: 400 `{ "detail": "verification_failed", "checks":
    { "postgres": bool, "gemini": bool } }` — config is **not** persisted.
- `POST /setup/verify` → same `SetupRequest` body; runs the checks and returns
  `{ "postgres": bool, "gemini": bool }` **without persisting**. Lets the UI
  pre-flight before the user commits.

**Verification checks** (`content_tool/desktop/verify.py`, new):
- Postgres: open a short-timeout connection via existing engine helper and run
  `SELECT 1`; return False on any exception (reason logged, no creds in log).
- Gemini: a single cheap `RealGeminiClient` call (smallest model request);
  return False on auth/transport error. Bounded by a timeout to keep the
  endpoint responsive.

> WP target note: per repo policy, **do not default or recommend
> `wp_target=staging`** in any user-facing copy or docs; keep it an explicit
> user choice with no recommended value.

## Files touched

| File | Change |
|---|---|
| `content_tool/config.py` | Optional creds, config-file layering, `is_configured` |
| `content_tool/desktop/config_store.py` | **new** — atomic JSON load/save, 0600 |
| `content_tool/api/main.py` | Split lifespan; `init_runtime`; lazy state |
| `content_tool/api/routes/setup.py` | **new** — `/setup/status`, `/setup`, `/setup/verify` |
| `content_tool/desktop/verify.py` | **new** — Postgres `SELECT 1` + cheap Gemini check |
| `content_tool/config.py` (model default) | `gemini_model` default → `gemini-3.1-pro-preview` |
| `.gitignore` | ensure local config dir/pattern ignored (defense in depth) |
| `tests/unit/test_config_store.py` | **new** |
| `tests/integration/test_setup_api.py` | **new** |

## TDD plan (tests first)

1. **`test_config_store.py`** (unit):
   - save→load round-trips values
   - missing file → `{}`
   - invalid JSON → `{}` + warning (no raise)
   - file written with mode `0o600`
   - no secret value appears in captured logs
2. **`test_config.py`** additions (unit):
   - missing creds → `get_settings()` returns object, `is_configured()` False
   - config-file values override defaults; env overrides file
3. **`test_setup_api.py`** (integration, FastAPI TestClient, `BOWTIE_CONFIG_DIR`
   pointed at tmp):
   - unconfigured boot: `GET /health` 200, `GET /setup/status` `configured:false`
     with correct `missing`
   - `POST /setup` with bad body → 422, no secret in response
   - `POST /setup` with valid body but failing checks (verify mocked False) →
     400 `verification_failed`, config **not** written to disk
   - `POST /setup` happy path (verify mocked True) → `configured:true`;
     `/setup/status` flips true; `init_runtime` invoked once
   - `POST /setup/verify` returns per-check booleans and does **not** persist
   - secret value never present in `/setup/status` payload or logs
   - (runtime init against a real DB exercised via existing integration harness
     with local Supabase `EXTERNAL_POSTGRES_URL`; setup tests mock
     `desktop.verify` + `init_runtime` to avoid needing live Gemini)

## Out of scope (later phases)

- Tauri shell, sidecar packaging, `.dmg` build (Phase 2/3).
- Frontend setup screen wiring (Phase 2 — backend contract lands here first).
- Keychain/encrypted storage (explicitly deferred per user choice).

## Risks / notes

- Removing `lru_cache`-style caching of settings: ensure no hot path calls
  `get_settings()` per-request in a way that re-reads the file expensively. Audit
  call sites; cache the parsed file with an explicit invalidate-on-save.
- `recover_orphaned()` now runs inside `init_runtime`, which may run post-boot
  (after setup) rather than at process start — behavior preserved, timing shifts.
- Pre-existing unstaged `CLAUDE.md` change on `main` will be left untouched;
  branch carries it forward. No stash/reset/restore against it.
