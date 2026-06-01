import { Hono } from "hono";
import postgres from "postgres";

import { personasRouter } from "./routes/personas";
import { promptsRouter } from "./routes/prompts";
import { sourcePolicyRouter } from "./routes/source_policy";
import { articlesRouter } from "./routes/articles";
import { costsRouter } from "./routes/costs";
import { wpOptionsRouter } from "./routes/wp-options";
import { setupRouter } from "./routes/setup";
import { runsRouter } from "./routes/runs";
import { topicBatchesRouter } from "./routes/topic_batches";
import { complianceRouter } from "./routes/compliance";
import { refreshRouter } from "./routes/refresh";
import { adminRouter } from "./routes/admin";
import { getAuth } from "./auth/auth";
import { requireAuth, type AuthVars } from "./auth/middleware";
import { loadRole, requireRole } from "./auth/authz";
import { mintTicket } from "./auth/ticket";

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
  // --- Auth (better-auth) ---
  // Secret — signs sessions + SSE tickets. `wrangler secret put AUTH_SECRET`.
  AUTH_SECRET?: string;
  // Secret — Resend API key for verification / password-reset emails.
  RESEND_API_KEY?: string;
  // Var — From header for Resend (e.g. "Bowtie Content Desk <noreply@bowtie.com.hk>").
  RESEND_FROM?: string;
  // Var — comma-separated email-domain allowlist for sign-up (default bowtie.com.hk).
  ALLOWED_EMAIL_DOMAINS?: string;
  // Var — set "off" to temporarily allow sign-in without email verification
  // (and skip the on-signup send). Anything else (or unset) = verification ON.
  EMAIL_VERIFICATION?: string;
  // Var — set "true" to bypass the auth gate for local dev (Python backend).
  AUTH_DISABLED?: string;
  // Var — comma-separated email allowlist (case-insensitive) that is always
  // granted the `admin` effective role, regardless of the stored DB role. This
  // is the RBAC break-glass bootstrap: it guarantees a fresh DB (every user
  // defaulting to `viewer`) is never locked out of role management. See
  // src/auth/authz.ts `effectiveRole`.
  BOOTSTRAP_ADMIN_EMAILS?: string;
  // WordPress connection — read by /setup/status. Optional: set per environment
  // via `wrangler secret put` (credentials) / vars (non-secret). May be unset.
  WP_BASE_URL?: string;
  WP_TARGET?: string;
  WP_USERNAME?: string;
  WP_APP_PASSWORD?: string;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// --- Auth (better-auth) ----------------------------------------------------
// Mounted at a PATH-PRESERVING /api/auth/* — the frontend rewrite keeps the
// `/api` prefix (unlike the bare-path REST rewrites), so the session cookie is
// same-origin on the web domain. Registered before requireAuth so it stays
// public. See src/auth/auth.ts.
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  const { auth, sql } = getAuth(c.env);
  try {
    return await auth.handler(c.req.raw);
  } finally {
    c.executionCtx.waitUntil(sql.end().catch(() => undefined));
  }
});

// Gate everything below: REST via the session cookie, SSE via `?ticket`.
// /health, /api/auth/* (and OPTIONS preflight) are exempted inside requireAuth.
app.use("*", requireAuth);

// Issue a short-lived SSE ticket to the authenticated user (cookie-protected by
// requireAuth above). The browser passes it on the cross-origin SSE URL.
app.get("/api/auth-ticket", async (c) => {
  const ticket = await mintTicket(c.env, c.get("userId"));
  return c.json({ ticket });
});

// GET /me — the current session's email + EFFECTIVE role (bootstrap override
// applied). The frontend uses this to gate UI affordances. Authenticated only
// (no role requirement). 401 if there is no session identity at all.
app.get("/me", async (c) => {
  const role = await loadRole(c);
  if (role === null) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json({ email: c.get("userEmail") ?? null, role });
});

// --- RBAC route gates -------------------------------------------------------
// Method+path scoped guards registered BEFORE the corresponding app.route(...)
// mounts. The `runs` router gates its own mutating routes internally (it owns
// the SoD logic too); these cover the routers that take only Bindings (no
// AuthVars in their generic), so gating at the mount keeps their typing intact.
// Read-only routes are intentionally NOT listed — the requireAuth gate above
// already enforces an authenticated (viewer) session for them.

// prompts: edit (PUT) + revert (POST) → admin. preview (POST) is a pure render
// of a candidate template, no persistence → author.
app.put("/prompts/templates/:id", requireRole("admin"));
app.post("/prompts/templates/:id/revert", requireRole("admin"));
app.post("/prompts/templates/:id/preview", requireRole("author"));

// personas: create / edit / archive / restore → admin.
app.post("/personas", requireRole("admin"));
app.put("/personas/:slug", requireRole("admin"));
app.post("/personas/:slug/archive", requireRole("admin"));
app.post("/personas/:slug/restore", requireRole("admin"));

// source-policy: edit (PUT) + revert (POST) → admin. preview (POST) → author.
app.put("/source-policy", requireRole("admin"));
app.post("/source-policy/revert", requireRole("admin"));
app.post("/source-policy/preview", requireRole("author"));

// topic-batches: create batch + promote topics → author. skip a candidate +
// close a batch are editorial mutations → author. DELETE batch → admin.
app.post("/topic-batches", requireRole("author"));
app.post("/topic-batches/:id/promote", requireRole("author"));
app.post("/topic-batches/:id/candidates/:cid/skip", requireRole("author"));
app.post("/topic-batches/:id/close", requireRole("author"));
app.delete("/topic-batches/:id", requireRole("admin"));

// refresh: kick a re-audit scan (existing post) → author.
app.post("/refresh/scan", requireRole("author"));
app.post("/refresh/scan/:articleId", requireRole("author"));

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
app.route("/source-policy", sourcePolicyRouter);
app.route("/articles", articlesRouter);
app.route("/costs", costsRouter);
app.route("/wp-options", wpOptionsRouter);
app.route("/setup", setupRouter);
app.route("/runs", runsRouter);
app.route("/topic-batches", topicBatchesRouter);
app.route("/compliance", complianceRouter);
app.route("/refresh", refreshRouter);
// Admin user-management — every route gated by requireRole("admin"); see
// src/routes/admin.ts. Registered after the gate above (it is not a public path).
app.use("/admin/*", requireRole("admin"));
app.route("/admin", adminRouter);

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
