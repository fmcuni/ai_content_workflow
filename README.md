# Bowtie AI Content Tool

LangGraph-based content update tool. See `docs/superpowers/specs/2026-05-21-bowtie-ai-content-tool-update-route-mvp-design.md` for design.

## Dev setup

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
