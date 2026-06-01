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

## Open items to confirm before build
1. **Admin break-glass for SoD** — include (recommended) or hard-block with no
   override?
2. **New-signup default role** — `viewer` (recommended) vs `author`?
3. **Bootstrap admins** — which emails seed the first Admin(s)?
