# Multi-User Resilience & User Roles — Design

**Date:** 2026-06-01
**Status:** Proposed
**Scope:** Make the app safe for concurrent multi-user use and introduce
role-based authorization. Public marketing/editorial content only — no PII/PHI.

---

## 1. Problem

The app now has real authentication (better-auth email/password + `@bowtie.com.hk`
gate) on the production Workers backend and frontend, but:

1. **No authorization.** The `user` table has no role. Any authenticated Bowtie
   staffer can do everything: create runs, approve both HITL gates, publish to
   WordPress, edit prompts / personas / source-policy, and delete runs/batches.
2. **Almost no concurrency control.** Only prompt and source-policy edits are
   guarded (`SELECT ... FOR UPDATE` + SHA256 optimistic check). The run / HITL /
   article-edit paths have none, so concurrent users silently lose each other's
   work and can corrupt run state.

This document specifies two workstreams, sequenced **concurrency first, roles
second**:

- **Phase 1 — Resilience:** optimistic concurrency + atomic transitions +
  single-flight execution + session-derived identity.
- **Phase 2 — Roles:** a 4-role model with hard segregation-of-duties (4-eyes),
  enforced authoritatively in the Workers backend + Postgres.

---

## 2. Confirmed concurrency risks (today)

| Risk | Location | Effect |
|---|---|---|
| **Lost update on article edit** | `content_tool/api/routes/runs.py` `edit_article` — `SELECT` render then `UPDATE`, no lock, no version | Two reviewers editing the same render overwrite each other's `html_body`/`seo_title`/`meta_description` silently |
| **HITL-2 iteration TOCTOU** | `runs.py` `hitl_2` — read `hitl_2_iteration`, check `>= 3`, then `UPDATE` | Two concurrent "request changes" both pass the cap, decision audit trail corrupted |
| **Dual executor tasks (Python)** | `content_tool/api/sse.py` `start`/`resume` overwrite `self._tasks[run_id]` | Two start/resume calls run the graph twice → conflicting checkpoints/drafts. Workers (Durable Objects) already serialize this |
| **Run-status stomp** | `resume` / `restart` / `hitl-2` each `UPDATE runs SET status=...` unconditionally | Final status is whichever commit lands last; UI/state-machine desync |
| **Trusted approver identity** | `approved_by` taken from request payload `editor_email` | Audit trail not provably the authenticated user |

Workers (`deploy/cloudflare-workers/`) serialize **SSE stream** state per run via
the `RunStream` Durable Object, but **Postgres mutations still race** — DO does
not protect the DB rows.

---

## 3. Decisions (locked)

| Decision | Choice |
|---|---|
| Role model | **4 roles**: Viewer, Author, Reviewer, Admin (cumulative) |
| Segregation of duties | **Hard enforce** — a run's author cannot approve/publish it |
| Sequencing | **Concurrency first**, then roles |
| Enforcement boundary | **Workers backend + Postgres role column** is authoritative; Python backend stays dev-only |
| SoD lockout mitigation | **Admin break-glass** override, mandatory reason, flagged in compliance export *(recommended default — confirm)* |

### 3.1 Role → capability matrix

Roles are cumulative (each includes the one above).

| Capability | Viewer | Author | Reviewer | Admin |
|---|:--:|:--:|:--:|:--:|
| Read everything (runs, drafts, costs, compliance) | ✓ | ✓ | ✓ | ✓ |
| Create run / topic batch | | ✓ | ✓ | ✓ |
| Edit outline / article, regenerate, apply-edits | | ✓ | ✓ | ✓ |
| Promote topics → runs | | ✓ | ✓ | ✓ |
| Approve HITL_1 (sources) | | | ✓ | ✓ |
| Approve HITL_2 + publish/republish to WordPress | | | ✓ | ✓ |
| Edit prompts / personas / source-policy | | | | ✓ |
| Delete runs / topic batches | | | | ✓ |
| Manage user roles | | | | ✓ |

### 3.2 Segregation of duties (4-eyes)

- On `hitl_2` approve and `republish`: if `run.created_by_user_id == session.userId`
  → **403** `author cannot approve own run`.
- Implication: operating requires **≥2 active Reviewers** (or 1 Reviewer + 1 Admin).
- **Break-glass:** an **Admin** may override SoD with a mandatory `override_reason`.
  The compliance log records `sod_override = true` + reason + actor. This keeps the
  default compliant while avoiding a single-reviewer deadlock.

---

## 4. Phase 1 — Resilience design

### 4.1 Optimistic concurrency (version columns)
- Add integer `version` (default 0) to editable artifacts: `renders`, `outline`
  rows. Edits send `expected_version`; server runs
  `UPDATE ... SET ..., version = version + 1 WHERE id = ? AND version = ?`.
  `rowcount == 0` → **409 Conflict** with the current server state in the body.
- Mirrors the existing prompt/source-policy SHA256 pattern, but an int version is
  cleaner for large HTML bodies. Frontend autosave carries the version and renders
  a "someone else edited this — reload" path on 409.

### 4.2 Atomic read-modify-write
- Wrap HITL decision, article edit, outline edit, and snapshot prune in a single
  transaction with `SELECT ... FOR UPDATE` on the target row (belt-and-braces with
  4.1: `FOR UPDATE` serializes same-process contention; `version` catches stale
  cross-request reads).

### 4.3 Atomic state transitions
- HITL caps as conditional updates:
  `UPDATE runs SET hitl_2_iteration = hitl_2_iteration + 1, hitl_2_decision = ?
   WHERE run_id = ? AND hitl_2_iteration < 3 RETURNING *`. `rowcount 0` → 409.
- Status transitions guarded by expected current status:
  `... WHERE run_id = ? AND status = 'awaiting_hitl_2'`.

### 4.4 Single-flight execution
- **Python:** before `create_task`, reject if `run_id` has a live task
  (`self._tasks[run_id]` not done) → 409 `run already executing`.
- **Both backends:** claim the run with a conditional DB update
  (`UPDATE runs SET status = 'running' WHERE run_id = ? AND status IN (...)`);
  proceed only if the claim succeeded. Protects across processes/instances.
  Workers already serialize via Durable Object, but the DB claim hardens the
  Postgres side.

### 4.5 Session-derived identity
- **Workers:** stop trusting payload `editor_email`. Derive `created_by` /
  `approved_by` from `c.get("userId")` + `c.get("userEmail")`. Store
  `created_by_user_id` and `approved_by_user_id` (text, the better-auth `user.id`)
  alongside the email snapshot for an immutable audit trail. Payload `editor_email`
  is ignored in prod (schema comment already anticipates this).
- **Python (dev):** keep payload identity, honor `AUTH_DISABLED`; clearly dev-only.

---

## 5. Phase 2 — Roles design

### 5.1 Schema
- Migration adds `role text NOT NULL DEFAULT 'viewer'` to `user`, with a
  `CHECK (role IN ('viewer','author','reviewer','admin'))`.
- New signups default to **viewer** (least privilege); an Admin promotes them.
- Bootstrap: `BOOTSTRAP_ADMIN_EMAILS` env seeds initial admins on first read
  (or a one-shot migration sets known staff). Migration must precede code deploy.

### 5.2 Authorization (Workers, authoritative)
- A `requireCapability(cap)` Hono middleware: session `userId` → load role from DB
  (cached per request) → check `roleHasCapability(role, cap)` → else 403.
- Each route is annotated with its required capability per §3.1. SoD check lives in
  the HITL-2/republish handlers after the capability gate.
- Add `GET /me` returning `{ email, role }` for the frontend.

### 5.3 User management
- `GET /admin/users` and `PUT /admin/users/{id}/role` (Admin only). Every role
  change is written to the audit/compliance log.

### 5.4 Frontend gating (UX, not security)
- `useSession`/`/me` exposes role. Hide/disable create, approve, publish, edit-config,
  and delete controls by role; Viewers see read-only. Server remains authoritative.
- New admin **Users** page for role management.

### 5.5 Compliance
- Compliance export records the actor's role at decision time and `sod_override`
  (+ reason) when break-glass is used.

---

## 6. Non-goals
- Per-team / per-article ownership scoping ("my runs only"). All roles still see all
  runs; this is a single editorial team. Revisit if multi-team is needed.
- Replacing better-auth or adding SSO/OIDC.
- Full authz parity in the Python backend (it is dev/sidecar only).

---

## 7. Risks & notes
- **Parity gate** (`deploy/cloudflare-workers/parity/check-parity.mjs`) diffs TS vs
  Python over read-only routes. Identity-from-session changes touch write paths
  mostly; verify the gate still passes and update fixtures if needed.
- **Migration ordering:** role + version-column migrations must be pushed
  (`supabase db push`) before deploying code that reads them.
- **SoD lockout:** without the Admin break-glass, a single available reviewer
  blocks all publishing. Confirm the break-glass before Phase 2 build.
