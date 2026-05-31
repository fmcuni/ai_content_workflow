# Bowtie AI Content Tool

LangGraph-based content update tool. See `docs/superpowers/specs/2026-05-21-bowtie-ai-content-tool-update-route-mvp-design.md` for design.

## Dev setup

Requires Python 3.13 and [uv](https://docs.astral.sh/uv/).

```bash
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
cp .env.example .env.local
# fill in GEMINI_API_KEY
```

## Run tests

```bash
pytest
```

## Run gap_analysis on an article (CLI)

```bash
content-tool gap-analysis --article-url https://www.bowtie.com.hk/blog/... --topic "..." --keywords "..."
```

## Manual smoke test (Plan 2)

```bash
# 1. Start Postgres + apply migrations
docker run -d --name content_tool_pg -p 5432:5432 \
  -e POSTGRES_USER=content_tool -e POSTGRES_PASSWORD=content_tool -e POSTGRES_DB=content_tool postgres:16
export POSTGRES_URL=postgresql+asyncpg://content_tool:content_tool@localhost:5432/content_tool
export GEMINI_API_KEY=<your-key>
alembic upgrade head

# 2. Start the API
uvicorn content_tool.api.main:app --reload --port 8000

# 3. Trigger a run
curl -X POST localhost:8000/runs \
  -H 'content-type: application/json' \
  -d '{"article_url":"https://www.bowtie.com.hk/blog/zh/<some-real-slug>/",
        "topic":"...","keywords":["..."],
        "acf_adv_id":1,"acf_widget_id":2,
        "editor_email":"you@bowtie.com"}'

# 4. Watch events
curl -N localhost:8000/runs/<run_id>/events

# 5. After HITL_1 interrupt, approve:
curl -X POST localhost:8000/runs/<run_id>/resume \
  -H 'content-type: application/json' -d '{"decision":"approve"}'
```

## Web UI

```bash
cd web
cp .env.local.example .env.local
npm install
npm run dev
# → http://localhost:3000
```

Backend must be running on http://localhost:8000.

## Deployment (production)

Production runs on a **Workers-native** Cloudflare stack (the database stays on
Supabase). The Python backend here is still used for the desktop Tauri sidecar,
the evals suite, and local dev — it is just not the production hosting path.

| Component | Service | URL |
|---|---|---|
| Backend (TypeScript Worker — Hono + Workflows + Durable Objects, DB via Hyperdrive) | `bowtie-content-tool-poc` | https://bowtie-content-tool-poc.fmc.workers.dev |
| Frontend (Next.js via `@opennextjs/cloudflare`) | `bowtie-content-tool-web` | https://bowtie-content-tool-web.fmc.workers.dev |

- **CI:** `.github/workflows/deploy-workers.yml` deploys both Workers to the
  personal `fmc` Cloudflare account on push to `main`.
- **Backend source + deploy runbook:** [`deploy/cloudflare-workers/README.md`](deploy/cloudflare-workers/README.md)
- **Frontend deploy:** `cd web && npm run cf:deploy` (see [`web/README.md`](web/README.md))
- **Design docs:** spec `docs/superpowers/specs/2026-05-31-workers-native-backend-design.md`,
  plan `docs/superpowers/plans/2026-05-31-workers-native-backend.md`.

This replaced the retired "Worker + 2 Containers" stack (formerly `deploy/cloudflare/`,
`Dockerfile.cf-*`, `.github/workflows/deploy-cloudflare.yml` — all removed).

## WordPress smoke test (staging)

1. Set up an Application Password for your WP user at:
   `https://staging.bowtie.com.hk/wp-admin/profile.php` → "Application Passwords"

2. Export env:
```bash
export WP_BASE_URL=https://staging.bowtie.com.hk
export WP_TARGET=staging
export WP_USERNAME=<your-wp-username>
export WP_APP_PASSWORD=<application-password>
```

3. Run a full end-to-end via UI. After approving HITL_2 (status = Draft),
   confirm the post appears in `/wp-admin/edit.php?post_status=draft` on staging.

4. **Before pointing at production**: explicitly set `WP_TARGET=production` and `WP_BASE_URL=https://www.bowtie.com.hk`.
   The dry-publish endpoint shows `target_label` — verify it matches expectation
   before approving any HITL_2 against production.

## Ops

### Observability

- Logs: JSON via structlog to stdout. Set `LOG_LEVEL=debug` for verbose.
- Tracing: OpenTelemetry. If `OTEL_EXPORTER_OTLP_ENDPOINT` is set, spans go to that OTLP HTTP receiver.
  Local Jaeger: `docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one`
  then `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and visit http://localhost:16686.

### Costs

- Per-run estimate: `GET /costs/run/{run_id}`
- Date-range summary: `GET /costs/summary?start=2026-05-01&end=2026-05-31`
- Update prices: edit `config/pricing.yaml`. No restart needed (loaded on demand).

### Compliance audit log

- Auto-written on every `published` run.
- Export: `GET /compliance/export.csv?start=2026-05-01&end=2026-05-31`

### Evals

- Nightly cron runs reference evals against last 30 published runs → `content_tool.evals`.
- Manual: `python -m evals.runner`
- LLM-judge: triggered on PRs labeled `prompt-change`.

## Refresh route (CMS Stage 0)

Periodic re-audit of onboarded articles, surfaced at `/library`.

- **Spec:** `docs/superpowers/specs/2026-05-22-cms-stage-0-refresh-route-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-22-plan-7-refresh-route.md`
- **Cron entrypoint:** `uv run python -m scripts.refresh_scan`
- **Manual scan:** `POST /refresh/scan`
- **Manual single-article:** `POST /refresh/scan/{article_id}`
- **Disable cron without code changes:** set `REFRESH_CRON_ENABLED=false`
- **After pulling Plan 7:** run `cd web && npm install` — the calendar + sheet shadcn components add `react-day-picker` and friends, so a stale `node_modules` will 500 `/library`.
