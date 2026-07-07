# Secrets & CI/env management

How configuration and secrets flow through the Bowtie AI Content Tool across
**local**, **dev**, and **prod**, and how CI deploys each. Scope note: this tool
handles public marketing/editorial content only — no customer PII/PHI. Standard
secret hygiene still applies (no secrets in commits, logs, or external tools).

Last reviewed: 2026-06-16.

## Where config lives (the four stores)

| Store | Holds | Source of truth for |
|---|---|---|
| **Committed SSOT** (`web/env.{prod,dev}.public`, `deploy/cloudflare-workers/wrangler.jsonc` `vars`) | Non-secret build-time + runtime config | `NEXT_PUBLIC_*`, `GEMINI_MODEL`, `SUPABASE_URL`, `FRONTEND_ORIGIN` |
| **GitHub Actions secrets** (`fmcuni/ai_content_workflow`) | CI-time secrets | Deploy creds, build-time anon keys, evals creds |
| **Cloudflare Worker secrets** (`wrangler secret`, per env) | Backend runtime secrets | DB, Gemini, Supabase service-role, WordPress |
| **Local `.env*` / `.dev.vars`** (gitignored) | Local dev + manual-deploy fallbacks | Operator's machine only |

### Build-time vs runtime — the rule that bit us repeatedly

`NEXT_PUBLIC_*` values are **inlined into the web bundle at build time**. They
cannot be changed by a runtime secret. Historically they were hand-typed inline
on every `cf:deploy:dev`, which repeatedly baked the wrong API base / Supabase
URL and bounced dev auth. They now live in **one committed file per env** and
are parsed (never shell-`source`d) by `scripts/deploy-web.mjs`. The public file
is **authoritative** — it overrides any stray inline `NEXT_PUBLIC_*` so a
mistyped shell var can no longer reach the bundle.

The only secret in the web build is the Supabase **anon key** (a public client
key, kept out of git by policy): CI injects it from a GH secret; local deploys
read it from the gitignored `.env*` file.

## GitHub Actions secrets (canonical repo: `fmcuni/ai_content_workflow`)

| Secret | Used by | Notes |
|---|---|---|
| `CF_ALT_API_TOKEN` | all deploy workflows | Franco's "Bowtie Content SEO" Cloudflare account (franco-ma.workers.dev) — the **only** account in use since the `fmc.workers.dev` account was deprecated 2026-07-07. Historically the "alt" account name; both workflows now use this pair as the sole target |
| `CF_ALT_ACCOUNT_ID` | all deploy workflows | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `deploy-workers.yml` (prod web build) | public client key |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY_DEV` | `deploy-workers-dev.yml` (dev web build) | public client key |
| `GEMINI_API_KEY` | `nightly-evals.yml` | LLM-judge pass |
| `POSTGRES_URL` | `nightly-evals.yml` | prod Supabase conn string for evals |

> `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (the old `fmc.workers.dev`
> creds) are no longer referenced by any workflow and can be deleted from repo
> secrets once the deprecated account is fully wound down.

### fmc account wind-down checklist

1. **Drain in-flight fmc runs first** — workflow/DO state is account-local, so
   any run started on the fmc site can only be approved/published at
   `bowtie-content-tool-web.fmc.workers.dev` (until step 2 replaces it).
2. Deploy the redirect stubs over both fmc frontend Workers
   (`deploy/fmc-redirect/`, fmc creds, one-off).
3. **Delete both fmc backend Workers** (`wrangler delete` for
   `bowtie-content-tool-poc` and `bowtie-content-tool-poc-dev` with fmc creds).
   Until deleted they stay live with valid `POSTGRES_URL` (prod Supabase) and
   `WP_*` secrets — able to write prod data and publish to the shared live CMS.
4. Delete the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets.
5. Optional tidy-up: remove the fmc `/verify` URLs from the Supabase auth
   redirect allow-lists (prod + dev projects).

> The `bowtie-ins` mirror holds **no** secrets; every deploy/evals job is gated
> `if: github.repository_owner == 'fmcuni'` so the mirror never runs red.

## Cloudflare Worker secrets

Backend (`bowtie-content-tool-poc` / `-dev`) — set once via
`wrangler secret put [--env dev]`, preserved across deploys, **never synced by
CI**. The expected name set is pinned in `scripts/worker-secrets.json` and
enforced by the drift guard (below).

- **Required:** `AUTH_SECRET`, `BOOTSTRAP_ADMIN_EMAILS`, `GEMINI_API_KEY`,
  `POSTGRES_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WP_TARGET`, `WP_BASE_URL`,
  `WP_USERNAME`, `WP_APP_PASSWORD`
- **Optional:** `LANGFUSE_*`, `VHIS101_WP_*`, `HKVHIS_WP_*`, `HCHK_GT_*` (Ghost
  publish target: `HCHK_GT_API_URL` + `HCHK_GT_ADMIN_API_KEY`)

The frontend Worker (`bowtie-content-tool-web` / `-dev`) has **no** runtime
secrets — everything is build-time `NEXT_PUBLIC_*`.

## CI workflows

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | PR / push to main (Python paths) | ruff + pyright (advisory) + pytest |
| `deploy-workers.yml` | push to main | secret drift-guard → deploy **prod** backend + frontend |
| `deploy-workers-dev.yml` | **manual** (`workflow_dispatch`) | secret drift-guard → deploy **dev** backend + frontend |
| `nightly-evals.yml` | nightly cron + manual | LLM-judge evals against prod Supabase |
| `collab-e2e.yml` | manual | live two-context collab e2e on a throwaway local DB |

### Deploy commands (local equivalents)

| | Backend | Frontend |
|---|---|---|
| prod | `cd deploy/cloudflare-workers && npm run deploy` | `cd web && npm run cf:deploy` |
| dev | `cd deploy/cloudflare-workers && npm run deploy:dev` | `cd web && npm run cf:deploy:dev` |

`cf:deploy` / `cf:deploy:dev` now call `scripts/deploy-web.mjs`, so local and CI
deploys produce identical bundles from the same SSOT.

### Secret drift guard

`node scripts/check-secrets.mjs [--env dev] [--strict]` compares the **live**
Worker secret names against `scripts/worker-secrets.json` (names only — values
are never read). Fails on a missing **required** secret; warns on an
unexpected/stale name (`--strict` makes that fatal). Runs as a pre-deploy gate
in both deploy workflows. This is the check that would have flagged the now-
removed stale `RESEND_API_KEY`.

When adding/removing a backend secret, update `scripts/worker-secrets.json` in
the same change.

## Dev↔prod workflow

1. Develop + verify on **dev** first (`deploy-workers-dev.yml` or the `:dev`
   npm scripts). See `docs/dev-environment-runbook.md`.
2. Apply DB migrations to **both** (dev `supabase db push --db-url "$DEV_POSTGRES_URL"`,
   prod `supabase db push`).
3. Merge to `main` → `deploy-workers.yml` auto-deploys prod.
4. Runtime data (voices/prompts) is **not** auto-synced between dev and prod.

---

## Governance risk (in progress — see #CQE60PTQC on Slack)

The production stack currently runs through **personal** accounts:

- **Canonical repo** is a personal GitHub fork (`fmcuni/ai_content_workflow`),
  not the org (`bowtie-ins`). All deploy + evals secrets live there.
- **Cloudflare account** is personal (Franco's "Bowtie Content SEO" account,
  franco-ma.workers.dev — as of 2026-07-07 this is the *only* Cloudflare
  account in use; the previous `fmc.workers.dev` account has been deprecated).
  It holds the prod deploy token and — via Worker secrets — the **Supabase
  `service_role` key**, WordPress app passwords, and the Gemini key.
- **Supabase** prod project is reachable with the same personal-account creds.

Even though the tool handles only public content, concentrating prod deploy keys
and a Supabase service-role key on personal accounts is a continuity and access-
control risk (bus factor, offboarding, audit). **Raise with the relevant Bowtie
team** (IT / security) before this tool takes on any private data or external
collaborators.

### Migration plan (in progress)

CI/CD is also moving fully off GitHub Actions secrets — per Gabriel's call,
Cloudflare **Workers Builds** (native git integration) replaces `wrangler
deploy` invoked from GH Actions, since each Worker's build-time API token is
then generated and held entirely by Cloudflare, never a GitHub secret.

1. **Prod** moves to the company-owned **Bowtie Enterprise Account**
   (`49e489ec5d8bc26e6ae71632052b1add` — already hosts other Bowtie internal
   tools like `bowtie-drop`). This needs a new Hyperdrive config (Hyperdrive is
   account-scoped) and a full secret rotation (see below) on the new account.
2. **Dev** stays on Franco's account for now (decided for speed) — revisit once
   prod migration is proven out.
3. For each of the 4 Workers, connect it to this GitHub repo via **Settings →
   Builds → Connect** in the Cloudflare dashboard, with a root directory of
   `deploy/cloudflare-workers` (backend) or `web` (frontend), a deploy command
   of `npx wrangler deploy` (or `npx wrangler deploy --env dev` for the dev
   Worker), and the one build-time secret
   (`NEXT_PUBLIC_SUPABASE_ANON_KEY[_DEV]`) set as a Cloudflare-side build
   variable instead of a GitHub secret. Chain `node ../../scripts/smoke-check.mjs
   <url>/login` onto the frontend deploy command (see `scripts/smoke-check.mjs`).
4. Once all 4 Workers build+deploy successfully via Workers Builds, **delete**
   `.github/workflows/deploy-workers.yml` and `deploy-workers-dev.yml`, and
   remove the (by-then-unused) `CF_ALT_*` / `CLOUDFLARE_*` / anon-key GH secrets.
5. Rotate every backend secret during the prod account move (treat the old
   personal-account copies as exposed): Supabase service-role + anon, Gemini,
   WordPress app passwords, `AUTH_SECRET`.
6. Set GitHub branch protection on `main` requiring review before merge — this
   is now the production approval gate (there's no GitHub deploy step left to
   gate with a required-reviewer Environment).
7. Separately (not blocking the above): decide the canonical GitHub repo home
   (`bowtie-ins` vs the personal `fmcuni` fork), and re-point `supabase`
   project ownership to the Bowtie org.

### Interim state (as of 2026-07-07)

`deploy-workers.yml` / `deploy-workers-dev.yml` still run via GitHub Actions,
now pointed at the single real account (`CF_ALT_API_TOKEN`/`CF_ALT_ACCOUNT_ID`
— the `fmc.workers.dev` creds are unused). This is a stop-gap kept only because
the deprecated `fmc` account would otherwise have broken CI outright; it should
be replaced by the Workers Builds plan above, not treated as the end state.
