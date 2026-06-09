# Spec: Migrate to Supabase Auth (magic link + admin-managed accounts)

Date: 2026-06-10
Status: Approved (design interview complete)
Supersedes (auth portions of): `2026-06-01-cloudflare-email-auth.md`

## Goal

Replace the better-auth email/password system with **Supabase Auth (GoTrue)**:

- Humans log in by **magic link only** (no passwords, no self-signup).
- **Admins create accounts and assign roles**; a full user-management surface.
- **Inactive sessions expire at ~6h.**
- A dedicated **test account** the agent can authenticate non-interactively.
- Enriched login/logout UX.

This intentionally overturns the CLAUDE.md rule "no Supabase Auth / no supabase-js."
That rule is updated as part of this work: Supabase Auth (GoTrue) becomes the
identity provider; SQLAlchemy/asyncpg + postgres.js still own all *application*
data access (no PostgREST, no Data API).

## Non-goals

- No segregation of duties (a reviewer/admin may approve & publish their own run).
- No migration of password hashes (better-auth scrypt → GoTrue bcrypt is lossy;
  magic-link sidesteps it).
- No change to the SSE/collab HMAC `?ticket=` transport (kept; only the
  upstream session check changes).
- No OAuth / social providers, no MFA (future work).

## Decisions (design-interview record)

| # | Area | Decision |
|---|------|----------|
| 1 | Engine | Supabase Auth (GoTrue) replaces better-auth. |
| 2 | Login | Magic-link only for humans; self-signup disabled; admin creates all accounts. Password grant stays enabled but only the test account has a password. |
| 3 | Session | Browser holds the Supabase session (cookie storage). Every backend call sends `Authorization: Bearer <jwt>`. Worker verifies the JWT locally via JWKS. SSE/collab keep the HMAC ticket, minted after JWT verify. |
| 4 | Role storage | `content_tool.app_user` table is the SoT for profile+role. Worker looks up role per request (cached), like today's `loadRole`. |
| 5 | Roles | 4 cumulative roles, permissive: `viewer` < `author` < `reviewer` < `admin`. |
| 6 | Idle expiry | Client idle watchdog @ 6h + Supabase refresh-token inactivity timeout = 6h. 1h access token, auto-refresh. No hard timebox. |
| 7 | Invite | Admin create → invite/magic-link email sent immediately via Resend SMTP. |
| 8 | Admin surface | Full: list (email/name/role/status/last-sign-in), create+invite, change role, disable↔enable, delete, resend link, revoke sessions. |
| 9 | Auth UX | Full polish: magic-link login + callback + retire signup + Masthead user menu + inactivity/logout toasts. |
| 10 | Test auth | Admin-created `@bowtie` account with a password; tests call `signInWithPassword` from `.env.test.local` and inject the session. No password UI in the app. |
| 11 | Cutover | Flagged parallel via `AUTH_PROVIDER` (`better-auth` \| `supabase`). Deploy OFF, verify, flip, remove better-auth in a follow-up. |
| 12 | User migration | One-time script: existing `user` rows → Supabase auth users (no password) + `app_user` rows. Mapping: admin→admin, editor→reviewer, viewer→author. |
| 13 | Domain gate | Dropped — admins trusted to enter correct emails. |

## Roles & capabilities (4-role, permissive)

Cumulative ranks `viewer(0) < author(1) < reviewer(2) < admin(3)`. Capability map
(replaces the 3-role map in `web/lib/roles.ts` and `authz.ts`):

- **viewer** — read-only. `read`.
- **author** — viewer + `create_run`, `regenerate`, `promote_topics`,
  `edit_outline`, `edit_article`, `apply_edits`, `save_snapshot`.
- **reviewer** — author + `hitl1_approve`, `hitl2_decide`, `publish`.
- **admin** — reviewer + `edit_prompts`, `manage_personas`, `edit_source_policy`,
  `delete_run`, `delete_batch`, `manage_users`.

Note the semantic shift from today: the *old* `viewer` could edit content; the
*new* `viewer` is read-only and editing moves to `author`. The frontend
(`web/lib/roles.ts`) and backend (`authz.ts`) maps must stay byte-for-byte in
sync (existing invariant).

## Architecture

### Request topology
Unchanged two-Worker model. Frontend (`bowtie-content-tool-web`) and backend
(`bowtie-content-tool-poc`) on separate origins. The new wrinkle: the session is
a Supabase JWT, not a same-origin better-auth cookie.

### Where auth lives
- **GoTrue (Supabase-managed)** owns identity, magic-link issuance, sessions,
  refresh tokens, the admin user API. Tables in the Supabase `auth` schema.
- **`content_tool.app_user`** owns the app's view of a user: role, display name,
  status (active/disabled), timestamps, last-sign-in mirror. `id` = the auth
  uuid as a **soft reference** (no hard cross-schema FK to `auth.users`).

### Session validation (Worker)
`requireAuth` (`src/auth/middleware.ts`) gains a `supabase` branch behind
`AUTH_PROVIDER`:
- Read `Authorization: Bearer <jwt>` (REST). Verify signature + `exp`/`aud`/`iss`
  locally via **JWKS** (cached), falling back to HS256 shared secret if signing
  keys aren't enabled. On success set `userId` (= `sub`), `userEmail` (= claim).
- SSE (`/events`) and collab (`/runs/:id/doc`) WS: **unchanged** — HMAC
  `?ticket=`. The ticket is minted by a small authenticated endpoint after the
  Bearer check (the frontend already fetches a ticket before opening SSE/WS).
- `loadRole` (`src/auth/authz.ts`) now reads `content_tool.app_user` instead of
  `content_tool."user"`; `effectiveRole` + `BOOTSTRAP_ADMIN_EMAILS` unchanged.

### Frontend session
- `@supabase/supabase-js` browser client with **cookie storage** (so the existing
  optimistic Next `middleware.ts` gate can still read a cookie). PKCE flow.
- `web/lib/api.ts` `http()` attaches `Authorization: Bearer <access_token>` from
  `supabase.auth.getSession()`; on 401 it triggers a refresh / redirect to login.
- `web/lib/auth-client.ts` is replaced by a Supabase client module exposing
  `signInWithMagicLink(email)`, `signOut()`, `useSession()` equivalents so call
  sites change minimally.

### Admin operations (Worker only)
The `service_role` key lives **only on the Worker**. `routes/admin.ts` expands:
- `GET /admin/users` — join `app_user` + GoTrue (last-sign-in, confirmed) for list.
- `POST /admin/users` — create: GoTrue `inviteUserByEmail` (or `createUser` +
  `generateLink`) → insert `app_user` row with chosen role. Sends invite email.
- `PUT /admin/users/:id/role` — change role (existing; retarget to `app_user`,
  expand enum to 4 roles, keep self-demotion lockout guard).
- `POST /admin/users/:id/disable` / `/enable` — ban/unban via GoTrue admin +
  `app_user.status`.
- `DELETE /admin/users/:id` — delete GoTrue user + `app_user` row.
- `POST /admin/users/:id/resend-invite` — re-send magic/invite link.
- `POST /admin/users/:id/revoke-sessions` — GoTrue admin sign-out (all sessions).
All audited via the existing `auditLog` (actor, target, action, old→new).

## Idle expiry (6h)
- **Supabase project setting**: refresh-token inactivity timeout = 6h; access
  token TTL = 1h; refresh rotation on.
- **Client watchdog** (`web/lib/auth/idle-watchdog.ts`): resets a 6h timer on
  user interaction (pointer/key/visibility); on expiry calls `signOut()` and
  routes to `/login?reason=inactivity`. Tab left open but idle → logged out.

## Magic-link UX
- `/login`: email field → submit `signInWithMagicLink` → "check your inbox"
  state with a resend cooldown. **Enumeration-safe**: always show success copy
  regardless of whether the email exists; magic link uses `shouldCreateUser:false`.
- `/verify`: callback handler — exchanges the PKCE code / token hash for a
  session, then redirects to the original `?redirect=` target (or `/`).
- `/signup`: retired → redirects to `/login` with a "contact your admin" note.
- **Masthead user menu**: initials avatar + dropdown (email, role badge, Sign
  out), visible on mobile. Replaces the desktop-only email + tiny "Sign out".
- Toasts: post-logout ("Signed out") and inactivity ("Signed out due to
  inactivity").

## Test account
- Admin-created `@bowtie` user (e.g. `agent-e2e@bowtie.com.sg`) with a password
  set via GoTrue admin. Role per test needs (default `admin` for broad coverage,
  or a fixture per role).
- Playwright global-setup calls Supabase `signInWithPassword` with creds from
  gitignored `.env.test.local`, then writes the session into storage state /
  cookies. No password entry path exists in the deployed app.
- Password grant remains enabled in Supabase; only this account has a password,
  so it's effectively unusable by anyone else.

## Data model
New migration adds `content_tool.app_user`:
```
id            text PRIMARY KEY          -- Supabase auth uuid (soft ref)
email         text NOT NULL UNIQUE
display_name  text
role          text NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('viewer','author','reviewer','admin'))
status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled'))
created_at    timestamptz NOT NULL DEFAULT now()
updated_at    timestamptz NOT NULL DEFAULT now()
last_sign_in_at timestamptz
```
`content_tool_app` gets the table grants. RLS enabled (defense in depth). The
old better-auth tables (`user`/`session`/`account`/`verification`) are retained
until better-auth removal (follow-up), then dropped in a later migration.

## Secrets / config (operational handoff — done outside code)
Supabase dashboard:
- Enable Auth; Site URL = web origin; redirect allowlist includes `/verify`.
- Email: disable confirmations/signups as needed; enable magic link; configure
  **Resend** as custom SMTP.
- Sessions: inactivity timeout 6h, access token 1h.
- (Recommended) enable asymmetric JWT signing keys (for JWKS verify).

Worker secrets (via `wrangler secret put`, piped so values never enter context):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (HS256
  fallback) and/or rely on the public JWKS URL derived from `SUPABASE_URL`.
- `AUTH_PROVIDER` env var on both Workers (`better-auth` until cutover).
- `BOOTSTRAP_ADMIN_EMAILS` carried over.

Web build/runtime env:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `NEXT_PUBLIC_AUTH_PROVIDER`.

## Acceptance
- With `AUTH_PROVIDER=supabase`: magic-link login round-trips; backend accepts
  the Bearer JWT; role gates behave per the 4-role map; admin can
  create/invite/disable/delete/role-change/revoke; idle 6h logs out;
  test account logs in non-interactively via `signInWithPassword`.
- With `AUTH_PROVIDER=better-auth`: unchanged behavior (the safety path).
- Parity gate (`deploy/cloudflare-workers/parity/check-parity.mjs`) still green.
- Vitest (Workers + web), Playwright auth smoke, Python role tests green.

## Risks
- **Lockout on cutover** — mitigated by the flag + `BOOTSTRAP_ADMIN_EMAILS` +
  fast Worker rollback.
- **JWKS not enabled on the project** — HS256 fallback path.
- **Whole-doc collab replace** and other ticket consumers must keep working —
  the ticket transport is unchanged, only its upstream auth check differs.
- **Role semantic shift** (viewer no longer edits) could surprise migrated
  users — migration maps old viewer→author to preserve edit ability.
