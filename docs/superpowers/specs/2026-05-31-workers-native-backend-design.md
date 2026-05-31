# Workers-native Backend (free plan) — Design

**Date:** 2026-05-31
**Status:** SHIPPED — Phase 9 cutover complete; this is the production hosting path.
Backend `bowtie-content-tool-poc` (https://bowtie-content-tool-poc.fmc.workers.dev)
and frontend `bowtie-content-tool-web` (https://bowtie-content-tool-web.fmc.workers.dev)
deploy via `.github/workflows/deploy-workers.yml`.
**Source:** `deploy/cloudflare-workers/` (backend) + `web/` (frontend, OpenNext)
**Supersedes:** the container design in
[`2026-05-30-cloudflare-hosting-design.md`](./2026-05-30-cloudflare-hosting-design.md)
(now removed from the repo).

## Goal

Re-platform the Python backend to a **Workers-native TypeScript** app that runs on
the Cloudflare **free** plan (no containers, no Workers Paid). The database stays
on Supabase. The desktop (Tauri) release is unaffected.

## What the PoC proved (2026-05-31)

Deployed free to `bowtie-content-tool-poc.fmc.workers.dev`:

- **DB from a Worker** — `pg` and `postgres.js` over raw sockets FAIL on free (the
  Postgres TLS handshake alone exceeds the **50-subrequest** per-invocation cap).
  **Hyperdrive** (free) fixes it: `postgres.js` on `env.HYPERDRIVE.connectionString`
  returned PostgreSQL 17.6 + all 20 `content_tool` tables.
- **Long pipeline + progress** — a Cloudflare **Workflow** ran durable steps,
  called **Gemini** (`gemini-3.1-pro-preview`) in a step, and a **Durable Object**
  persisted/streamed run events. End-to-end green.

Conclusion: the free Workers-native path is viable. The remaining work is a large
but de-risked port.

## Target architecture

```
 Browser ─▶ Worker (Hono router)
              ├─ REST routes ───────────────▶ postgres.js ─▶ Hyperdrive ─▶ Supabase
              ├─ POST /runs ── create ──────▶ Workflow instance (durable pipeline)
              │                                   │ step.do(outline→writer→audit→render→publish)
              │                                   │ step.waitForEvent(HITL_1 / HITL_2)
              │                                   └─ emits progress ─▶ Durable Object (per run)
              └─ GET /runs/:id/events ──────▶ Durable Object → SSE stream
   Cron Trigger ─▶ refresh scan Workflow
```

| Concern | Today (Python) | Workers-native target |
|---|---|---|
| HTTP routing | FastAPI (`api/`, 4.8k LOC) | **Hono** on a Worker |
| Orchestration | LangGraph graphs (`graph/`, 681 LOC) | **Cloudflare Workflows** (one Workflow per entry mode) |
| Pipeline nodes | `agents/` (1.5k LOC) | TS functions invoked inside `step.do(...)` |
| HITL_1 / HITL_2 interrupt + resume | LangGraph `interrupt` + `POST /runs/{id}/resume` | `step.waitForEvent(name)` + `instance.sendEvent()` ⚠️ verify in Phase 3 |
| Run durability/checkpoint | `langgraph-checkpoint-postgres` | **Workflows' built-in durability** (no separate checkpointer table) |
| Live progress (SSE) | in-process SSE (`api/sse.py`) | **Durable Object** per run (proven pattern) |
| DB access | SQLAlchemy + asyncpg (`db/`, 670 LOC) | **postgres.js via Hyperdrive** (repository modules) |
| LLM | `google-genai` (`gemini/`, 307 LOC) | `@google/genai` (proven) |
| WordPress | httpx REST (`wordpress/`, 391 LOC) | `fetch` REST client |
| Config YAML | `config/*.yaml` (`policy/`, refresh) | bundle as JSON/TS (personas/prompts already in DB) |
| Periodic refresh | `scripts/refresh_scan` + `refresh/` (802 LOC) | **Cron Trigger** → refresh Workflow |
| `pandas` (cost/CSV agg) | `observability/`, costs/compliance | hand-rolled JS aggregation |
| Logging/tracing | structlog + OTel | Workers logs + tail; optional OTel-over-fetch |

## Key design decisions

1. **Workflows replace LangGraph AND the checkpointer.** Each entry mode
   (`refresh`, `create`, `topic_expansion`, promote) becomes a Workflow whose
   `run()` calls step functions. Workflows persist step state implicitly, so the
   Postgres checkpointer is retired. The app's own tables (`runs`, `drafts`,
   `outlines`, …) remain the system of record.
2. **HITL via `waitForEvent`.** `HITL_1` (after outline) and `HITL_2` (after draft)
   become `await step.waitForEvent("hitl_1"/"hitl_2", { timeout })`. The existing
   `POST /runs/{id}/resume` becomes `instance.sendEvent(...)`. This is a cleaner
   fit than LangGraph interrupts. **Linchpin to verify first.**
3. **Per-run Durable Object** holds live SSE subscribers + a durable event log;
   the Workflow `emit()`s into it. Browser SSE (`web/lib/sse.ts`) is unchanged in
   shape (`/api/runs/:id/events`).
4. **Hyperdrive is mandatory** on free. All DB access goes through it. This
   requires amending CLAUDE.md (below).
5. **Subrequest budget lives in steps.** The 50/invocation cap is fine because
   heavy multi-query/LLM work runs inside Workflow steps, each with its own budget.
6. **Frontend** moves to a free **OpenNext Worker** (the container version is for
   the paid path). The `/api/*` contract is unchanged.

## CLAUDE.md change required

The "Supabase" section states *"SQLAlchemy/asyncpg owns all data access."* The
Workers backend uses **`postgres.js` via Hyperdrive** instead. This must be
amended (scoped to the Workers deployment) before Phase 1. No PostgREST / Data API
/ supabase-js is introduced — still a direct SQL connection, just a JS driver
through Hyperdrive.

## Risks & open questions

- **`waitForEvent` semantics / timeout** for HITL — verify first (Phase 3 gate).
- **Free-tier Workflows limits** (concurrent instances, daily invocations, step
  duration) — confirm against expected run volume; log any cap we bump.
- **Gemini structured output** — the Python path uses response schemas (see commit
  `563c524`: "skip JSON parsing when no response schema"). The TS port must mirror
  `responseSchema`/`responseMimeType` handling exactly.
- **Parity** — LLM-judge evals (`evals/`) must run against the TS backend to prove
  output parity before cutover.
- **Dual maintenance** — until cutover, Python and TS backends coexist. Keep the
  port behind its own deployment; do not delete Python until parity is signed off.
- **Effort** — ~10.6k LOC Python; expect comparable TS plus test/parity work.
  Weeks, not days.

## Out of scope

- Moving the database (stays Supabase) or the migration workflow (`supabase db push`).
- The desktop (Tauri) release and the Python backend (untouched until cutover).
