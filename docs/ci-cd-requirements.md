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

## Database & migrations (Supabase)

> ⚠️ **Migrations are NOT automated.** No GitHub workflow runs `supabase db push`.
> Schema changes reach prod via a **manual** step that must be ordered correctly.

- **Source of truth:** `supabase/migrations/*.sql` (applied in sorted order) + `supabase/seed.sql`.
- **Prod apply:** `supabase db push` against the linked Supabase project — run **manually**
  by whoever owns the change.
- **Ordering (critical):** a migration must be pushed to prod **before** the code that
  depends on it is deployed. `deploy-workers` auto-fires on push to `main`, so for any
  schema-coupled PR: **`supabase db push` first, confirm, then merge.**
- **Schema:** `content_tool` (not `public`); RLS enabled on all tables; app connects via the
  `content_tool_app` role, never the `postgres` superuser.
- **Connection:** direct connection (port 5432), or session-mode pooler if IPv4-only.
  **Never** the transaction-mode pooler (6543) — it breaks prepared statements.
- **Backend↔backend parity:** Python (SQLAlchemy/asyncpg) and Workers (`postgres.js` via
  Hyperdrive) hit the **same** Supabase DB. Canonical JSON serializers must stay
  byte-identical across both (prompt/policy SHA parity).
- **Local:** `supabase db reset` (wipe + re-apply all migrations). CI applies the same
  migrations via `tests/conftest.py` `apply_migrations` — there is no Alembic step (retired).
- **Prod cutover runbook (E1–E9):** see Notion (linked from `CLAUDE.md` → Supabase).

### Portability / alternatives (e.g. AWS)

The app is **Postgres-native** — no PostgREST, Supabase Auth, or `supabase-js` (auth is
`better-auth` in our own migrations). So it runs on **any managed Postgres 16**: Amazon RDS
for PostgreSQL or Aurora PostgreSQL-Compatible, Neon (pairs naturally with Hyperdrive/Workers),
Google Cloud SQL, or Azure Database for PostgreSQL. **Portable, but not drop-in** — the
`baseline.sql` dump carries unused Supabase-only artifacts that error on vanilla Postgres.

**Work needed to port to AWS (RDS/Aurora):**

1. **Sanitize `baseline.sql`** — remove Supabase-only objects (none are used by the app):
   `CREATE EXTENSION pg_net / pg_graphql / supabase_vault`, the `ALTER PUBLICATION
   supabase_realtime` line, and the `graphql`/`vault` schemas. Keep `pgcrypto`, `uuid-ossp`,
   `pg_stat_statements` (available on RDS/Aurora).
2. **Replace Supabase roles** — RLS hardening revokes from `anon`/`authenticated`/`service_role`
   (Supabase-created). On RDS, drop those revokes; keep `content_tool_app` as the app role and
   the `content_tool` schema grants. Provision `content_tool_app` via the migration / IAM.
3. **Swap migration tooling** — replace the `supabase` CLI (`db push` / `db reset`) with a
   vendor-neutral runner: `psql -f` in order, or dbmate / sqitch. Update CI's
   `tests/conftest.py apply_migrations` only if the file layout changes (it already applies
   raw `*.sql`, so it's reusable).
4. **Repoint connections** — set `POSTGRES_URL` (Python + Nightly Evals) and the **Hyperdrive**
   binding (Workers) to the RDS endpoint. Use the direct connection or RDS Proxy; keep prepared
   statements working (the Supabase 6543 transaction-pooler caveat becomes "use RDS Proxy in
   session pinning or connect direct").
5. **Networking/secrets** — RDS in a VPC needs a publicly-reachable path or PrivateLink for
   Hyperdrive + GitHub runners; rotate `POSTGRES_URL` secret; enforce TLS (`sslmode=require`).
6. **Cutover** — dump `content_tool` data from Supabase (`pg_dump --schema=content_tool`),
   restore to RDS, verify row counts + RLS, then flip the connection strings.

Est. effort: ~0.5–1 day (mostly baseline sanitizing + cutover rehearsal); no application code
changes beyond connection config.

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
6. Own the **manual migration step**: for schema-coupled changes, `supabase db push` to
   prod **before** merge triggers `deploy-workers`. Consider gating this with a release
   checklist (or automating it ahead of deploy) so code never deploys ahead of its schema.
