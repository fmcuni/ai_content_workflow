# Codebase Guide — Bowtie AI Content Tool

> **Audience:** internal developers joining this repo.
> **Goal:** explain what every folder is, how a request flows end‑to‑end, and
> where to start reading. For the terse machine-readable summary see
> [`CLAUDE.md`](../CLAUDE.md); for setup commands see [`README.md`](../README.md);
> for contribution rules see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## 1. What this app does

The Bowtie AI Content Tool is a **LangGraph-based pipeline that drafts and
updates marketing/editorial articles** and publishes them to WordPress, with two
mandatory **Human-In-The-Loop (HITL)** approval gates. An editor kicks off a run,
the pipeline researches + writes + audits a draft, the editor reviews it twice
(outline, then full draft), and on approval the article is published to WordPress
and a compliance audit record is written.

> **Data scope:** this app handles **public marketing/editorial content only** —
> no customer PII, PHI, HKID, or other Bowtie private data. Standard hygiene still
> applies: no secrets/credentials in commits, logs, or external tool calls.

### Two backends, one behaviour

There are **two implementations of the same pipeline**, and this is the single
most important thing to understand before reading code:

| | Path | Language | Role |
|---|---|---|---|
| **Python backend** | `content_tool/` | Python 3.13 / FastAPI / LangGraph | Local dev and the `evals/` suite. The *reference implementation* of the logic. **Not** the production host. |
| **Workers backend** | `deploy/cloudflare-workers/` | TypeScript / Hono | **Production hosting.** A faithful port of the Python pipeline onto Cloudflare Workers + Workflows + Durable Objects. |
| **Frontend** | `web/` | Next.js 16 / React 19 | The UI, talking to whichever backend is running. |

When you change pipeline logic you usually change it **in both backends** and run
the parity checker (see §4). Prompts, pricing, personas, and source policy are
**shared config/data**, not duplicated logic.

---

## 2. Top-level layout

```
ai_content_tool_2/
├── content_tool/      Python backend (reference implementation)
├── deploy/
│   └── cloudflare-workers/   Production TypeScript backend (Workers)
├── web/               Next.js 16 frontend (see web/AGENTS.md)
├── config/            Shared YAML config (pricing, refresh, personas, source policy)
├── prompts/           LLM prompt templates (.md) — runtime source is the DB
├── supabase/          Database migrations (canonical) + seed.sql
├── scripts/           CLI / cron entrypoints (e.g. refresh_scan)
├── evals/             LLM-judge evaluation harness + fixtures
├── tests/             Python tests (unit / integration / fixtures)
├── docs/              Design specs, plans, and this guide
├── .github/workflows/ CI/CD (ci.yml, deploy-workers.yml, nightly-evals.yml)
├── CLAUDE.md          Canonical project brief (terse)
├── README.md          Setup + run commands
└── pyproject.toml     Python package + tooling config
```

---

## 3. The Python backend (`content_tool/`)

The reference implementation. Async everywhere (DB, HTTP, Gemini). Entry point is
the FastAPI app in `content_tool/api/main.py`.

### 3.1 Package map

| Package | Purpose | Start-here files |
|---|---|---|
| `api/` | FastAPI app + HTTP routes. The `RunExecutor` in `api/sse.py` drives the compiled LangGraph and streams progress over SSE. | `api/main.py`, `api/sse.py`, `api/routes/runs.py` |
| `agents/` | The LangGraph **node functions** — one async function per pipeline step (`fetch_article`, `gap_analysis`, `outline`, `writer`, `resolve_citations`, `render_html`, `audit`, `publish`, plus the topic-expansion nodes `topic_gen`, `topic_dedup`, `topic_hot`). | `agents/writer.py`, `agents/audit.py` |
| `graph/` | **Graph composition.** `root.py` wires the `strategy` and `production` subgraphs and declares the two HITL interrupts. `checkpointer` persists graph state to Postgres so interrupts can be resumed. | `graph/root.py`, `graph/strategy.py`, `graph/production.py` |
| `models/` | Pydantic models + the LangGraph **state type** (`ContentToolState`) and node I/O models (`OutlineOutput`, `AuditOutput`, `PersonaPack`, …). | `models/state.py` |
| `db/` | SQLAlchemy ORM models + the async engine/session factory. Owns all data access (no PostgREST / supabase-js). | `db/` models, session factory |
| `gemini/` | Google Gemini client wrapper — retries, JSON-schema-constrained generation, tool use, thinking tokens, truncation/blocked-output detection. | `gemini/` client |
| `wordpress/` | WordPress REST client — publish, publish-status handling, SEO-plugin detection, retry + slug read-back resilience. | `wordpress/client.py`, `wordpress/publish.py` |
| `policy/` | Editorial **personas** loader + **source policy** (domain allow/deny for citations). | `policy/` |
| `compliance/` | Writes the compliance audit log after a successful publish (fire-and-forget — a failure here never breaks publish). | `compliance/` |
| `observability/` | Structured logging (structlog), OpenTelemetry tracing, **cost calculation**, and the persisted per-step **run event log**. | `observability/` |
| `refresh/` | CMS Stage 0 — periodically re-audits already-onboarded articles and surfaces them in the UI `/library`. | `refresh/` |
| `utils/` | Shared utilities. | — |
| `prompts_store.py` | Loads prompt templates from the DB at runtime (hot-reloadable). The `.md` files in `prompts/` are the seed/source. | — |
| `source_policy_store.py` | DB-backed, editable source policy (edited via the `/prompts` UI "Source Policy" tab). | — |
| `config.py` | Settings / env loading. | — |
| `cli.py` | `content-tool` CLI entrypoint (e.g. `gap-analysis`). | — |

### 3.2 Request lifecycle (refresh run: `POST /runs` → WordPress)

```
POST /runs  ──►  RunExecutor (api/sse.py) compiles + drives the graph (graph/root.py)
   │
   ▼
[strategy subgraph]   fetch_article ──► gap_analysis ──► outline
   │
   ▼  HITL_1  ◄── interrupt after outline; editor reviews; POST /runs/{id}/resume
   │
   ▼
[production subgraph] writer ──► resolve_citations ──► render_html ──► audit
   │                                                         │
   │                          (internal audit→refine loop, max 2 iterations)
   ▼  HITL_2  ◄── interrupt after draft; editor approves / requests changes
   │             (external revise loop, up to 3 rounds with reviewer feedback)
   ▼
publish_to_wordpress ──► compliance audit log (fire-and-forget) ──► END
```

- **The two interrupts are real LangGraph interrupts**, checkpointed to Postgres,
  so a run can pause indefinitely and resume via `POST /runs/{id}/resume`.
- The UI streams every step over **SSE**; each event is also mirrored into the
  `run_event_logs` table (the verbose debug log shown under the live process).

### 3.3 `start_mode` variants (entry paths)

The same graph is entered differently depending on `start_mode`:

| `start_mode` | Front | Path |
|---|---|---|
| `refresh` | refresh runs | Full path above (fetch + gap analysis + outline + draft). |
| `create` | **Front III** ("Create New Articles") | Skips `fetch_article`/`gap_analysis`, enters at `outline`; publishes with the operator-selected `wp_publish_status` (defaults to **draft**). |
| (topic expansion) | **Front II** ("Expand Topics") | Runs the `topic_expansion` subgraph: theme → topic-gen → dedup + hot-topic → `HITL_T1` review → fan-out to runs. Promoted topics (`POST /topic-batches/{id}/promote`) fan out as either `create` or `refresh` runs. |

> **Grounded URL retrieval (Front II):** topic candidates' `existing_url` is found
> via a two-stage *grounded* retrieval (search → resolve citations → judge picks
> from the real list), because the model used to hallucinate URLs under a strict
> JSON schema.

---

## 4. The production backend (`deploy/cloudflare-workers/`)

A TypeScript port of the Python pipeline that runs on the Cloudflare **free plan**:
**Hono** for HTTP, **Cloudflare Workflows** for durable multi-step orchestration,
and **Durable Objects** for SSE streaming and Gemini proxying. The DB stays on
Supabase, reached via **`postgres.js` over Hyperdrive** (`{ max: 5, fetch_types:
false }`) — still a direct SQL connection, no PostgREST/supabase-js.

### 4.1 `src/` map

| Path | Purpose |
|---|---|
| `src/index.ts` | Hono app entry. Mounts routers; exports the Workflow classes, the Durable Objects, and the `Env` interface; declares the `scheduled()` cron handler. |
| `src/routes/` | REST endpoints, mirroring the Python routes: `runs.ts`, `articles.ts`, `topic_batches.ts`, `personas.ts`, `prompts.ts`, `costs.ts`, `compliance.ts`, `refresh.ts`, `admin.ts`, `source_policy.ts`, identity/setup, etc. |
| `src/workflows/` | The three Cloudflare **Workflows**: `ProductionWorkflow` (a run), `TopicExpansionWorkflow` (Front II), `RefreshScanWorkflow` (daily cron). Each step is durable + auto-retried. |
| `src/run-stream.ts` | `RunStream` **Durable Object** — one per run; persists ordered events and streams them to the browser over SSE. |
| `src/gemini/` | Gemini client. `GeminiProxy` is a **US-pinned Durable Object** that egresses Gemini calls from a US region because Google AI Studio geo-blocks the Asia/HK colo. Thoughts/thinking are streamed back through this DO by `runId`. |
| `src/db/` | Typed query layer over `postgres.js` (mirrors the SQLAlchemy models). Includes a **canonical JSON serializer** that must stay byte-identical to the Python one (prompt-SHA parity). |
| `src/auth/` | better-auth (email/password) + the `@bowtie.com.hk` email-domain gate + role authorization (`viewer < editor < admin`). SSE auth uses one-time tickets. |
| `src/http/` | CORS (`cors.ts`) — needed because the browser opens SSE **directly** against the backend Worker cross-origin. |
| `src/config/`, `src/source_policy/` | TS loaders for the shared YAML config (pricing, refresh, prompt graph, source policy). |
| `src/wordpress/`, `src/compliance/`, `src/agents/`, `src/sse/`, `src/util/` | TS counterparts of the matching Python packages. |
| `wrangler.jsonc` | Workers config: Workflow/DO/Hyperdrive bindings, cron trigger, and **non-secret** `vars`. Real secrets are set via `wrangler secret put` (`POSTGRES_URL`, `GEMINI_API_KEY`, `AUTH_SECRET`, `RESEND_API_KEY`). |
| `parity/check-parity.mjs` | Diffs the TS backend against the Python reference over read-only routes. **Run before deploying.** |
| `README.md` | Deploy runbook. |

### 4.2 HITL on Workers (important — differs from Python)

There is no in-memory pause. The `ProductionWorkflow` uses the Cloudflare Workflow
primitive **`waitForEvent`** at each HITL gate, and the `POST /runs/{id}/resume`
route calls **`sendEvent`** to unblock it (see `src/workflows/production.ts` and
`src/routes/runs.ts`). Because Workflows are durable, a run survives a Worker
restart while paused at a gate.

### 4.3 RBAC

Roles are **Workers-authoritative** (`viewer < editor < admin`). A `viewer` is a
*content editor* — they may edit/save existing-run content but may **not**
create/regenerate runs, decide HITL gates, or publish. `BOOTSTRAP_ADMIN_EMAILS`
is the break-glass list that is always treated as `admin` (set to
`franco.ma@bowtie.com.hk` in prod).

---

## 5. The frontend (`web/`)

Next.js 16 + React 19 + TanStack Query + TipTap + Tailwind 4 + shadcn/ui.
**Read [`web/AGENTS.md`](../web/AGENTS.md) before editing** — Next.js 16 has
breaking changes from earlier versions.

### 5.1 Routes (`web/app/`)

| Route | Purpose |
|---|---|
| `runs/`, `runs/new`, `runs/[runId]` | Run list, create a run, and the run detail view. The detail route hosts the editor sub-pages: **HITL_1** outline review, **HITL_2** draft review, **edit**, and **regenerate** — all built on the shared `lib/run-editor` + `components/run-editor`. |
| `topic-batches/`, `topic-batches/[id]` | Front II — review generated topics, promote to create/refresh runs. |
| `library/` | Published / onboarded articles (CMS Stage 0 refresh surface). |
| `voices/`, `voices/[slug]` | Editorial personas + per-voice glossary. |
| `prompts/`, `prompts/[templateId]` | Prompt-template editor + history, and the "Source Policy" tab. |
| `admin/users` | User/role management (admin only). |
| `login`, `signup`, `verify` | better-auth email/password flow + `@bowtie.com.hk` gate. |

### 5.2 How the frontend talks to the backend

- **REST:** the app calls relative `/api/*` paths; Next `rewrites()`
  (`next.config.mjs`) proxy them server-side to the backend Worker — **no CORS**.
- **SSE:** the browser opens `${NEXT_PUBLIC_API_BASE}/runs/:id/events` (and
  `/topic-batches/:id/events`) **directly** against the backend Worker, which
  returns CORS headers. A one-time SSE ticket authorizes the stream.
- **Key lib files:** `lib/run-editor/` (editor form state), `lib/api`/query keys,
  the SSE opener, `lib/roles` + `use-role` (RBAC UI gating).
- **Tests:** first web test harness is **Vitest + RTL** (e.g. `lib/roles.test.ts`).
  E2E is Playwright.

### 5.3 Deploy

Built with `@opennextjs/cloudflare`: `npm run cf:build` then `npm run cf:deploy`
(see `web/wrangler.jsonc`). `NEXT_PUBLIC_API_BASE` is a **build-time** public var
(inlined), so it is passed at build time, not in `wrangler.jsonc`.

---

## 6. Shared config & data

| Path | What | Notes |
|---|---|---|
| `config/pricing.yaml` | Per-model token pricing for cost calc. | **Hot-reloaded** — no restart. Money is `HK$` by default. |
| `config/refresh.yaml` | CMS Stage 0 refresh cadence/thresholds. | |
| `config/personas/` + `config/source_policy.yaml` | Seed personas + source allow/deny. | Both are now **DB-backed and editable** in the UI; the YAML/MD are the seed. |
| `prompts/*.md` | LLM prompt templates. | **The DB (`prompt_templates`) is the runtime source of truth**; the `.md` files seed it. Editable in `/prompts`. |
| `supabase/migrations/` | **Canonical** DB migrations (schema `content_tool`, not `public`; RLS on; app connects as `content_tool_app`). | `supabase db reset` (local), `supabase db push` (prod), `supabase migration new <name>`. |
| `supabase/seed.sql` | Seed data (personas). | |

> ⚠️ **Canonical JSON serialization must stay byte-identical between Python and
> TypeScript.** Prompt assembly is hashed (prompt-SHA) for parity; a serializer
> drift silently breaks parity. There are tests guarding this — keep them green.

---

## 7. Tests, evals, CI

| Where | What |
|---|---|
| `tests/unit`, `tests/integration`, `tests/fixtures` | Python tests — pytest + pytest-asyncio (`asyncio_mode=auto`) + testcontainers. |
| `deploy/cloudflare-workers/**/*.test.ts` | Workers backend tests (Vitest). |
| `web/**/*.test.ts(x)` | Frontend Vitest + RTL; Playwright for E2E. |
| `evals/` | LLM-judge evals + fixtures. Nightly cron + PR label (`prompt-change`) trigger. `python -m evals.runner`. |
| `.github/workflows/ci.yml` | Lint (ruff, changed files) + typecheck (pyright, advisory) + pytest. |
| `.github/workflows/deploy-workers.yml` | On push to `main`: deploys both Workers to the Cloudflare account. |
| `.github/workflows/nightly-evals.yml` | Scheduled eval run. |

**Quality bars (see `CLAUDE.md` / `pyproject.toml`):** ruff (`E,F,I,B,UP,ASYNC,S,
ANN,RUF`, line length 100), **pyright strict** (don't add new errors in files you
touch — baseline is large), Conventional Commits with scope.

---

## 8. Suggested reading order for a newcomer

1. `CLAUDE.md` — the canonical one-screen brief.
2. This guide (§1–§3) — the two-backend model + the request lifecycle.
3. `content_tool/models/state.py` — the graph state object everything passes around.
4. `content_tool/graph/root.py` — where the two HITL interrupts are declared.
5. `content_tool/api/routes/runs.py` + `content_tool/api/sse.py` — how a run starts and streams.
6. One agent, e.g. `content_tool/agents/writer.py` — the node-function shape + refine-notes pattern.
7. `deploy/cloudflare-workers/src/workflows/production.ts` — the same pipeline as a durable Workflow (`waitForEvent`/`sendEvent` HITL).
8. `web/AGENTS.md`, then `web/app/runs/[runId]/` + `web/lib/run-editor/`.

---

## 9. Operations cheat-sheet

| Need | Where |
|---|---|
| Per-run cost | `GET /costs/run/{run_id}`; date range `GET /costs/summary` |
| Compliance export | `GET /compliance/export.csv` |
| Tracing | set `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. local Jaeger) |
| Trigger refresh scan | cron `scripts/refresh_scan`; manual `POST /refresh/scan` |
| Disable refresh cron | `REFRESH_CRON_ENABLED=false` |
| Update model prices | edit `config/pricing.yaml` (hot-reloaded) |
| Verify WP target before publish | check `target_label` from the dry-publish endpoint; `WP_TARGET`/`WP_BASE_URL` set per environment |

---

## 10. Known cleanup candidates (for the repo move)

- **Personal Cloudflare account references** — `*.fmc.workers.dev` URLs and the
  Hyperdrive id in `deploy/cloudflare-workers/wrangler.jsonc`, `web/wrangler.jsonc`,
  and `README.md` point at a personal `fmc` account. They are **not secrets**, but
  must be repointed when infra moves to a company Cloudflare account.
- **Root-level local artifacts** (screenshots, `content_tool.dump`) are gitignored
  and will not travel with the repo, but exist in working copies.

> The retired Tauri **desktop app** and the legacy **Alembic** migrations have been
> removed — production is Workers-only, with Supabase migrations as canonical.
