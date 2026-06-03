# Bowtie AI Content Tool

LangGraph-based content update tool with two Human-In-The-Loop gates, publishing
to WordPress.

**New to the repo? Start here:**
- 📖 [`docs/CODEBASE_GUIDE.md`](docs/CODEBASE_GUIDE.md) — what every folder is, how a
  request flows end-to-end, and a suggested reading order.
- 🤝 [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, the two-backend parity
  rule, migrations, code style, and the PR workflow.
- 🧭 [`CLAUDE.md`](CLAUDE.md) — the canonical one-screen project brief.
- 🏗️ Original design: `docs/superpowers/specs/2026-05-21-bowtie-ai-content-tool-update-route-mvp-design.md`.

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
# 1. Start the local DB + apply all migrations (Supabase migrations are canonical;
#    the legacy alembic/ directory is retired).
supabase db reset
export POSTGRES_URL=<from `supabase status` — the connection string>
export GEMINI_API_KEY=<your-key>

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
Supabase). The Python backend here is used for the evals suite and local dev —
it is just not the production hosting path.

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

## WordPress smoke test

1. Set up an Application Password for your WP user at
   `<WP_BASE_URL>/wp-admin/profile.php` → "Application Passwords".

2. Export env (set `WP_BASE_URL` / `WP_TARGET` explicitly for the environment you
   intend to publish to):
```bash
export WP_BASE_URL=<your-wp-base-url>
export WP_TARGET=<your-target>
export WP_USERNAME=<your-wp-username>
export WP_APP_PASSWORD=<application-password>
```

3. Run a full end-to-end via the UI. After approving HITL_2 (status = Draft),
   confirm the post appears under `/wp-admin/edit.php?post_status=draft`.

4. **Safety:** the dry-publish endpoint shows `target_label` — always verify it
   matches the environment you expect **before** approving any HITL_2. Never
   point at production without explicitly setting `WP_TARGET` and `WP_BASE_URL`
   for production.

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
