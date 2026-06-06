# Langfuse — self-hosted observability for AI Content Tool

All trace data lives in our own infrastructure (Postgres + ClickHouse +
Redis).  Nothing is sent to Langfuse Cloud.

## Bring-up

```bash
# From repo root
docker compose -f deploy/langfuse/docker-compose.yml up -d
```

Wait ~30 seconds for ClickHouse to initialise, then open
http://localhost:3000 and sign up (first user becomes admin).

Create an **organisation** (e.g. "Bowtie") and a **project** (e.g. "AI
Content Tool").  Navigate to **Settings → API Keys** and copy the
**Public Key** and **Secret Key**.

## Required env vars for the app

Add to `.env.local` (local dev) or set via `wrangler secret put` (Workers):

| Variable | Example | Notes |
|---|---|---|
| `LANGFUSE_ENABLED` | `true` | Must be `true` to activate — defaults to `false` |
| `LANGFUSE_HOST` | `http://localhost:3000` | URL of this Langfuse instance |
| `LANGFUSE_PUBLIC_KEY` | `pk-lf-…` | From Settings → API Keys |
| `LANGFUSE_SECRET_KEY` | `sk-lf-…` | From Settings → API Keys (treat as a secret) |

When `LANGFUSE_ENABLED=false` (the default) the app never imports the
Langfuse SDK and behaves identically to a build without the integration.

## Production hardening checklist

- [ ] Change `NEXTAUTH_SECRET` and `SALT` in `docker-compose.yml` to
      random 32-byte hex strings (`openssl rand -hex 32`).
- [ ] Put `langfuse-web` behind a reverse proxy (nginx / Cloudflare Tunnel)
      with TLS.  Do not expose port 3000 directly on a public interface.
- [ ] Set `LANGFUSE_HOST` in the app to the internal/private URL, not the
      public one, so traces are never routed through the public internet.
- [ ] Back up the `langfuse_postgres_data` and `langfuse_clickhouse_data`
      Docker volumes on the same schedule as the main Supabase DB.
- [ ] Pin image tags to a specific patch version once the stack is stable
      (replace `langfuse/langfuse:3` with e.g. `langfuse/langfuse:3.x.y`).

## What is traced

Every call to `gemini.generate()` that passes through `ObservedGeminiClient`
emits a **generation** span carrying:

- Agent name (e.g. `writer`, `audit`, `judge.brand_voice`)
- System prompt + user prompt (input)
- Raw text + parsed JSON (output)
- Token usage (input / output / total including thinking tokens)
- Latency (ms)
- Finish reason
- Prompt metadata: `template_id`, `voice_slug`, `sha256` (links back to
  `content_tool.prompt_templates` — Langfuse never stores or serves prompts)
- `session_id` = `run_id` (groups all generations from one run into one
  Langfuse session for easy debugging)

## What is NOT stored in Langfuse

- Prompt templates — the `content_tool.prompt_templates` table is the
  single source of truth.  Prompts flow one-way into traces as recorded
  input and are never read back from Langfuse by the app.
- Customer PII, PHI, HKID, or any Bowtie private data.  This tool handles
  public marketing/editorial content only.

## Stopping / resetting

```bash
# Stop without losing data
docker compose -f deploy/langfuse/docker-compose.yml down

# Wipe all trace data (destructive)
docker compose -f deploy/langfuse/docker-compose.yml down -v
```
