import { Hono } from "hono";
import postgres from "postgres";

import { personasRouter } from "./routes/personas";
import { promptsRouter } from "./routes/prompts";
import { articlesRouter } from "./routes/articles";
import { costsRouter } from "./routes/costs";
import { wpOptionsRouter } from "./routes/wp-options";
import { setupRouter } from "./routes/setup";
import { runsRouter } from "./routes/runs";
import { topicBatchesRouter } from "./routes/topic_batches";
import { complianceRouter } from "./routes/compliance";
import { refreshRouter } from "./routes/refresh";

export { ProductionWorkflow } from "./workflows/production";
export { TopicExpansionWorkflow } from "./workflows/topic_expansion";
export { RefreshScanWorkflow } from "./workflows/refresh_scan";
export { RunStream } from "./run-stream";
// US-pinned Gemini proxy DO — bypasses the Asia/HK geo-block on Google AI Studio.
export { GeminiProxy } from "./gemini/proxy_do";

export interface Env {
  // Hyperdrive binding — pools/proxies the Supabase connection so the Worker
  // avoids the raw TLS handshake (which blows the free plan's subrequest cap).
  HYPERDRIVE: Hyperdrive;
  // Secret — plain `postgresql://` (NOT +asyncpg). Supabase session pooler.
  // Kept for reference/diagnostics; DB access now goes through HYPERDRIVE.
  POSTGRES_URL?: string;
  // Secret.
  GEMINI_API_KEY: string;
  // Var (wrangler.jsonc), overridable.
  GEMINI_MODEL?: string;
  // Phase-3 production workflow binding (reuses RUN_STREAM DO for SSE).
  PRODUCTION: Workflow<{ runId: string }>;
  // Phase-5 topic-expansion (Front II) workflow binding (reuses RUN_STREAM DO).
  TOPIC_EXPANSION: Workflow<{ batchId: string }>;
  // Phase-6 periodic refresh-scan workflow binding (kicked by the Cron Trigger).
  REFRESH_SCAN: Workflow<{ triggerSource: string; articleIds?: string[]; force?: boolean }>;
  RUN_STREAM: DurableObjectNamespace<import("./run-stream").RunStream>;
  // US-pinned Gemini proxy DO — DoGeminiClient forwards generate() here so the
  // call egresses from a US region (Google AI Studio geo-blocks the Asia/HK colo).
  GEMINI_PROXY: DurableObjectNamespace<import("./gemini/proxy_do").GeminiProxy>;
  // Comma-separated allowlist of frontend origins permitted to open the SSE
  // streams cross-origin (the OpenNext frontend Worker). Unset → reflect the
  // request Origin (local dev). See src/http/cors.ts.
  FRONTEND_ORIGIN?: string;
  // WordPress connection — read by /setup/status. Optional: set per environment
  // via `wrangler secret put` (credentials) / vars (non-secret). May be unset.
  WP_BASE_URL?: string;
  WP_TARGET?: string;
  WP_USERNAME?: string;
  WP_APP_PASSWORD?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// Proof #1 — Postgres (Supabase) reachable from a Worker over TCP sockets.
app.get("/db/ping", async (c) => {
  // Connect through Hyperdrive (no upstream TLS handshake on the hot path → no
  // free-plan subrequest blowup). fetch_types:false trims pg_catalog round-trips.
  const sql = postgres(c.env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
  });
  try {
    const version = await sql<{ version: string }[]>`select version() as version`;
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'content_tool' order by table_name limit 50`;
    return c.json({
      ok: true,
      version: version[0]?.version ?? null,
      content_tool_tables: tables.map((r) => r.table_name),
    });
  } catch (err) {
    // Non-secret diagnostic: surface host/port/sslmode (credentials masked) so we
    // can tell a session pooler (:5432) from the transaction pooler (:6543).
    let where: { host: string; port: string; sslmode: string | null } | null = null;
    try {
      const u = new URL((c.env.POSTGRES_URL ?? "").replace("postgresql+asyncpg://", "postgresql://"));
      where = { host: u.hostname, port: u.port, sslmode: u.searchParams.get("sslmode") };
    } catch {
      /* unparseable / unset */
    }
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), where },
      500,
    );
  } finally {
    // Close the socket after the response is sent (ignore errors if never opened).
    c.executionCtx.waitUntil(sql.end().catch(() => undefined));
  }
});

// Phase-1 route groups. Mounted at BARE paths (no `/api` prefix): the Next.js
// frontend rewrites `/api/<group>/* → ${apiBase}/<group>/*`, so the backend
// serves bare paths.
app.route("/personas", personasRouter);
app.route("/prompts", promptsRouter);
app.route("/articles", articlesRouter);
app.route("/costs", costsRouter);
app.route("/wp-options", wpOptionsRouter);
app.route("/setup", setupRouter);
app.route("/runs", runsRouter);
app.route("/topic-batches", topicBatchesRouter);
app.route("/compliance", complianceRouter);
app.route("/refresh", refreshRouter);

// The default export carries BOTH the HTTP handler (Hono) and the Cron Trigger
// `scheduled` handler. The cron fires the refresh-scan Workflow (CMS Stage 0);
// the Workflow owns durability/retries, so we just kick it and return.
export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(env.REFRESH_SCAN.create({ params: { triggerSource: "cron" } }));
  },
} satisfies ExportedHandler<Env>;
