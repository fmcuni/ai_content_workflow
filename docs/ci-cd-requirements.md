# CI/CD Requirements — Infra Team

Concise infra checklist for the Bowtie AI Content Tool pipelines. Scope: this
app ships **public marketing/editorial content only** — no PII/PHI/HKID. Standard
secret hygiene still applies (no secrets in commits, logs, or external tool calls).

## Pipelines (GitHub Actions)

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | PR + push to `main` | Lint (ruff, changed files), pyright (advisory), `pytest`; eval-wiring on `prompt-change` label |
| Deploy Workers | `.github/workflows/deploy-workers.yml` | push to `main` (paths) + manual | Deploy backend + frontend Workers to Cloudflare |
| Nightly Evals | `.github/workflows/nightly-evals.yml` | cron `0 18 * * *` (02:00 HKT) + manual | LLM-judge evals over last 30 published prod runs |

## Required GitHub repo secrets

| Secret | Used by | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy Workers | Token scoped to **Workers Scripts: Edit** on the `fmc` account |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy Workers | Target Cloudflare account id (`fmc`) |
| `GEMINI_API_KEY` | CI (judge-evals), Nightly Evals | Google AI Studio key; LLM-judge + eval passes |
| `POSTGRES_URL` | Nightly Evals | **Prod Supabase** connection string (evals read real published runs) |

`wrangler` reads `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from the env automatically.

## Cloudflare (deploy targets)

Two Workers on the `fmc` account (`*.fmc.workers.dev`):

| Worker | Source | URL |
|---|---|---|
| `bowtie-content-tool-poc` (backend) | `deploy/cloudflare-workers/` | `https://bowtie-content-tool-poc.fmc.workers.dev` |
| `bowtie-content-tool-web` (frontend) | `web/` (OpenNext) | `https://bowtie-content-tool-web.fmc.workers.dev` |

- Frontend deploys **after** backend (`needs: deploy-backend`).
- Deploy concurrency group `deploy-workers`, `cancel-in-progress: false` — never cancel an in-flight deploy.
- **Runtime secrets are NOT synced by CI.** `POSTGRES_URL`, `GEMINI_API_KEY`, `WP_*`
  are set once per Worker via `wrangler secret put` and preserved across deploys.
  Infra owns rotating these out-of-band.
- DB access is via **Hyperdrive → Supabase direct connection (port 5432)**. Never the
  transaction-mode pooler (6543) — it breaks prepared statements.

## Branch protection (`main`) — recommended

- Require **CI** to pass before merge.
- Require PR review (RBAC: admin/editor; bootstrap admin `franco.ma@bowtie.com.hk`).
- `deploy-workers` runs only on `main`; keep `main` protected so deploys are reviewed.

## Runner / environment baselines

- **Python**: managed by `uv` (`astral-sh/setup-uv@v3`, cache enabled).
- **Node**: v22 for both Worker deploys.
- Worker deps install with `npm install` (not `npm ci`) — lockfile is macOS-generated
  and omits linux-only native deps; `npm ci` fails on ubuntu runners.
- Nightly evals must run on **US-hosted runners** — AI Studio is geo-blocked from some
  colos (incl. the HK Cloudflare colo); GitHub's US runners reach it fine.

## Known gates / policy

- **Ruff**: gates on *changed* `.py` files only (large pre-existing baseline).
- **Pyright**: advisory (`continue-on-error`) — ~547-error strict baseline; do not block.
- **DB schema**: owned by **Supabase migrations** (`supabase db push` to prod), not Alembic (retired).
  CI applies schema via the supabase migrations (`tests/conftest.py` `apply_migrations`); there is no Alembic step.

## Infra action items

1. Confirm all four repo secrets exist and target the `fmc` account / prod Supabase.
2. Verify per-Worker runtime secrets are set (`wrangler secret list`) and document rotation cadence.
3. Enable branch protection on `main` (require CI + review).
4. Monitor nightly-evals success and the `deploy-workers` run on each `main` push.
5. Track `CLOUDFLARE_API_TOKEN` / `GEMINI_API_KEY` expiry and rotation ownership.
