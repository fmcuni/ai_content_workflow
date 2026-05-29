# Plan: Migrate `ai_content_tool_2` DB to Supabase

**Date:** 2026-05-28
**Owner:** Franco Ma
**Status:** Phases A–D complete. Phase F complete 2026-05-29. Awaiting compliance sign-off before Phase E.

## 0. Guiding decisions (locked)

| Decision | Choice | Implication |
|---|---|---|
| Scope | Supabase as managed Postgres only | No PostgREST, no Supabase Auth, no `supabase-js` in `web/`. SQLAlchemy/asyncpg keeps owning data access. FastAPI + LangGraph + WordPress publishing keep running locally/on existing host. |
| Schema location | Keep `content_tool` schema (not `public`) | Not auto-exposed to PostgREST/Data API — safer for PII/PHI. Still enable RLS per Supabase skill rule 5 (defense in depth). |
| Migration history | Baseline-and-freeze | Apply Alembic 0001–0016 once on fresh Supabase DB, capture as one `supabase/migrations/<ts>_baseline.sql`, retire Alembic. |
| Targets | Local dev (`supabase start`) → Prod cutover | No separate cloud staging. Local Supabase is the rehearsal env. |
| Compliance | PHI/PII data | Pick a Supabase region close to HK (recommend **ap-southeast-1 Singapore**); request SOC 2 / signed DPA before any prod data lands. Flag to Bowtie security/compliance via Slack before cutover. |

> **Precondition to fix first:** `supabase` is not on `PATH` in this shell. Either `brew install supabase/tap/supabase` or add the install dir to `~/.zshrc`. Verify with `supabase --version` and `supabase projects list`.

## Current-state snapshot

- Backend: FastAPI + SQLAlchemy async + asyncpg, schema in `content_tool` Postgres schema, **16 Alembic migrations** (`migrations/versions/0001…0016`), JSONB/UUID-heavy.
- Frontend: Next.js 16 + TanStack Query → hits FastAPI directly. **No auth layer today.**
- No `supabase/` directory in the repo. Skills already vendored at `.agents/skills/supabase` and `.agents/skills/supabase-postgres-best-practices`.
- DB URL flows through `Settings.postgres_url` in `content_tool/config.py:12` and is consumed in `content_tool/api/main.py:37` and `migrations/env.py`.

---

## 1. Phase A — Local rehearsal (no prod data)

**Goal:** prove the app runs unchanged against Supabase-flavoured Postgres.

1. `supabase init` at repo root → creates `supabase/config.toml` and `supabase/migrations/`. Commit `supabase/config.toml`; add `supabase/.branches/` and `supabase/.temp/` to `.gitignore`.
2. `supabase start` → boots local Postgres + Studio + Auth + Storage in Docker. We only need DB; rest is harmless.
3. Point Alembic at local Supabase DB:
   ```
   POSTGRES_URL=postgresql+asyncpg://postgres:postgres@127.0.0.1:54322/postgres
   ```
   then `alembic upgrade head`. Confirms all 16 migrations apply cleanly on Supabase's Postgres build.
4. Boot the FastAPI + Next.js stack against the local Supabase DB; run the existing pytest integration suite (`pytest tests/integration`) end-to-end against it. **Acceptance gate: full suite green.**
5. Run `supabase db advisors` (CLI v2.81.3+) → fix any CRITICAL findings before continuing. Expected hits: missing indexes flagged by query advisor; `content_tool` schema not yet enabled for RLS (handled in Phase C).

## 2. Phase B — Capture the baseline migration

**Goal:** one Supabase-native SQL file that reproduces the current schema; Alembic retired.

1. With local Supabase fully migrated (Phase A), run:
   ```
   supabase db pull baseline --local --yes --schema content_tool
   ```
   Produces `supabase/migrations/<ts>_baseline.sql`. Hand-review for:
   - `CREATE SCHEMA content_tool` at the top.
   - Extensions: `pgcrypto` is preinstalled on Supabase, but if any migration relied on `uuid-ossp` add `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;` (Supabase convention: extensions live in `extensions` schema, not `public`).
   - `alembic_version` table — drop it from the baseline, or move under `content_tool` and document it as dormant.
2. Wipe local DB, re-apply: `supabase db reset` → must produce identical schema. Acceptance: `pg_dump --schema-only` diff between Alembic-applied DB and baseline-applied DB is empty (modulo ordering).
3. Delete `migrations/` (Alembic) and `alembic.ini` **in the same commit** as the baseline SQL — no parallel-systems window. Update `pyproject.toml` to drop `alembic` dep. Update `CLAUDE.md` "Build & Run" table: replace `alembic upgrade head` row with `supabase db push`.
4. Keep `content_tool/db/models.py` (SQLAlchemy ORM) — it's the app's typed read/write layer, not a migration tool. Re-point any `Base.metadata.create_all` usage in tests to `supabase db reset`.

## 3. Phase C — Supabase-specific hardening

Apply Supabase skill rules 4–6. Each is its own migration generated via `supabase migration new ...`:

1. **RLS as defense in depth.** `ALTER TABLE content_tool.<each_table> ENABLE ROW LEVEL SECURITY;` then a single permissive policy `TO postgres` (because the app connects as the privileged DB user, not via PostgREST). Rationale: if anyone ever exposes the schema later, tables aren't wide open.
2. **Lock down public schema.** `REVOKE ALL ON SCHEMA public FROM anon, authenticated;` — we don't use these roles, but Supabase ships them. Belt and braces.
3. **Indexes & extensions advisors** — re-run `supabase db advisors`; promote any HIGH findings into a `0002_advisor_fixes.sql` migration.
4. **Connection role.** Create a dedicated `content_tool_app` role with `GRANT USAGE ON SCHEMA content_tool` + table grants, instead of using the `postgres` superuser from FastAPI. Smaller blast radius if credentials leak.

## 4. Phase D — Connection layer changes in the app

Minimal — most of the work is config, not code.

1. **Pick the right connection string.** FastAPI runs as a long-lived process, so use Supabase's **direct connection** (port 5432) rather than the transaction-mode pooler (port 6543). Transaction-mode pgbouncer breaks SQLAlchemy/asyncpg prepared statements unless you disable them (`prepared_statement_cache_size=0` + `server_settings={"jit": "off"}`), which silently kills performance. If IPv4-only on the host, use **session-mode pooler** (port 5432 via pooler) instead — still safe for prepared statements.
2. `content_tool/db/connection.py` — add `pool_size`, `max_overflow`, `pool_recycle=1800` to `create_async_engine`. Supabase idles connections aggressively; recycle avoids stale-conn errors.
3. `content_tool/config.py` — no new fields needed; `POSTGRES_URL` already drives everything. Update `.env.example` with the Supabase URL shape (no real secrets in the repo).
4. **TLS.** Append `?sslmode=require` to the URL. asyncpg honours it.

## 5. Phase E — Production data cutover runbook

Runs **after** Phases A–D are merged and proven.

| Step | Command / Action | Rollback |
|---|---|---|
| E1 | Provision Supabase project in `ap-southeast-1`. Capture project ref + DB password to 1Password (no commits). | Delete project. |
| E2 | Push baseline schema: `supabase link --project-ref <ref>` then `supabase db push`. Verify with `supabase migration list`. | `supabase db reset --linked` (destructive — only OK because we haven't loaded data yet). |
| E3 | **Announce read-only window** in Slack #content-tool. Stop the FastAPI workers (LangGraph runs in-flight will be marked failed at next startup — see commit `82d57b6`). | Restart workers on old DB. |
| E4 | Dump current prod DB, `content_tool` schema only: `pg_dump --no-owner --no-privileges --schema=content_tool --format=custom $OLD_PG_URL > content_tool.dump`. Verify size + table counts. | N/A — read-only op. |
| E5 | Restore into Supabase: `pg_restore --no-owner --no-privileges --data-only --schema=content_tool -d $SUPABASE_DIRECT_URL content_tool.dump`. Data-only because schema came from baseline. | `TRUNCATE` all `content_tool.*` tables and retry, or rebuild project. |
| E6 | Row-count parity check: script that runs `SELECT count(*)` per table on both DBs, asserts equality. **Acceptance gate.** | Re-run E5 from clean state. |
| E7 | Smoke test: point a **single** worker at Supabase (`POSTGRES_URL=…` for that one process). Trigger one `start_mode=refresh` run, watch it complete through HITL_2. | Flip the worker back to old DB; no users impacted. |
| E8 | Swap `POSTGRES_URL` in prod env, restart all workers. Watch SSE error rate, p95 query latency, and `RunExecutor.recover_orphaned` log line on startup. | Flip `POSTGRES_URL` back; old DB still hot. **Keep old DB hot for 7 days.** |
| E9 | Day +7: snapshot old DB, then decommission. | None — keep snapshot. |

**Data-rule reminder:** the `pg_dump` file in E4 contains PII/PHI (article authors, possibly member fields — confirm with table audit). Stay on the local laptop or a Bowtie-owned host. Do not upload to web tools / unofficial connectors. Delete after E6 verification.

## 6. Phase F — Documentation & follow-ups

- Update `CLAUDE.md`:
  - Build & Run table: `Migrate DB` row → `supabase db push`, `New migration` → `supabase migration new <name>`.
  - Add `Supabase` section noting direct-connection vs pooler choice and the `content_tool` schema policy.
- Update `web/AGENTS.md`: no change needed — frontend doesn't touch DB.
- Open a Notion page under IT Help Center linking the runbook (E1–E9) for on-call use.
- Backlog items (out of scope for this migration, surfaced for later):
  - Adopt Supabase Branching for PR preview DBs.
  - Replace bespoke compliance audit log with Supabase Logs / `pg_audit` if approved by compliance.
  - Evaluate `pg_cron` for the refresh scan (currently `scripts/refresh_scan` via external cron).

## 7. Risks & open items

1. **Direct connection vs pooler.** If the production host is IPv6-incapable, direct connection fails. Verify before E2; if so, use **session-mode pooler** and re-test prepared statements during Phase A (re-run pytest integration suite against the pooler URL — non-negotiable).
2. **Region & compliance sign-off.** PHI/PII crossing into a new vendor requires Bowtie compliance & legal review (DPA, region, encryption at rest). Pause before Phase E1 until confirmed. Raise on Slack to the compliance/security team.
3. **Pyright baseline drift.** None expected — no API contract changes — but re-run `pyright` after Phase D to confirm the ~547-error baseline didn't grow.
4. **`pg_dump`/`pg_restore` version skew.** Use the client binaries from the **newer** Postgres major (Supabase). Old client against new server will silently strip features.
5. **LangGraph checkpointer.** Confirm `graph/checkpointer.py` doesn't use Postgres features Supabase restricts (`LISTEN/NOTIFY` works on Supabase direct conn but **not** through pgbouncer). Verify in Phase A.

## 8. Commit shape

One PR per phase, all on feature branch `feat/supabase-migration`:

- `chore(db): init supabase local dev scaffolding` — Phase A artifacts only.
- `chore(db): baseline schema as supabase migration, retire alembic` — Phase B.
- `feat(db): RLS + advisor fixes + dedicated app role` — Phase C.
- `feat(db): tune asyncpg engine for supabase connection limits` — Phase D.
- Phases E + F are ops/docs, not code — track in the PR description checklist.
