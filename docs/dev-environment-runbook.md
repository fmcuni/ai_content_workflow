# Dev environment runbook (Cloudflare Workers)

A parallel **dev** copy of the production Workers stack, deployed via Wrangler
**named environments** (`--env dev`). It mirrors prod's bindings but is fully
isolated: a **separate dev Supabase DB**, its own Hyperdrive, and its own
Durable Object namespaces + Workflows. Deploys are **manual** (no CI).

| | Production | Dev |
|---|---|---|
| Backend Worker | `bowtie-content-tool-poc` | `bowtie-content-tool-poc-dev` |
| Frontend Worker | `bowtie-content-tool-web` | `bowtie-content-tool-web-dev` |
| Backend URL | `…-poc.fmc.workers.dev` | `…-poc-dev.fmc.workers.dev` |
| Frontend URL | `…-web.fmc.workers.dev` | `…-web-dev.fmc.workers.dev` |
| Database | prod Supabase (`gfpkqsiyeslscgsuehmj`) | **separate dev Supabase project** |
| Refresh-scan cron | `0 2 * * *` | **disabled** (`crons: []`) |
| WordPress | prod creds | **same as prod** ⚠️ dev approvals publish to **live** sites |

Config lives in `deploy/cloudflare-workers/wrangler.jsonc` (`env.dev`) and
`web/wrangler.jsonc` (`env.dev`). Both are already in place; this runbook covers
the one-time provisioning of the dev DB + secrets, then deploy.

> ⚠️ **WordPress is shared with prod by design choice.** Approving HITL_2 in dev
> publishes to the real CMS. Treat dev publishing with the same care as prod.

---

## ✅ Provisioned 2026-06-10 — current live dev environment

The dev environment below is **already provisioned and deployed**. Steps 0–5 are
the reproducible recipe (and what to do if you tear down and rebuild).

| Resource | Value |
|---|---|
| Dev Supabase project | `bowtie-content-tool-dev` — ref **`ovxvhxwmqeccjudhyfbh`** (`ap-southeast-1`) |
| Dev Hyperdrive | `bowtie-poc-db-dev` — id **`98015877c2cc48f4b047f340129df945`** |
| Backend Worker | https://bowtie-content-tool-poc-dev.fmc.workers.dev (`/health` → ok) |
| Frontend Worker | https://bowtie-content-tool-web-dev.fmc.workers.dev (→ `/login`) |
| Migrations + seed | all 30 applied + personas seeded |
| Backend secrets | 16 set (DB→dev; GEMINI/WP/VHIS101_WP→prod values; AUTH_SECRET fresh; LANGFUSE off) |
| Local secrets file | `.env.dev.local` (gitignored) — dev DB password, anon + service_role keys, POSTGRES_URL |
| JWKS | dev project already serves an asymmetric **ES256** key → backend JWKS verification works |

> ⚠️ **`n8n-tables` was PAUSED** to free a free-tier project slot. Restoring it
> would re-hit the 2-active-free-project limit unless the org is upgraded.

### ⏳ Remaining (dashboard-only) — required for browser login

Browser sign-in is **Google OAuth only**, and Google is **not yet enabled** on the
dev project. Enable it in the dev Supabase dashboard
(https://supabase.com/dashboard/project/ovxvhxwmqeccjudhyfbh):

1. **Auth → Providers → Google** — enable. Simplest: reuse the **same Google OAuth
   client as prod** — add `https://ovxvhxwmqeccjudhyfbh.supabase.co/auth/v1/callback`
   to that client's Authorized redirect URIs in Google Cloud, then paste the same
   client id + secret into dev Supabase.
2. **Auth → URL Configuration** — Site URL `https://bowtie-content-tool-web-dev.fmc.workers.dev`;
   add `https://bowtie-content-tool-web-dev.fmc.workers.dev/verify` (and `/**`) to
   the redirect allow-list.

Email/password is already enabled (for the e2e service account). `BOOTSTRAP_ADMIN_EMAILS`
is set to `franco.ma@bowtie.com.hk`, so signing in with that Google account grants admin.

---

## Step 0 — Provision the dev Supabase DB

> ⚠️ **Free-tier limit:** Supabase allows **2 active projects per org** and the
> org (`lyswxytvxkaxdeelssqa`) already has 2 (`ai-content-tool`, `n8n-tables`).
> A 3rd project requires upgrading the org to **Pro** (paid), pausing/deleting an
> existing project, or using a Supabase **branch** instead of a standalone
> project. Decide this before proceeding — it's a cost decision.

Create the project (dashboard or CLI), then collect from
**Project Settings → API / Database**:

- Project ref + URL → `https://<dev-ref>.supabase.co`
- `anon` public key
- `service_role` key
- DB connection string — **session-mode pooler, port 5432** (never the
  transaction pooler on 6543; it breaks prepared statements)

Then, in the dev project's dashboard:

1. **Auth → Providers → Google** — enable, with a Google Cloud OAuth Web client
   whose authorized redirect URI is `https://<dev-ref>.supabase.co/auth/v1/callback`.
2. **Auth → URL Configuration** — add the dev web origin's `/verify` to the
   redirect allow-list: `https://bowtie-content-tool-web-dev.fmc.workers.dev/verify`.
3. **Auth → Signing Keys** — enable **asymmetric (RS256/ES256) JWTs**. With
   `AUTH_PROVIDER=supabase` the backend verifies via JWKS and has **no HS256
   fallback** — if this is off, every dev request 401s.
4. Keep **email/password** enabled for the `content-tool-e2e` service account
   (Playwright mints sessions via password grant; OAuth can't run headless).

## Step 1 — Apply schema + seed to the dev DB

The dev DB starts empty. Apply all migrations and seed personas.

```bash
# Link the Supabase CLI to the dev project (interactive; enter its ref):
supabase link --project-ref <dev-ref>

# Push every migration in supabase/migrations/ to the dev project:
supabase db push

# Seed personas (and any other seed rows):
psql "<DEV_DIRECT_OR_POOLER_CONNECTION_STRING>" -f supabase/seed.sql
```

> The `content_tool.app_user` migration (`20260613000000_app_user.sql`) MUST be
> applied before the backend reads roles. `supabase db push` applies it.

After push, pre-create your admin `app_user` row (or rely on
`BOOTSTRAP_ADMIN_EMAILS`) so you can sign in — invite-only is enforced at the
authz layer; an authenticated user with no `app_user` row gets 401.

## Step 2 — Create the dev Hyperdrive + fill placeholders

```bash
cd deploy/cloudflare-workers

# Reads the dev connection string from your gitignored .env.local without the
# value entering the shell history/logs. Adjust the key name as needed.
DEV_PG=$(grep -m1 '^DEV_POSTGRES_URL=' ../../.env.local | sed 's/^[^=]*=//')
npx wrangler hyperdrive create bowtie-poc-db-dev --connection-string "$DEV_PG"
```

Copy the returned Hyperdrive **id** into `deploy/cloudflare-workers/wrangler.jsonc`
→ `env.dev.hyperdrive[0].id` (replace `REPLACE_DEV_HYPERDRIVE_ID`), and replace
`env.dev.vars.SUPABASE_URL` (`REPLACE_DEV_SUPABASE_REF`) with the dev project URL.

## Step 3 — Set dev secrets

Secrets are **per-environment** (`--env dev` stores them on the `-poc-dev`
Worker). Set the dev DB ones to **dev** values; copy the rest from prod.

Use the pipe pattern so values never enter the conversation/logs (reading from
the gitignored `.env.local`):

```bash
cd deploy/cloudflare-workers
put() { grep -m1 "^$1=" ../../.env.local | sed 's/^[^=]*=//' | tr -d '\n' \
  | npx wrangler secret put "$1" --env dev; }

# DEV-specific values (point at the dev DB / project):
put POSTGRES_URL                 # dev session-pooler connection string
put SUPABASE_SERVICE_ROLE_KEY    # dev project service_role key

# Same as prod (copy the prod values into .env.local first, or re-enter):
put GEMINI_API_KEY
put AUTH_SECRET                  # or generate a fresh one for dev
put RESEND_API_KEY
put BOOTSTRAP_ADMIN_EMAILS
put WP_BASE_URL ; put WP_USERNAME ; put WP_APP_PASSWORD ; put WP_TARGET
put VHIS101_WP_BASE_URL ; put VHIS101_WP_USERNAME ; put VHIS101_WP_APP_PASSWORD

# Optional (dev tracing); omit to disable Langfuse in dev:
# put LANGFUSE_ENABLED ; put LANGFUSE_HOST ; put LANGFUSE_PUBLIC_KEY
# put LANGFUSE_SECRET_KEY ; put LANGFUSE_TRACING_ENVIRONMENT
```

Full prod secret set (for reference): `AUTH_SECRET`, `BOOTSTRAP_ADMIN_EMAILS`,
`GEMINI_API_KEY`, `LANGFUSE_*` (5), `POSTGRES_URL`, `RESEND_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `WP_*` (4), `VHIS101_WP_*` (3).
`SUPABASE_URL` is a **var** (in wrangler.jsonc), not a secret. There is no
`SUPABASE_JWT_SECRET` (JWKS is authoritative).

Remember to delete any prod values you copied into `.env.local` when done.

## Step 4 — Deploy

```bash
# Backend first (frontend points at it):
cd deploy/cloudflare-workers && npm run deploy:dev

# Frontend — NEXT_PUBLIC_* are BUILD-TIME; pass them at deploy time:
cd ../../web
NEXT_PUBLIC_API_BASE=https://bowtie-content-tool-poc-dev.fmc.workers.dev \
NEXT_PUBLIC_AUTH_PROVIDER=supabase \
NEXT_PUBLIC_SUPABASE_URL=https://<dev-ref>.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<dev anon key> \
NEXT_PUBLIC_COLLAB_ENABLED=true \
npm run cf:deploy:dev
```

On the **first** backend deploy, Wrangler applies DO migrations v1–v5 to the new
`-poc-dev` Worker (creating its isolated `RunStream`/`GeminiProxy`/`RunDoc`
namespaces).

## Step 5 — Verify

```bash
curl -s https://bowtie-content-tool-poc-dev.fmc.workers.dev/health     # 200
curl -s -o /dev/null -w '%{http_code}\n' \
  https://bowtie-content-tool-web-dev.fmc.workers.dev                  # 307 → /login
```

Then sign in to the dev web URL with Google (on an email that has an `app_user`
row or is in `BOOTSTRAP_ADMIN_EMAILS`) and run a pipeline end-to-end.

---

## Teardown / rollback

```bash
# Remove the dev Workers:
cd deploy/cloudflare-workers && npx wrangler delete --env dev
cd ../../web && npx wrangler delete --env dev

# Remove the dev Hyperdrive:
npx wrangler hyperdrive delete <DEV_HYPERDRIVE_ID>

# Pause/delete the dev Supabase project from its dashboard.
```

Dev is independent of prod — deleting it never affects the prod Workers, DB, or
Durable Object state.

## Notes

- **Local dev** of the backend can still use `npm run dev` (`wrangler dev`);
  point `.dev.vars` at whatever DB you want. This runbook is for a *deployed*
  remote dev environment.
- The cron is intentionally disabled in dev. To run a one-off refresh scan in
  dev, trigger the Workflow manually:
  `npx wrangler workflows trigger refresh-scan-dev --env dev`.
- Keep the 4-role authz maps (`authz.ts` ↔ `web/lib/roles.ts`) unchanged; dev
  uses the same code as prod.
