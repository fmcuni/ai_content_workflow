# Cloudflare Hosting (Workers + Containers) — Design

**Date:** 2026-05-30
**Status:** SUPERSEDED — historical record only. This container-based design has
been replaced by the Workers-native stack, which is the production hosting path.
See [`./2026-05-31-workers-native-backend-design.md`](./2026-05-31-workers-native-backend-design.md).
All artifacts described below have been removed from the repo: `deploy/cloudflare/`,
`Dockerfile.cf-backend`, `Dockerfile.cf-frontend`, `.dockerignore`, and
`.github/workflows/deploy-cloudflare.yml`.

## Goal

A second release target that hosts **all components except the database** on
Cloudflare. The database stays on Supabase. This complements the existing desktop
(Tauri) release without changing it.

## Constraint analysis

The backend is Python 3.13 + FastAPI + LangGraph + asyncpg + pandas with
long-lived **SSE** streaming and a Postgres LangGraph checkpointer. This **cannot**
run on Cloudflare Workers or Python Workers (Pyodide): no native asyncpg/pandas,
no long-lived process. The only viable Cloudflare runtime for it is **Cloudflare
Containers** (a Worker fronting an OCI image; GA, Workers Paid plan, instances up
to 4 vCPU / 12 GiB that sleep when idle).

The frontend is Next.js 16 with `output: "standalone"`. We run that exact
standalone artifact as a **second container** (decision below) rather than porting
to the OpenNext adapter — zero adapter risk, identical to desktop/local runtime.

## Architecture

One Worker (`deploy/cloudflare/worker/index.ts`) fronts two container classes:

| Path | Target | Notes |
|---|---|---|
| `/api/*` | `Backend` container (`:8000`) | `/api` prefix stripped — FastAPI isn't mounted under `/api`. Streams SSE through. |
| `/*` | `Frontend` container (`:3000`) | Next.js standalone Node server. |
| `/cf-health` | Worker | Edge liveness; never wakes a container. |

- **Single origin.** The browser only talks to the Worker. REST calls
  (`web/lib/api.ts`, relative `/api/...`) and the SSE stream (`web/lib/sse.ts`,
  `${NEXT_PUBLIC_API_BASE}/runs/{id}/events`) resolve to the same origin. With
  `NEXT_PUBLIC_API_BASE=/api` (the frontend image default) there is no
  cross-origin traffic and no CORS surface; the backend's existing
  `localhost:3000`-only CORS config is never exercised, so it needs no change.
- **Next.js rewrites are dormant in this deployment.** The Worker intercepts
  `/api/*` before the frontend container, so the server-side rewrites in
  `next.config.mjs` never fire (they remain for desktop/local).
- **Secrets → backend env.** `worker/index.ts` forwards Worker
  vars/secrets into the backend container via `Container.envVars`, dropping
  empty/undefined keys so app defaults apply. `enableInternet = true` lets the
  backend reach Supabase, Gemini, and WordPress.
- **DB stays on Supabase.** `POSTGRES_URL` must be the **session-mode pooler**
  (Cloudflare egress is IPv4; the direct endpoint is IPv6-only). Never the
  transaction-mode pooler (6543).

## Key decisions

1. **Frontend as a second container** (vs. Workers + OpenNext). Reuses the
   existing `output: "standalone"` build; no Next 16 / adapter compatibility risk;
   identical runtime to desktop. Trade-off: a running container costs more than an
   edge Worker and cold-starts after idle.
2. **Single instance per class** (`max_instances: 1`). The backend drives a
   LangGraph and streams that run's progress from the *same* process, so a run's
   `POST` and its SSE `GET` must hit the same instance. One instance mirrors the
   desktop/local single-process model. Scale-out path: route on run id
   (`getContainer(env.BACKEND, runId)`).
3. **Dockerfiles at repo root.** Both images need repo-root build context
   (`content_tool/`, `config/`, `prompts/`, `web/`). `wrangler.jsonc` references
   them via `../../`. Editable `pip install -e .` keeps `resource_root()`
   resolving `config/` + `prompts/` correctly.

## Out of scope / unchanged

- Database hosting and the Supabase migration workflow (`supabase db push`).
- The desktop (Tauri) release.
- Backend application code — no changes required.

## Risks

- **Cold starts** after idle (`sleepAfter = 30m`) add latency to the first
  request; the backend re-runs `recover_orphaned()` on boot.
- **wrangler build context.** If a wrangler version doesn't treat the Dockerfile's
  directory as context, use the explicit `docker build` + `wrangler containers
  push` fallback (see README).
- **First image build is large/slow** (Python deps); subsequent deploys push only
  changed layers.

## Verification (operator)

1. `cd deploy/cloudflare && npm install && npm run typecheck`.
2. Set secrets, set `WP_TARGET` explicitly, `npx wrangler deploy`.
3. `GET /cf-health` → 200; load `/` (frontend); start a run and confirm the SSE
   stream renders progress (validates `/api/*` routing + streaming).
4. Confirm `target_label` from the dry-publish endpoint before approving HITL_2.
