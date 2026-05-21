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
