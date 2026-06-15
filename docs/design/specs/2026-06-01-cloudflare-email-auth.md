# Spec: Email/Password Auth for Cloudflare Production

**Date:** 2026-06-01
**Status:** in-progress
**Scope:** Cloudflare production deployment only (`deploy/cloudflare-workers/` backend +
`web/` OpenNext frontend). The Python backend (`content_tool/`) is **not** touched — it
remains the desktop/eval/local-dev sidecar and has no auth.

## Goal

Gate the production Bowtie Content Desk behind email + password authentication.

- **Self-serve signup**, restricted by email domain to **@bowtie.com.hk**.
- **Email verification required** before first sign-in (delivered via **Resend**).
- Implemented with **better-auth**, backed by the existing Supabase Postgres
  (`content_tool` schema) over Hyperdrive.
- Both Workers enforce auth — the backend is publicly reachable on its `workers.dev`
  URL, so frontend-only gating would be trivially bypassed.

## Non-goals

- No social / SSO providers, no 2FA, no roles/permissions (everyone who verifies a
  @bowtie.com.hk address gets the same full access).
- No changes to the Python backend or desktop app.
- No org/admin user management UI (signup is self-serve + domain-gated).

## Architecture

### Request topology (unchanged transport)

- Browser → **Next Worker** (`/api/*` rewrite, same-origin to the browser) → **backend
  Worker** (Hono) for all REST.
- Browser → **backend Worker** directly for SSE (`/runs/:id/events`,
  `/topic-batches/:id/events`) — Next rewrites buffer streams, so SSE bypasses the proxy.

### Where auth lives

better-auth mounts on the **backend** at a **path-preserving** `/api/auth/*`. A new Next
rewrite maps `/api/auth/:path*` → `${apiBase}/api/auth/:path*` (note: preserves `/api`,
unlike the other bare-path rewrites). Because the browser hits auth **same-origin** through
the proxy, the session cookie is set on the **web domain** (HttpOnly, Secure,
SameSite=Lax). No cross-site cookie is ever needed for REST.

- `baseURL` = `FRONTEND_ORIGIN` (web origin) so verification links point at the web app
  and flow back through the proxy.
- `basePath` = `/api/auth` (matches what the backend receives — the rewrite preserves it).
- `trustedOrigins` = `[FRONTEND_ORIGIN]`.

### REST gating

A Hono middleware (`requireAuth`) runs on the backend for every route except `/health` and
`/api/auth/*`. It validates the session via `auth.api.getSession({ headers })` (the proxy
forwards the `Cookie` header). 401 on missing/invalid session.

### SSE auth (the one cross-origin case)

The web-domain session cookie is **not** sent to the backend domain (cross-site). So:

1. Frontend calls authenticated `GET /api/auth-ticket` (same-origin via proxy, cookie
   sent) → backend returns a short-lived (~60s) **HMAC ticket** (`userId.exp.sig`, signed
   with `AUTH_SECRET` via WebCrypto).
2. Frontend opens `${API_BASE}/runs/:id/events?ticket=<ticket>`.
3. The `requireAuth` middleware verifies the ticket for `*/events` paths instead of the
   cookie. No long-lived token in JS; the HttpOnly cookie stays the real session.

CORS is unchanged — the ticket is a query param, so no new headers / credentials.

### Frontend gating (optimistic only)

Next 16 `proxy.ts` (renamed from `middleware.ts`) does an **optimistic** redirect: if the
better-auth session cookie is absent, redirect to `/login`. Real enforcement is the
backend middleware. Skips `/login`, `/signup`, `/verify`, static assets, and is a no-op
when `AUTH_DISABLED=true` (local dev against the Python backend, which has no auth routes).

## Domain allowlist

Enforced server-side in a better-auth `hooks.before` on `/sign-up/email`: reject emails
whose domain is not in `ALLOWED_EMAIL_DOMAINS` (env, **default `bowtie.com.hk`**). Stored
as an env var so the allowlist can change without a code deploy (e.g. add `bowtie.com.sg`).

## Email (Resend)

`emailVerification.sendVerificationEmail` (and `sendResetPassword`) POST to
`https://api.resend.com/emails` with `RESEND_API_KEY`, `from = RESEND_FROM`. Requires a
verified sending domain in Resend (DNS SPF/DKIM for the `from` domain) — an ops dependency.

## Data model (better-auth core, `content_tool` schema, snake_case)

Tables: `user`, `session`, `account`, `verification`. RLS enabled + `content_tool_app`
permissive policies + grants, mirroring `dedicated_app_role.sql`.

## Secrets / config

| Key | Kind | Where |
|---|---|---|
| `AUTH_SECRET` | secret | `wrangler secret put` (backend) |
| `RESEND_API_KEY` | secret | `wrangler secret put` (backend) |
| `RESEND_FROM` | var | `wrangler.jsonc` (e.g. `Bowtie Content Desk <noreply@bowtie.com.hk>`) |
| `ALLOWED_EMAIL_DOMAINS` | var | `wrangler.jsonc` (default `bowtie.com.hk`) |
| `AUTH_DISABLED` | var | unset in prod; `true` for local dev |

## Acceptance

- Unauthenticated REST → 401; unauthenticated page load → redirect to `/login`.
- Signup with non-@bowtie.com.hk email → rejected.
- Signup with @bowtie.com.hk → verification email sent; sign-in blocked until verified.
- After verify + login → app loads, SSE streams (ticket path), sign-out works.
- `supabase db reset` applies the auth migration cleanly; local dev unaffected when
  `AUTH_DISABLED=true`.
