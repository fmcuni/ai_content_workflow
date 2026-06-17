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
| `CLOUDFLARE_API_TOKEN` | all deploy workflows | Pin to least-privilege (Workers Scripts:Edit on the fmc account) |
| `CLOUDFLARE_ACCOUNT_ID` | all deploy workflows | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `deploy-workers.yml` (prod web build) | public client key |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY_DEV` | `deploy-workers-dev.yml` (dev web build) | public client key |
| `GEMINI_API_KEY` | `nightly-evals.yml` | LLM-judge pass |
| `POSTGRES_URL` | `nightly-evals.yml` | prod Supabase conn string for evals |

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
- **Optional:** `LANGFUSE_*`, `VHIS101_WP_*`, `HKVHIS_WP_*`

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

## Governance risk (for escalation to Bowtie — NOT yet actioned)

The production stack currently runs through **personal** accounts:

- **Canonical repo** is a personal GitHub fork (`fmcuni/ai_content_workflow`),
  not the org (`bowtie-ins`). All deploy + evals secrets live there.
- **Cloudflare account** is personal (`fmc.workers.dev`). It holds the prod
  deploy token and — via Worker secrets — the **Supabase `service_role` key**,
  WordPress app passwords, and the Gemini key.
- **Supabase** prod project is reachable with the same personal-account creds.

Even though the tool handles only public content, concentrating prod deploy keys
and a Supabase service-role key on personal accounts is a continuity and access-
control risk (bus factor, offboarding, audit). **Raise with the relevant Bowtie
team** (IT / security) before this tool takes on any private data or external
collaborators.

### Suggested migration outline (when approved)

1. Create/confirm a **Bowtie-owned** GitHub home for the repo under `bowtie-ins`
   (or a dedicated org), make it canonical, retire the personal fork as a mirror.
2. Move CI to a **Bowtie-owned Cloudflare account**; reissue
   `CLOUDFLARE_API_TOKEN` scoped least-privilege; re-run `wrangler secret put`
   for all backend secrets on the new account.
3. Rotate every secret during the move (treat the old personal-account copies as
   exposed): Supabase service-role + anon, Gemini, WordPress app passwords,
   `AUTH_SECRET`.
4. Adopt **GitHub Environments** (`production`, `dev`) with environment-scoped
   secrets + a required-reviewer protection rule on `production`, so a dev
   workflow can't read prod secrets and prod deploys gain an approval gate.
5. Re-point `supabase` project ownership / link to the Bowtie org.

### Interim guardrail (no account move needed)

Wrap the prod deploy in a GitHub `production` Environment with a required
reviewer, and scope `CLOUDFLARE_*` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` to it. This
adds an approval gate and blast-radius isolation while staying on the current
accounts.
