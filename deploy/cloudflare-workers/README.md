# Workers-native backend (production)

The **production backend** for the Bowtie AI Content Tool: a TypeScript
Cloudflare Worker (Hono + Cloudflare Workflows + Durable Objects) that runs the
full article pipeline. The database stays on Supabase, reached via
`postgres.js` through **Cloudflare Hyperdrive**.

This replaced the retired "Worker + 2 Containers" stack (formerly in
`deploy/cloudflare/`, now removed). The Python backend in `content_tool/` is
**not** deleted — it runs the evals suite and is used for local dev. It is just
no longer the production hosting path.

- **Service:** `bowtie-content-tool-poc`
- **URL:** https://bowtie-content-tool-poc.franco-ma.workers.dev
- **Account:** Franco's personal Cloudflare account ("Bowtie Content SEO" in
  the dashboard) — interim state pending migration to the company-owned
  Bowtie Enterprise Account, see `docs/secrets-and-ci.md`.

The frontend is a separate Worker — `web/` built with `@opennextjs/cloudflare`
(`bowtie-content-tool-web`, https://bowtie-content-tool-web.franco-ma.workers.dev).

## What it runs

| Surface | Implementation |
|---|---|
| HTTP routes | Hono (`src/routes/` — runs, articles, personas, prompts, costs, refresh, compliance, topic-batches, wp-options, setup) |
| Pipeline | Cloudflare Workflows (`src/workflows/` — `production`, `topic-expansion`, `refresh-scan`) with durable, retried steps |
| Run progress (SSE) | Durable Object `RunStream` (`src/run-stream.ts`) — persists then streams run events |
| LLM | Gemini via `src/gemini/`; the `GeminiProxy` DO egresses from a US region (Google AI Studio geo-blocks the Asia/HK colo) |
| DB | `postgres.js` over Hyperdrive (`src/db/` — typed query layer per `content_tool` table) |
| WordPress | `fetch`-based REST client (`src/wordpress/`) |
| Refresh (CMS Stage 0) | `src/refresh/` + a daily Cron Trigger (02:00 UTC) that kicks the `refresh-scan` Workflow |
| Agents | Pipeline node logic ported to TS (`src/agents/`) |
| CORS | `src/http/cors.ts` — SSE allow-origin = the frontend Worker (`FRONTEND_ORIGIN`) |

## Run locally

```bash
cd deploy/cloudflare-workers
npm install
cp .dev.vars.example .dev.vars   # fill in REMOTE Supabase + Gemini values
npm run types                    # generate worker-configuration.d.ts
npm run typecheck
npm run dev
```

Then:

```bash
curl localhost:8787/health
curl localhost:8787/db/ping
```

## Deploy

CI deploys on push to `main` (see `.github/workflows/deploy-workers.yml`).
Manual deploy:

```bash
cd deploy/cloudflare-workers
npm install
# Runtime secrets are set once and preserved across deploys:
npx wrangler secret put POSTGRES_URL    # postgresql://… session pooler (NOT +asyncpg, NOT :6543)
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put WP_USERNAME
npx wrangler secret put WP_APP_PASSWORD
npx wrangler deploy
```

Bindings (see `wrangler.jsonc`): Hyperdrive (`HYPERDRIVE`), Workflows
(`PRODUCTION`, `TOPIC_EXPANSION`, `REFRESH_SCAN`), Durable Objects
(`RUN_STREAM`, `GEMINI_PROXY`), and a daily Cron Trigger.

## Observability (Langfuse, optional)

Additive only and **OFF by default**. When enabled, every Gemini `generate()`
call from the `GeminiProxy` DO emits a Langfuse **generation** (input prompts,
output text, token usage, latency, finish reason, plus run-id / prompt
metadata), grouped by `run_id` as the trace id — mirroring the Python
`ObservedGeminiClient`. Prompts flow **one-way** into traces; Langfuse Prompt
Management is never used. A tracing fault never breaks a run.

Enable by setting the flag var to `true` **and** providing both keys as secrets.
With the flag unset/false or either key absent it is a strict no-op (no client,
no network, the `langfuse` package is never imported):

```bash
# Non-secret flag + host: set in wrangler.jsonc `vars` (or via `wrangler secret put`):
#   LANGFUSE_ENABLED = "true"
#   LANGFUSE_HOST    = "https://cloud.langfuse.com"   # or your self-hosted URL
# Secrets:
npx wrangler secret put LANGFUSE_PUBLIC_KEY
npx wrangler secret put LANGFUSE_SECRET_KEY
```

## Supabase / DB notes

- `postgres.js` over Hyperdrive — `{ max: 5, fetch_types: false }`. Still a direct
  SQL connection to the same Supabase DB; no PostgREST, Data API, or `supabase-js`.
- Use the Supabase **session-mode pooler** for `POSTGRES_URL` (the `postgresql://`
  scheme, not `postgresql+asyncpg://`). **Never** the transaction-mode pooler
  (`:6543`) — it breaks prepared statements.
- Schema is `content_tool`, not `public`.

## Design docs

- Spec: [`docs/design/specs/2026-05-31-workers-native-backend-design.md`](../../docs/design/specs/2026-05-31-workers-native-backend-design.md)
- Plan: [`docs/design/plans/2026-05-31-workers-native-backend.md`](../../docs/design/plans/2026-05-31-workers-native-backend.md)
- Load limits: [`docs/design/specs/2026-05-31-workers-native-load-limits.md`](../../docs/design/specs/2026-05-31-workers-native-load-limits.md)
