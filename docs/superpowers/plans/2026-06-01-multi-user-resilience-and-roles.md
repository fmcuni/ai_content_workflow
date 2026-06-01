# Multi-User Resilience & Roles — Implementation Plan

**Design:** [`specs/2026-06-01-multi-user-resilience-and-roles-design.md`](../specs/2026-06-01-multi-user-resilience-and-roles-design.md)
**Sequencing:** Phase 1 (resilience) ships first, Phase 2 (roles) second. Each
phase is one or more PRs. Migrations are pushed before the code that reads them.

---

## Phase 1 — Resilience (ship first)

### PR 1A — Optimistic concurrency on edits
- **Migration** `supabase migration new add_version_columns`: add
  `version int NOT NULL DEFAULT 0` to `renders` and outline rows.
- **Python** `content_tool/api/routes/runs.py`: `edit_article`, `edit_outline`,
  `apply_edits` accept `expected_version`; do
  `UPDATE ... SET ..., version = version + 1 WHERE id = ? AND version = ?`;
  `rowcount 0` → `HTTPException(409, {current state})`.
- **Workers** `deploy/cloudflare-workers/src/routes/runs.ts` (equivalent handlers):
  same conditional update via `postgres.js`.
- **Schemas** `content_tool/api/schemas.py`: add `expected_version` (and return
  `version` in render/outline reads).
- **Frontend** `web/lib/run-editor/` + `web/components/run-editor/`: thread
  `version` through autosave; on 409 show "edited elsewhere — reload" flow.
- **Tests** `tests/integration/`: two concurrent edits → exactly one 409.

### PR 1B — Atomic HITL transitions + status guards + FOR UPDATE
- **Python** `runs.py`: convert HITL_1/HITL_2 decision to conditional `UPDATE`
  with cap guard + `RETURNING`; guard `resume`/`restart`/`hitl_2` status writes
  with `WHERE status = <expected>`; wrap snapshot prune in `FOR UPDATE`.
- **Workers**: mirror in `routes/runs.ts`.
- **Tests**: concurrent "request changes" → one increment, one 409; status
  transition from wrong state → 409.

### PR 1C — Single-flight execution
- **Python** `content_tool/api/sse.py`: in `start`/`resume`, reject if a live task
  exists for `run_id` → 409; add per-run `asyncio.Lock`.
- **Both**: conditional DB claim
  `UPDATE runs SET status='running' WHERE run_id=? AND status IN (...)`; proceed
  only on successful claim.
- **Tests**: two concurrent `start` calls → one runs, one 409.

### PR 1D — Session-derived identity (Workers)
- **Workers** `routes/runs.ts` + `deploy/cloudflare-workers/src/auth/middleware.ts`:
  set `created_by` / `approved_by` from session (`userId` + `userEmail`); ignore
  payload `editor_email` in prod.
- **Migration**: add `created_by_user_id text`, `approved_by_user_id text` to `runs`.
- **Compliance** `content_tool/compliance/log.py`: record the user id snapshot.
- **Python**: keep payload path for dev, comment as dev-only.
- **Verify** parity gate still green.

---

## Phase 2 — Roles & authorization

### PR 2A — Role schema + bootstrap
- **Migration** `add_user_role`: `role text NOT NULL DEFAULT 'viewer'
  CHECK (role IN ('viewer','author','reviewer','admin'))` on `user`; seed
  bootstrap admins (env `BOOTSTRAP_ADMIN_EMAILS` or explicit emails).
- Push migration before deploying 2B.

### PR 2B — Authorization middleware (Workers, authoritative)
- **Workers** new `src/auth/authz.ts`: capability constants, `roleHasCapability`,
  `requireCapability(cap)` Hono middleware (loads role from DB per request).
- Annotate every route with its capability per the design matrix.
- SoD check in `hitl_2`/`republish`: `created_by_user_id == userId` → 403, unless
  Admin break-glass with `override_reason` (logged `sod_override=true`).
- `GET /me` → `{ email, role }`.
- **Tests**: role × route allow/deny matrix; SoD self-approval → 403; break-glass
  path logged.

### PR 2C — User management
- **Workers** `GET /admin/users`, `PUT /admin/users/{id}/role` (Admin only);
  audit each change.

### PR 2D — Frontend gating + Users page
- **Frontend** `web/`: consume `/me` role; hide/disable create, approve, publish,
  config-edit, delete controls by role; Viewer read-only. New **Users** admin page.
- **Tests** `web/` Vitest/RTL: control visibility per role.

---

## Cross-cutting
- **Migrations before code** every time (`supabase db push`).
- **Parity gate**: run `node deploy/cloudflare-workers/parity/check-parity.mjs`
  after identity/authz changes.
- **Compliance**: actor role + `sod_override` in `GET /compliance/export.csv`.
- **Conventional commits**, scoped: `feat(authz):`, `fix(concurrency):`, etc.

## ⚠️ Model change — 2026-06-02 (supersedes the role/SoD sections below)
Requirements changed: **publishing no longer requires 4-eyes**, and an
**editor (or above) can review and publish** (including their own articles).
The role model collapsed from four roles to **three: `viewer < editor < admin`**
(author+reviewer merged into `editor`), and **segregation of duties was removed
entirely** (no self-approval block, no break-glass). Migration
`20260602000001_role_taxonomy_editor.sql` remaps the enum (applied to prod).
Capability map now: read=viewer; create/edit/regenerate/promote/HITL_1+HITL_2
approve/dry-publish/republish=**editor**; prompts/personas/source-policy/delete/
manage-users=**admin**. The four-role + SoD text in §3 below is historical.
Commit: `refactor(authz): collapse to viewer/editor/admin, remove SoD`.

## Status — SHIPPED 2026-06-01 (branch `feat/multi-user-resilience`)
All phases implemented and committed; full suites green (Python testcontainers,
Workers vitest 239, web vitest 59; tsc clean). A security review of the authz
layer was run and its HIGH/MEDIUM findings fixed (SoD extended to HITL_1,
dry-publish gated, session-required guard, admin self-demotion block).

Commits: docs → `feat(concurrency)` 1A → `feat(concurrency)` 1B/1C/1D →
`feat(authz)` Phase 2 → `fix(authz)` security review.

## Decisions resolved (defaults applied — confirm or adjust)
1. **Admin break-glass for SoD** — INCLUDED. Admin may override the 4-eyes block
   with a non-empty `override_reason`; recorded as a `rbac.sod_override` audit
   event + `sod_override:true` in the response.
2. **New-signup default role** — `viewer` (least privilege; an Admin promotes).
3. **Bootstrap admins** — NOT hard-coded. `BOOTSTRAP_ADMIN_EMAILS` (comma-sep
   env/secret on the Worker) are treated as admin regardless of stored role, so
   a fresh DB is never locked out. First admin: **`franco.ma@bowtie.com.hk`**.
   **Set this secret before/at first deploy.**

## Deployment runbook (prod = Workers)
1. `supabase db push` — apply `20260601000005` (version cols) +
   `20260601000006` (user.role) BEFORE deploying the new Worker code.
2. `wrangler secret put BOOTSTRAP_ADMIN_EMAILS` on `bowtie-content-tool-poc`
   → `franco.ma@bowtie.com.hk` (the first admin).
3. Deploy both Workers (CI on push to `main`) + the web Worker (carries the
   `/api/me` + `/api/admin/*` rewrites).
4. Promote real reviewers/admins via the new **Users** admin page. Hard 4-eyes
   needs ≥2 active reviewers (or 1 reviewer + 1 admin) to keep articles moving.

## Deferred / not done
- Security review LOW/MEDIUM M3 (snapshot identity helper consistency) and M4
  (`/db/ping` schema exposure) — low value, left as-is.
- H3 (viewer can read unpublished editorial content) — accepted by design;
  app scope is public marketing content, no PII/PHI (CLAUDE.md).
- Per-user/per-team run ownership scoping — out of scope (single editorial team).
- Python backend authz — intentionally dev-only; enforcement is Workers + DB.
