# Cloudflare Hosting — Plan

**Date:** 2026-05-30
**Status:** SUPERSEDED — historical record only. This container-based stack was
never the long-term production path and has been removed (`deploy/cloudflare/`,
`Dockerfile.cf-backend`, `Dockerfile.cf-frontend`, `.dockerignore`,
`.github/workflows/deploy-cloudflare.yml` are all deleted). Production now runs
on the Workers-native stack — see
[`../plans/2026-05-31-workers-native-backend.md`](./2026-05-31-workers-native-backend.md)
and [`../specs/2026-05-31-workers-native-backend-design.md`](../specs/2026-05-31-workers-native-backend-design.md).
**Spec:** [`docs/superpowers/specs/2026-05-30-cloudflare-hosting-design.md`](../specs/2026-05-30-cloudflare-hosting-design.md)

Host everything except the database on Cloudflare (Workers + Containers); DB stays
on Supabase. Frontend runs as a second container; full config + CI + docs.

## Phase 1 — Artifacts (done)

- [x] `deploy/cloudflare/wrangler.jsonc` — Worker + two container bindings, DO
      migration `v1`, non-secret `vars`.
- [x] `deploy/cloudflare/worker/index.ts` — path router, `/api` strip, SSE
      passthrough, `envVars` forwarding, `enableInternet` on backend.
- [x] `deploy/cloudflare/{package.json,tsconfig.json,.gitignore,.dev.vars.example}`.
- [x] `Dockerfile.cf-backend` — Python 3.13 + editable install, runs uvicorn.
- [x] `Dockerfile.cf-frontend` — Next.js standalone build + runtime stage.
- [x] `.dockerignore` (repo root) — lean, secret-free build context.
- [x] `.github/workflows/deploy-cloudflare.yml` — build + deploy on `main`,
      optional secret sync.
- [x] `deploy/cloudflare/README.md` — operator runbook.

## Phase 2 — First live deploy (operator)

- [ ] Workers Paid plan enabled; `wrangler login`.
- [ ] `cd deploy/cloudflare && npm install` (commit the resulting lockfile).
- [ ] `npm run typecheck` passes.
- [ ] Set secrets: `POSTGRES_URL` (Supabase **session pooler**), `GEMINI_API_KEY`,
      `WP_USERNAME`, `WP_APP_PASSWORD`.
- [ ] Set `WP_TARGET` explicitly for the environment.
- [ ] `npx wrangler deploy`; verify images build and push.

## Phase 3 — Validate

- [ ] `GET /cf-health` → 200.
- [ ] Frontend loads at `/`; first-run setup gate behaves.
- [ ] Start a run → SSE progress streams (confirms `/api/*` routing + streaming
      through the Worker, and DB/Gemini reachability).
- [ ] Dry-publish `target_label` correct before approving HITL_2.

## Phase 4 — Follow-ups (optional)

- [ ] Custom domain via `routes` (+ absolute `NEXT_PUBLIC_API_BASE` if desired).
- [ ] CI secret rotation via manual dispatch (`sync_secrets = true`).
- [ ] If/when concurrency is needed: run-id routing to lift `max_instances`.

## Non-goals

- No DB move; no change to `supabase db push`.
- No change to the desktop (Tauri) release or backend application code.
