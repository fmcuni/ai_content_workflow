# Desktop App — Phase 2: Frontend Setup Screen + First-Run Gate

**Date:** 2026-05-29
**Status:** Proposed → implementing
**Branch:** `feat/desktop-phase-1-setup` (continues; Phase 1 already committed here)
**Depends on:** Phase 1 (`/setup/status`, `/setup/verify`, `POST /setup` backend contract — committed `72a7335`)

## Context

Phase 1 made the FastAPI backend boot without credentials and exposed the setup
API. This phase builds the **frontend half**: on first launch the Next.js app
must detect "not configured", show a setup screen to collect credentials, verify
them, persist them via the backend, and then bring the normal app up — all
without a process restart (the backend's `init_runtime` already supports this).

Single-user, trusted-editor desktop tool. No PII/PHI passes through it (see
CLAUDE.md scope). Keep it simple.

## Backend contract (already live, Phase 1)

- `GET /setup/status` → `{ configured: bool, missing: string[], wp_configured: bool }`
- `POST /setup/verify` (body = SetupRequest) → `{ postgres: bool, gemini: bool }` (no persist)
- `POST /setup` (body = SetupRequest) →
  - `200 { configured: true }` on success (verifies, persists, calls `init_runtime`)
  - `400 { detail: "verification_failed", checks: { postgres, gemini } }` if creds fail
  - `422` on schema-invalid body (FastAPI validation; no secret echoed)
- `SetupRequest`: `gemini_api_key` (req), `postgres_url` (req, must start `postgresql://`
  or `postgresql+asyncpg://`), optional `wp_base_url`, `wp_target` (`staging|production`),
  `wp_username`, `wp_app_password`.

## Frontend findings (current state)

- Next.js **16.2.6**, React 19, app router. `web/AGENTS.md`: this Next has breaking
  changes — confirmed against `web/node_modules/next/dist/docs/`:
  - Client components: `"use client"` at top (unchanged).
  - Navigation hooks from `next/navigation` (`useRouter`, `usePathname`, `redirect`).
  - `rewrites()` async shape unchanged; `output: 'standalone'` is the exact key.
  - `NEXT_PUBLIC_` vars are **build-time inlined**; server-only vars are runtime.
- API access today: all pages are client components using TanStack Query + a thin
  `http<T>()` wrapper in `web/lib/api.ts`. Calls hit `/api/...` paths that
  `web/next.config.mjs` rewrites to `${NEXT_PUBLIC_API_BASE}/...`.
- Providers (`web/app/providers.tsx`): single `QueryClient` + Sonner `<Toaster/>`.
- Root layout (`web/app/layout.tsx`): `<Providers>` wraps `<Masthead/> <Folio/>
  <main>{children}</main> <footer/>`.
- shadcn UI available: `button, input, label, card, select, switch, dialog, ...`.
  No react-hook-form / zod in the web app — forms use plain `useState`. Toasts via
  `sonner`.
- No `/setup` rewrite exists yet; no `output: 'standalone'` yet.

## Design

### 1. Wiring the proxy (`web/next.config.mjs`)

Add one rewrite so the browser's `/api/setup/*` reaches the backend:

```js
{ source: "/api/setup/:path*", destination: `${apiBase}/setup/:path*` },
```

Also add `output: "standalone"` now (Phase 3 needs it; harmless for dev). Keep
the existing `NEXT_PUBLIC_API_BASE` required-env guard.

### 2. API client + types

`web/lib/types.ts` — add:
```ts
export interface SetupStatus { configured: boolean; missing: string[]; wp_configured: boolean; }
export interface SetupVerifyResult { postgres: boolean; gemini: boolean; }
export interface SetupRequest {
  gemini_api_key: string;
  postgres_url: string;
  wp_base_url?: string;
  wp_target?: "staging" | "production";
  wp_username?: string;
  wp_app_password?: string;
}
```

`web/lib/api.ts` — add a `setupApi`. Note `POST /setup` returns 400 on
verification failure; the generic `http<T>()` throws on non-2xx, so `configure`
needs to read the 400 body to surface `checks`. Implement a small dedicated
fetch for `configure` that returns a discriminated result rather than throwing on
the expected 400:

```ts
export const setupApi = {
  status: () => http<SetupStatus>("/api/setup/status"),
  verify: (body: SetupRequest) =>
    http<SetupVerifyResult>("/api/setup/verify", { method: "POST", body: JSON.stringify(body) }),
  configure: async (body: SetupRequest): Promise<
    | { ok: true }
    | { ok: false; reason: "verification_failed"; checks: SetupVerifyResult }
  > => { /* fetch, branch on 200 vs 400, throw on anything else */ },
};
```

### 3. First-run gate (`web/components/SetupGate.tsx`, client)

A client component that wraps the app chrome. It queries `/api/setup/status`:

- **loading** → minimal centered "Connecting to the local service…" state.
- **error** (backend not up yet — the desktop sidecar may still be booting):
  show a "Can't reach the local service" panel with a Retry button. TanStack
  Query retries a few times automatically first.
- **`configured === false`** → render `<SetupScreen />` (full-screen; no masthead nav).
- **`configured === true`** → render `children` (the normal app chrome).

Restructure `layout.tsx` so the chrome lives *inside* the gate:
```tsx
<Providers>
  <SetupGate>
    <Masthead/> <Folio variant="top"/> <main>{children}</main> <footer/>
  </SetupGate>
</Providers>
```
This keeps masthead/footer from rendering (and their nav links from being
clickable) until configured.

### 4. Setup screen (`web/components/SetupScreen.tsx`, client)

Plain `useState` form (matches repo convention), styled with existing shadcn
`Card/Input/Label/Button/Switch` and the paper/ink Tailwind tokens used across
the app. Fields:

- **Gemini API key** (password input, required)
- **Supabase/Postgres URL** (text, required; client-side hint that it must start
  with `postgresql://` — mirror backend rule for a fast error, but the backend is
  the source of truth)
- **WordPress (optional)** behind a `Switch` ("Configure WordPress publishing
  now"): `wp_base_url`, `wp_target` (Select: Staging / Production — **no default,
  no recommended value** per repo policy), `wp_username`, `wp_app_password`.

Actions:
- **Test connection** → `setupApi.verify`. Show per-check ✓/✗ for Postgres and
  Gemini. Disabled while pending.
- **Save & continue** → `setupApi.configure`. On `{ok:true}`: toast success,
  `queryClient.invalidateQueries(["setup-status"])` so the gate re-renders into
  the app. On `verification_failed`: show which check failed; do **not** advance.
  On thrown error (422/5xx): toast the message.

Copy guidelines: never render secret values back; mask the key input; no
`wp_target=staging` recommendation in any helper text.

### 5. Files touched

| File | Change |
|---|---|
| `web/next.config.mjs` | add `/api/setup/:path*` rewrite + `output: 'standalone'` |
| `web/lib/types.ts` | add SetupStatus / SetupVerifyResult / SetupRequest |
| `web/lib/api.ts` | add `setupApi` (status/verify/configure) |
| `web/components/SetupGate.tsx` | **new** — first-run gate |
| `web/components/SetupScreen.tsx` | **new** — setup form |
| `web/app/layout.tsx` | wrap chrome in `<SetupGate>` |
| `web/tests/e2e/setup.spec.ts` | **new** — Playwright, route-mocked |

### 6. Tests (Playwright, hermetic via `page.route`)

The live dev backend is already configured, so we **mock** `/api/setup/*` at the
browser layer to exercise both states deterministically:

1. **Unconfigured shows setup screen:** mock `/api/setup/status` →
   `{configured:false, missing:["postgres_url","gemini_api_key"], wp_configured:false}`;
   assert the setup screen renders and masthead nav is absent.
2. **Verify surfaces per-check results:** mock `/verify` → `{postgres:true, gemini:false}`;
   fill form, click Test, assert per-check states shown.
3. **Verification failure does not advance:** mock `POST /setup` → 400
   `verification_failed`; assert still on setup screen.
4. **Happy path advances:** mock `POST /setup` → 200 `{configured:true}` and make
   the *next* `/status` return `configured:true`; assert app chrome appears.
5. **Configured boot shows app:** mock `/status` → `configured:true`; assert no
   setup screen.

## Verification

- `cd web && npm run lint`
- `cd web && NEXT_PUBLIC_API_BASE=http://localhost:8000 npm run build` (type errors
  fail the Next build — this is the type gate; there is no separate `tsc` script)
- `cd web && npx playwright test tests/e2e/setup.spec.ts` against the externally
  running dev server (reuseExistingServer). If browsers/server unavailable in the
  harness, report honestly rather than claim a pass.

## Out of scope (Phase 3)

- Tauri shell, sidecar spawn, packaging, `.dmg`.
- Changing the API base URL at runtime for the packaged app (Phase 3 sets it
  before the frontend sidecar starts; this phase keeps the dev `NEXT_PUBLIC_API_BASE`).
