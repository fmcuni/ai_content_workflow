# Workers-native Backend — Plan

**Date:** 2026-05-31
**Status:** COMPLETE — Phase 9 cutover done. Production runs on the two Workers
(`bowtie-content-tool-poc` + `bowtie-content-tool-web`) deployed by
`.github/workflows/deploy-workers.yml`. The Python backend in `content_tool/` was
**not** deleted — it remains the desktop Tauri sidecar, runs the evals, and is used
for local dev.
**Spec:** [`../specs/2026-05-31-workers-native-backend-design.md`](../specs/2026-05-31-workers-native-backend-design.md)

Staged Python→TypeScript port onto Cloudflare Workers (free plan). Each phase ends
with a **parity check** against the Python backend; Python is not deleted until
cutover (Phase 9). Build in `deploy/cloudflare-workers/` (the PoC scaffold).

## Phase 0 — Foundations & sign-off
- [ ] Approve this spec.
- [ ] Amend CLAUDE.md: allow `postgres.js`-via-Hyperdrive for the Workers backend.
- [ ] **Verify `step.waitForEvent` + `instance.sendEvent`** with a throwaway HITL
      step (the linchpin for HITL_1/HITL_2). If unavailable, fall back to a
      DO-driven pause before proceeding.
- [ ] Lock project layout: `src/{routes,workflows,agents,db,gemini,wordpress,config,sse}`.

## Phase 1 — Data layer (read-only)
- [ ] Hyperdrive binding (done in PoC) + a typed query layer per table
      (`runs, articles, drafts, outlines, gap_analyses, audit_runs, citations,
      renders, personas, prompt_templates, prompt_versions, topic_batches,
      topic_candidates, compliance_log, refresh_evaluations, fetched_articles,
      hitl2_snapshots, url_resolution_cache, wp_users, wp_categories`).
- [ ] Port read-only routes: `personas`, `prompts`, `articles` (list/get),
      `costs`, `wp_options`, `setup/status`.
- [ ] **Parity:** responses match Python for the same DB.

## Phase 2 — LLM + config
- [ ] `@google/genai` client wrapper with **response-schema parity** (commit `563c524`).
- [ ] Prompt loading from `prompt_templates` (runtime source of truth).
- [ ] Port `config/*.yaml` (pricing, source_policy, refresh) to bundled JSON/TS.
- [ ] Cost calculation (replace pandas with JS aggregation).

## Phase 3 — Production pipeline as a Workflow (the core)
- [ ] `ProductionWorkflow`: `outline → writer → audit(+audit_checks) → render_html
      → resolve_citations → publish`, each as a `step.do`.
- [ ] `HITL_2` via `step.waitForEvent("hitl_2")`; reviewer-comments revise loop.
- [ ] Per-run **Durable Object** for SSE (finalize stream flush + heartbeat).
- [ ] `POST /runs` (create mode, Front III → WP draft), `POST /runs/{id}/resume`
      (→ `sendEvent`), `GET /runs/{id}/events`.
- [ ] Dry-publish endpoint returns `target_label` (verify before HITL_2 approve).
- [ ] **Parity:** a `create` run produces an equivalent WP draft + compliance log.

## Phase 4 — Strategy subgraph (refresh mode)
- [ ] `fetch_article`, `gap_analysis`, `url_resolver` as steps.
- [ ] `HITL_1` via `waitForEvent("hitl_1")`.
- [ ] `start_mode="refresh"` path (fetch + gap analysis → production).
- [ ] **Parity:** a refresh run matches Python end-to-end.

## Phase 5 — Topic expansion (Front II) + promote
- [ ] `TopicExpansionWorkflow`: `topic_gen → topic_dedup → topic_hot → HITL_T1`.
- [ ] `POST /topic-batches`, `/topic-batches/{id}/promote` (create + refresh modes,
      fan-out to run Workflows).
- [ ] **Parity:** batch generation + promotion fan-out.

## Phase 6 — Refresh cron + compliance + audit log
- [ ] Cloudflare **Cron Trigger** → refresh scan Workflow (replaces
      `scripts/refresh_scan`, `refresh/`).
- [ ] `compliance/export.csv` (JS CSV, no pandas).
- [ ] Compliance audit-log writer on publish.

## Phase 7 — Frontend (free)
- [x] Frontend → **OpenNext Worker** (free); keep `/api/*` contract.
- [x] Two Workers; confirm SSE + REST against the TS backend.

**Implemented 2026-05-31.** Added the `@opennextjs/cloudflare` adapter to `web/`
without disturbing the existing Tauri/standalone build:

- `web/open-next.config.ts` — `defineCloudflareConfig()` with defaults (the UI is
  a client-rendered SPA; no ISR/`'use cache'` surface, so no R2/KV/DO-queue cache
  bindings are needed).
- `web/wrangler.jsonc` — frontend Worker `bowtie-content-tool-web`,
  `main: .open-next/worker.js`, flags `nodejs_compat` + `global_fetch_strictly_public`,
  `ASSETS` binding.
- `web/next.config.mjs` — `output: "standalone"` is now **conditional**: kept as
  the default (Tauri sidecar) and disabled only when `WEB_BUILD_TARGET=cloudflare`,
  which the `cf:*` scripts set. Added a dev-only `initOpenNextCloudflareForDev()`.
  The `/api/*` `rewrites()` and `NEXT_PUBLIC_API_BASE` contract are unchanged.
- `web/package.json` — `cf:build` / `cf:preview` / `cf:deploy` / `cf:typegen`.

**Two-Worker request model (decision):**
- **REST** stays on relative `/api/*` paths → Next `rewrites()` proxy → backend
  Worker (`global_fetch_strictly_public` lets that fetch egress). Server-side, so
  no CORS.
- **SSE** stays browser-direct to `${NEXT_PUBLIC_API_BASE}/runs/:id/events` and
  `/topic-batches/:id/events` (Next rewrites buffer streams). The backend now
  returns CORS headers for these — see `deploy/cloudflare-workers/src/http/cors.ts`,
  pinned by the new `FRONTEND_ORIGIN` env on the backend Worker.

**Build-verified** (no deploy — Phase 9 is the cutover STOP gate):
- `NEXT_PUBLIC_API_BASE=… npm run cf:build` → `web/.open-next/worker.js`.
- plain `npm run build` → `web/.next/standalone/server.js` (Tauri path intact).

**Deploy (when cutting over):**
```
cd web
NEXT_PUBLIC_API_BASE=https://<backend-worker-url> npm run cf:deploy
# backend Worker: wrangler secret/var FRONTEND_ORIGIN=https://<frontend-worker-url>
```

## Phase 8 — Evals & parity gate
- [ ] Run `evals/` LLM-judge suite against the TS backend.
- [ ] Side-by-side parity on a fixture set (outline/draft/audit/publish).
- [ ] Load/limits check: Workflows concurrency, subrequest budgets, cron.

## Phase 9 — Cutover
- [ ] Point production traffic at the Workers backend.
- [ ] Decommission the Python backend + container deploy (or keep as fallback).
- [ ] Decide hosting account (personal `fmc` vs a Bowtie Cloudflare account).
- [ ] Update CLAUDE.md, codemaps, READMEs.

## Cross-cutting
- **Account:** PoC is on personal `fmc.workers.dev`. Productionizing should move to
  a Bowtie-owned Cloudflare account (still public marketing content only — no PII).
- **Secrets:** `GEMINI_API_KEY`, WP creds via `wrangler secret`; DB via Hyperdrive
  config. Never committed.
- **Testing:** Vitest + `@cloudflare/vitest-pool-workers` for unit/integration;
  parity tests vs Python per phase.

## Non-goals
- DB move; `supabase db push` workflow change; desktop release changes;
  deleting Python before the Phase 9 parity sign-off.
