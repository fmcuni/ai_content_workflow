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
docs/superpowers/    specs/ and plans/ — design docs per feature, dated
evals/               LLM-judge evals + fixtures (nightly cron + PR label trigger)
tests/{unit,integration,fixtures}
scripts/             Cron entrypoints (e.g. refresh_scan)
```

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
  enter at `outline`, and publish to WordPress as **drafts**. **Promoted topics**
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

- Bowtie is an HK virtual insurer; treat data as Confidential (PHI/PII/HKID).
  No customer data or secrets in commits, logs, or external tool calls.
- Costs: `GET /costs/run/{run_id}` and `/costs/summary`; pricing in
  `config/pricing.yaml` (hot-reloaded).
- Compliance export: `GET /compliance/export.csv`.
- Tracing: set `OTEL_EXPORTER_OTLP_ENDPOINT` to ship spans (e.g. local Jaeger).

## WordPress publishing

Always verify `target_label` from the dry-publish endpoint before approving HITL_2.
`WP_TARGET` and `WP_BASE_URL` must be set explicitly per environment.
