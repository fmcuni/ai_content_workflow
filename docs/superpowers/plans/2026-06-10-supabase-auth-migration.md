# Plan: Migrate to Supabase Auth

Date: 2026-06-10
Spec: `docs/superpowers/specs/2026-06-10-supabase-auth-migration.md`
Strategy: flagged parallel cutover (`AUTH_PROVIDER`), build OFF → verify → flip.

## Guiding constraints
- Everything ships behind `AUTH_PROVIDER` so `main` stays deployable throughout.
- `web/lib/roles.ts` ↔ `authz.ts` capability maps must stay in sync (invariant).
- Canonical JSON serializers stay byte-identical Python↔TS where parity applies.
- The SSE/collab ticket transport is untouched.
- Operational Supabase-dashboard + secret steps are the user's; code assumes the
  env vars exist and degrades safely when absent (local dev = `AUTH_DISABLED`).

---

## Workstream graph (what blocks what)

```
WS0 Foundation (flag + env + JWT verify util + roles map)
      │
      ├──────────────┬───────────────┬──────────────┐
      ▼              ▼               ▼              ▼
   WS1 Backend     WS2 Frontend    WS3 Admin       WS4 Migration
   session         session +       user-mgmt       script
   validation      magic-link UX   (Worker+web)
      │              │               │              │
      └──────────────┴───────┬───────┴──────────────┘
                             ▼
                      WS5 Test harness
                             ▼
                      WS6 Cutover + docs + better-auth removal (follow-up)
```

WS0 is the only hard prerequisite. WS1–WS4 are **mutually independent** once WS0
lands and can run in parallel. WS5 needs WS1+WS2+WS3. WS6 is last.

---

## WS0 — Foundation (DO FIRST, single owner, ~blocking)
1. Add `AUTH_PROVIDER` to Worker `Env` + web env typing; default `better-auth`.
2. `src/auth/jwt.ts` (new): JWKS-based Supabase JWT verify (cached JWKS), HS256
   fallback; pure + unit-tested. No wiring yet.
3. Migration `supabase/migrations/2026061000XXXX_app_user.sql`: create
   `content_tool.app_user` (+ grants + RLS) per spec. **Migration precedes any
   code that reads/writes the table** (deploy ordering invariant).
4. Rewrite the 4-role map in **both** `authz.ts` (`ROLES`, `ROLE_RANK`,
   capability checks) and `web/lib/roles.ts` (+ `Capability` enum), kept in sync.
   Update `runs_rbac.test.ts`, `me.test.ts`, `admin.test.ts` expectations.
5. Add Supabase client deps: `@supabase/supabase-js` (web). No `supabase-js` on
   the Worker — admin calls use GoTrue REST with `service_role` (fetch).

**Exit:** flag exists, JWT verify util + 4-role maps merged & unit-green, app_user
migration applied locally (`supabase db reset`). Nothing behaviorally changed yet
(flag still `better-auth`).

---

## WS1 — Backend session validation (Worker) — *parallel after WS0*
- `src/auth/middleware.ts`: add the `supabase` branch — Bearer extract → verify
  via `jwt.ts` → set `userId`/`userEmail`. Keep better-auth branch under the flag.
- `src/auth/authz.ts` `loadRole`: read `content_tool.app_user` (id then email).
- Ticket-mint endpoint: confirm it sits behind the Bearer check (it already mints
  after a session check; just ensure it works on the supabase branch).
- Tests: `jwt` unit, `middleware` (both branches), `authz.loadRole` against
  `app_user`.

## WS2 — Frontend session + magic-link UX — *parallel after WS0*
- `web/lib/supabase-client.ts` (new): browser client, cookie storage, PKCE.
- Replace `web/lib/auth-client.ts` exports (`signIn`/`signOut`/`useSession`) with
  Supabase-backed equivalents (same names → minimal call-site churn).
- `web/lib/api.ts`: attach `Authorization: Bearer` from the session; 401 →
  refresh-or-redirect.
- `web/middleware.ts`: read the Supabase auth cookie name instead of better-auth's.
- Pages: `/login` (magic-link request + "check inbox" + resend cooldown +
  enumeration-safe), `/verify` (PKCE callback → redirect), `/signup` (retire →
  redirect). 
- `web/components/Masthead.tsx`: user menu (avatar + email + role badge + Sign
  out), mobile-visible. Toasts (logout, inactivity).
- `web/lib/auth/idle-watchdog.ts`: 6h idle → `signOut()` → `/login?reason=inactivity`.
- Tests: Masthead, idle-watchdog (fake timers), login/verify components (RTL).

## WS3 — Admin user-management — *parallel after WS0*
- Worker `routes/admin.ts`: expand to the full surface (create+invite, role,
  disable/enable, delete, resend, revoke) calling GoTrue admin REST with
  `service_role`; all audited; keep self-demotion guard; 4-role enum.
- A tiny GoTrue admin REST wrapper (`src/auth/gotrue-admin.ts`): `inviteUser`,
  `createUser`, `generateLink`, `deleteUser`, `updateUser` (ban), `signOutUser`.
- `web/app/admin/users/page.tsx`: list + create dialog + per-row actions; gated
  by `can("manage_users")`.
- `web/lib/api.ts` `adminUsersApi` methods for the new endpoints.
- Tests: `admin.test.ts` (each route, RBAC, audit), web admin page (RTL).

## WS4 — User migration script — *parallel after WS0*
- `scripts/migrate_users_to_supabase.ts` (Worker-runtime or node): read
  `content_tool."user"` → for each, GoTrue `createUser`(no password) + insert
  `app_user` with mapped role (admin→admin, editor→reviewer, viewer→author).
  Idempotent (skip existing). Dry-run flag. Prints a summary, no PII echoed.
- Manual-run only; documented in the cutover runbook.

## WS5 — Test harness — *after WS1+WS2+WS3*
- Playwright `global-setup`: `signInWithPassword` from `.env.test.local` →
  persist storage state. Update existing e2e specs that assumed better-auth.
- Provision the test account (one-off admin create via WS3 endpoint or script).
- Smoke: login round-trip, role-gated UI, admin create/disable/role-change.

## WS6 — Cutover + docs (last, single owner)
1. Update **CLAUDE.md** Supabase section (Auth now allowed via GoTrue; document
   the `AUTH_PROVIDER` flag, the Bearer model, `app_user`).
2. Operational checklist executed by user (dashboard + `wrangler secret put`).
3. Run WS4 migration against prod (dry-run → real).
4. Flip `AUTH_PROVIDER=supabase` on both Workers; verify with test account +
   your own magic-link login; watch health.
5. **Follow-up PR**: delete better-auth code/deps, drop old auth tables, remove
   the flag.

---

## Parallel agent assignment (recommended)

After **I** land WS0 solo (it's the shared contract — flag, JWT util, role maps,
migration; parallelizing it would just create merge conflicts), fan out **4
agents in parallel**, each on an isolated worktree to avoid stepping on each
other:

| Agent | Workstream | Touches (mostly disjoint) | Reviewer pass |
|-------|-----------|---------------------------|---------------|
| A | WS1 backend session | `src/auth/{middleware,authz,jwt}.ts` + tests | `typescript-reviewer` |
| B | WS2 frontend session+UX | `web/lib/{supabase-client,api,auth-client}`, `web/app/{login,verify,signup}`, `Masthead`, idle-watchdog | `typescript-reviewer` |
| C | WS3 admin mgmt | `src/routes/admin.ts`, `src/auth/gotrue-admin.ts`, `web/app/admin/users` | `security-reviewer` (service_role handling) |
| D | WS4 migration script | `scripts/migrate_users_to_supabase.ts` | `code-reviewer` |

Coordination notes for the fan-out:
- **Shared-file contention:** `web/lib/api.ts` is touched by B (Bearer header) and
  C (admin methods). Split it: B owns the `http()`/header change; C only *appends*
  an `adminUsersApi` object. Assign the file's auth-header edit to B; C rebases.
- **`roles.ts`/`authz.ts`** are frozen after WS0 — agents consume, don't edit.
- Each agent runs its own `tsc`/`eslint`/Vitest (or `ruff`/`pyright`) green before
  handoff; **forbid** any `git stash/reset/restore` against pre-existing unstaged
  files (prior near-miss).
- Then I integrate the four branches, run WS5 (needs all three runtime WS), then
  WS6.

Estimated critical path: WS0 → max(WS1,WS2,WS3) → WS5 → WS6. WS4 overlaps fully.

## Test plan
- Unit: jwt verify, role maps (both sides), idle-watchdog, admin routes.
- Integration: middleware both branches; loadRole vs app_user; admin RBAC+audit.
- E2E (Playwright): magic-link login (mock/inbox), role-gated UI, admin flows,
  test-account password-grant injection, inactivity logout.
- Parity gate green; Workers + web Vitest green; Python role tests green.

## Rollback
- Flip `AUTH_PROVIDER=better-auth` (both Workers) → instant revert to working
  auth (better-auth code retained until WS6 follow-up).
- `BOOTSTRAP_ADMIN_EMAILS` = lockout escape hatch.
- Worker version rollback as the blunt instrument.
