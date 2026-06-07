# Project Instructions

Bowtie AI Content Tool — LangGraph-based article update pipeline with HITL
(Human-In-The-Loop) gates, publishing to WordPress.

## Tech Stack

- **Backend:** Python 3.13, FastAPI, LangGraph, SQLAlchemy async, Pydantic v2,
  asyncpg, sse-starlette, OpenTelemetry, structlog
- **LLM:** Google Gemini (`google-genai`)
- **DB:** PostgreSQL 16
- **Frontend:** Next.js 16, React 19, TanStack Query, TipTap, Tailwind 4, shadcn
- **Tests:** pytest + pytest-asyncio + testcontainers (backend), Playwright (web)
- **Lint/Type:** ruff + pyright **strict**
- **Tooling:** uv (Python), npm (web)

## Build & Run

| Task | Command |
|---|---|
| Install (Python) | `uv venv && source .venv/bin/activate && uv pip install -e ".[dev]"` |
| Install (web) | `cd web && npm install` |
| Backend dev | `uvicorn content_tool.api.main:app --reload --port 8000` |
| Web dev | `cd web && npm run dev` (→ http://localhost:3000) |
| Tests (py) | `pytest` |
| Tests (web) | `cd web && npx playwright test` |
| Lint (py) | `ruff check .` |
| Typecheck | `pyright` |
| Migrate DB (local) | `supabase db reset` |
| Migrate DB (prod) | `supabase db push` |
| New migration | `supabase migration new <name>` |
| CLI | `content-tool gap-analysis --article-url ... --topic ... --keywords ...` |

## Project Structure

```
content_tool/        Backend Python package
  api/               FastAPI app + routes/ (runs, articles, personas, prompts, ...)
  agents/            LangGraph node functions (fetch, outline, writer, audit, publish, ...)
  graph/             Graph composition (root, strategy, production, checkpointer)
  models/            Pydantic models + LangGraph state types
  db/                SQLAlchemy models, async engine/session
  gemini/            Gemini client wrapper
  wordpress/         WP REST client, SEO plugin detection
  policy/            Personas, source policy
  compliance/        Compliance audit log writer
  observability/     Logging, tracing, cost calculation
  refresh/           Periodic article re-audit (CMS Stage 0)
config/              YAML config (pricing, refresh, personas, source_policy)
prompts/             LLM prompt templates (.md)
supabase/migrations/ Supabase migration files (baseline + future changes)
supabase/seed.sql    Seed data (personas)
web/                 Next.js 16 frontend (see web/AGENTS.md before editing)
deploy/cloudflare-workers/  Production hosting: TypeScript port of the backend as a
                     Cloudflare Worker (Hono + Workflows + Durable Objects, DB via
                     postgres.js over Hyperdrive). See its README + AGENTS notes.
docs/superpowers/    specs/ and plans/ — design docs per feature, dated
evals/               LLM-judge evals + fixtures (nightly cron + PR label trigger);
                     prompt_advisor.py = aggregate LLM-as-judge that prescribes
                     prompt fixes (`python -m evals.run_prompt_advisor`)
tests/{unit,integration,fixtures}
scripts/             Cron entrypoints (e.g. refresh_scan)
```

## Deployment (production)

Production runs the **Workers-native TypeScript port**, not the Python backend:

| Service | Source | URL |
|---|---|---|
| Backend | `deploy/cloudflare-workers/` (`bowtie-content-tool-poc`) | `https://bowtie-content-tool-poc.fmc.workers.dev` |
| Frontend | `web/` via `@opennextjs/cloudflare` (`bowtie-content-tool-web`) | `https://bowtie-content-tool-web.fmc.workers.dev` |

- CI: `.github/workflows/deploy-workers.yml` deploys both to the `fmc` Cloudflare
  account on push to `main` (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
  Runtime secrets (`POSTGRES_URL`, `GEMINI_API_KEY`, `WP_*`) are set once via
  `wrangler secret put` and preserved across deploys.
- The Python backend (`content_tool/`) is **retained** — it runs the `evals/`
  suite and is used for local dev. It is no longer the production hosting path.
  (The old Worker+Containers stack — `deploy/cloudflare/`, `Dockerfile.cf-*` — and
  the Tauri desktop app were retired.)
- Parity gate: `node deploy/cloudflare-workers/parity/check-parity.mjs` diffs the TS
  backend against the Python reference over read-only routes.

## Architecture

- Request enters via FastAPI route in `content_tool/api/routes/`.
- `RunExecutor` (`api/sse.py`) drives a compiled LangGraph from `graph/root.py`,
  composed of `strategy` and `production` subgraphs.
- Two HITL interrupts: `HITL_1` (after outline) and `HITL_2` (after draft);
  resumed via `POST /runs/{id}/resume`. UI streams progress over SSE.
- Approval at HITL_2 publishes via `wordpress/client.py` and writes the
  compliance audit log.
- Entry modes via `start_mode`: refresh runs follow the path above; **Front II**
  ("Expand Topics") runs the `topic_expansion` subgraph (theme → topic-gen →
  dedup + hot-topic → HITL_T1 review → fan-out to runs); **Front III** ("Create
  New Articles") uses `start_mode="create"` — skip `fetch_article`/`gap_analysis`,
  enter at `outline`, and publish to WordPress with the operator's selected
  `wp_publish_status` (defaulting to **draft** when unset; both create and
  refresh honor the choice — see `wordpress/publish_status` / `publish.py`).
  **Promoted topics**
  (Front II → `POST /topic-batches/{id}/promote`) fan out per the selected promotion
  `mode`: `create` promotions follow the Front III path above, while `refresh`
  promotions use `start_mode="refresh"` with the candidate's `existing_url` and run
  the full refresh path (fetch + gap analysis).

## Conventions

- **Async everywhere** — DB, HTTP, Gemini. `asyncio_mode = "auto"` in pytest.
- **Pyright strict.** Add precise type hints; do not weaken the config to fix errors.
  The baseline is ~547 existing errors — focus on not adding new ones in touched files.
- **Ruff rules:** `E, F, I, B, UP, ASYNC, S, ANN, RUF` (`S101` ignored, tests exempt from
  `ANN`). Line length 100.
- **Naming:** snake_case modules; PascalCase Pydantic models; tests as `test_*.py`.
- **Frontend:** see `web/AGENTS.md` — Next.js 16 has breaking changes from earlier
  versions; consult `node_modules/next/dist/docs/` before writing Next code.
- **Commits:** Conventional Commits with scope: `feat(web):`, `fix(hitl2):`,
  `test(personas):`, etc.
- **Specs & plans:** new features get a dated design doc under
  `docs/superpowers/specs/` and a plan under `docs/superpowers/plans/`.

## Ops & Data

- **Scope:** this app handles public marketing/editorial content only — no
  customer PII, PHI, HKID, or other Bowtie private data passes through it.
  Standard hygiene still applies: no secrets/credentials in commits, logs, or
  external tool calls.
- Costs: `GET /costs/run/{run_id}` and `/costs/summary`; pricing in
  `config/pricing.yaml` (hot-reloaded).
- Compliance export: `GET /compliance/export.csv`.
- Tracing: set `OTEL_EXPORTER_OTLP_ENDPOINT` to ship spans (e.g. local Jaeger).

## Supabase

**Managed Postgres only** — no PostgREST, no Supabase Auth, no `supabase-js`.
SQLAlchemy/asyncpg owns all data access for the Python backend.

**Workers-native backend** (`deploy/cloudflare-workers/`) uses `postgres.js` through
Cloudflare Hyperdrive (`{ max: 5, fetch_types: false }`) instead of SQLAlchemy/asyncpg —
still a direct SQL connection to the same Supabase DB; no PostgREST, Data API, or
`supabase-js` is introduced.

**Schema:** `content_tool` (not `public`) — not auto-exposed to PostgREST/Data API.
RLS is enabled on all tables as defense in depth; app connects via the dedicated
`content_tool_app` role (not the `postgres` superuser).

**Connection choice:**
- **Direct connection** (port 5432) — default for the long-lived FastAPI process;
  supports SQLAlchemy/asyncpg prepared statements without workarounds.
- **Session-mode pooler** (port 5432 via pooler) — fallback if the host is
  IPv4-only and cannot reach the direct connection endpoint.
- **Never** use the transaction-mode pooler (port 6543) — it breaks prepared
  statements and silently degrades performance.

**Migration workflow:**
- `supabase migration new <name>` — scaffold a new migration
- `supabase db reset` — wipe + re-apply all migrations locally
- `supabase db push` — apply pending migrations to the linked prod project

**Prod cutover runbook (E1–E9):** see [Supabase Cutover Runbook (E1–E9)](https://www.notion.so/36fef2b9861481d39723d884070e30fa) in Notion.

## WordPress publishing

Always verify `target_label` from the dry-publish endpoint before approving HITL_2.
`WP_TARGET` and `WP_BASE_URL` must be set explicitly per environment.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
