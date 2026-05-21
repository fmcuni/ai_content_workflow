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
