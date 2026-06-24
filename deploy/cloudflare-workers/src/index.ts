import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import postgres from "postgres";

import { personasRouter } from "./routes/personas";
import { publishTargetsRouter } from "./routes/publish_targets";
import { promptsRouter } from "./routes/prompts";
import { sourcePolicyRouter } from "./routes/source_policy";
import { articlesRouter } from "./routes/articles";
import { costsRouter } from "./routes/costs";
import { wpOptionsRouter } from "./routes/wp-options";
import { ghostOptionsRouter } from "./routes/ghost-options";
import { mediaRouter } from "./routes/media";
import { setupRouter } from "./routes/setup";
import { runsRouter } from "./routes/runs";
import { topicBatchesRouter } from "./routes/topic_batches";
import { complianceRouter } from "./routes/compliance";
import { refreshRouter } from "./routes/refresh";
import { adminRouter } from "./routes/admin";
import { requireAuth, type AuthVars } from "./auth/middleware";
import { loadRole, requireRole } from "./auth/authz";
import { mintTicket } from "./auth/ticket";
import { blockKnownCrawlers, ROBOTS_TXT } from "./http/bot-guard";
import { applySecurityHeaders, isWebSocketUpgrade } from "./http/security-headers";

export { ProductionWorkflow } from "./workflows/production";
export { TopicExpansionWorkflow } from "./workflows/topic_expansion";
export { RefreshScanWorkflow } from "./workflows/refresh_scan";
export { RunStream } from "./run-stream";
// US-pinned Gemini proxy DO — bypasses the Asia/HK geo-block on Google AI Studio.
export { GeminiProxy } from "./gemini/proxy_do";
export { RunDoc } from "./run-doc";

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
  // Per-run collaborative-editing DO — Yjs CRDT sync for the run editor.
  RUN_DOC: DurableObjectNamespace<import("./run-doc").RunDoc>;
  // --- Rate Limiting (Cloudflare native `ratelimit` binding) ---
  // Abuse-prevention throttles for the expensive/mutating endpoints. Each
  // exposes `await env.X.limit({ key }) => { success }`; the middleware in this
  // file keys on the authenticated user id (else the client IP) and combines a
  // per-user AND per-IP check. Generous caps (not product quotas):
  //   - RATE_LIMITER_MUTATION: run create/resume/apply-edits + topic-batches.
  // Optional (`?`) so local dev / the node test pool (no binding) fail OPEN.
  RATE_LIMITER_MUTATION?: RateLimit;
  // Comma-separated allowlist of frontend origins permitted to open the SSE
  // streams cross-origin (the OpenNext frontend Worker). Unset → reflect the
  // request Origin (local dev). See src/http/cors.ts.
  FRONTEND_ORIGIN?: string;
  // --- Auth ---
  // Secret — signs short-lived SSE / collab WebSocket tickets (src/auth/ticket.ts).
  // `wrangler secret put AUTH_SECRET`.
  AUTH_SECRET?: string;
  // Var — comma-separated domains eligible for the `admin` role (default
  // bowtie.com.hk,bowtie.com.sg). Non-eligible emails can log in but never be admin.
  ADMIN_EMAIL_DOMAINS?: string;
  // Var — set "true" to bypass the auth gate for local dev (Python backend).
  AUTH_DISABLED?: string;
  // --- Supabase Auth (GoTrue) ---
  // Var — Supabase project URL, e.g. https://<ref>.supabase.co. Used to derive
  // the public JWKS URL (`/auth/v1/.well-known/jwks.json`) for JWT verify and as
  // the GoTrue admin REST base (WS3). Unset → supabase branch degrades safely.
  SUPABASE_URL?: string;
  // Secret — GoTrue service_role key. Worker-only (never shipped to the browser);
  // authorizes the admin user-management REST calls (WS3).
  SUPABASE_SERVICE_ROLE_KEY?: string;
  // Secret — HS256 shared JWT secret. Fallback verifier used only when asymmetric
  // signing keys (JWKS) are not enabled on the project. See src/auth/jwt.ts.
  SUPABASE_JWT_SECRET?: string;
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
  // Per-voice CMS publish targets: each non-default target reads its base URL +
  // credentials from env keyed by the publish_targets.auth_ref prefix, e.g.
  // VHIS101_WP_BASE_URL / VHIS101_WP_USERNAME / VHIS101_WP_APP_PASSWORD. These
  // are dynamic (one trio per target), so they are accessed by computed key in
  // publishers/wp_factory.ts rather than typed individually here. Set each via
  // `wrangler secret put`.
  // Var — verbose per-step event log persistence toggle for raw *.thinking
  // events. ON by default; "0" / "false" / "off" stream thinking live but skip
  // persisting it to content_tool.run_event_logs. Read by the RunStream DO.
  PERSIST_THINKING?: string;
  // --- Langfuse observability (additive; default OFF) ---
  // Var — "true"/"1"/"on"/"yes" enables emitting a Langfuse GENERATION per Gemini
  // call from the GeminiProxy DO. Anything else (or unset) = strict no-op: no
  // client, no network, the `langfuse` package is never imported. Mirrors the
  // Python ObservedGeminiClient. Prompts flow ONE-WAY into traces; Langfuse
  // Prompt Management is never used. See src/observability/langfuse.ts.
  LANGFUSE_ENABLED?: string;
  // Secrets — `wrangler secret put LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`.
  // Both must be present (in addition to LANGFUSE_ENABLED) or the integration
  // stays a no-op.
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  // Var — Langfuse host (e.g. "https://cloud.langfuse.com" or a self-hosted URL).
  LANGFUSE_HOST?: string;
}

// --- Rate limiting ----------------------------------------------------------
// Window of the `ratelimit` bindings below — MUST match `simple.period` in
// wrangler.jsonc (Cloudflare only permits 10 or 60). Used as the `Retry-After`
// value on a 429.
const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * Hono middleware factory for the Cloudflare native rate-limit binding named
 * `bindingName`. Scope it to the abuse-prone POST routes only (never SSE/WS/GET)
 * by registering it as route-level middleware.
 *
 * Key derivation: the authenticated `userId` when present (set by requireAuth),
 * else the client IP (`cf-connecting-ip`). It runs BOTH a per-user and a per-IP
 * check against the same limiter so a single abusive account and a single
 * abusive IP are each capped. On any `{ success:false }` it returns 429 with a
 * `Retry-After` header (the limiter period in seconds).
 *
 * Fails OPEN: if the binding is unset (local dev, the node test pool), the
 * request passes — throttling is an abuse guard, not an auth gate, so a missing
 * binding must never wedge the app.
 */
export function makeRateLimitMiddleware(
  bindingName: "RATE_LIMITER_MUTATION",
): MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> {
  return async (c, next) => {
    const limiter = c.env[bindingName];
    if (!limiter) return next(); // unbound → fail open

    const userId = c.get("userId");
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    // Two independent buckets, both must pass. Prefix-namespaced so a user id
    // can never collide with an IP literal.
    const keys = userId ? [`user:${userId}`, `ip:${ip}`] : [`ip:${ip}`];
    for (const key of keys) {
      const { success } = await limiter.limit({ key });
      if (!success) {
        c.header("Retry-After", String(RATE_LIMIT_PERIOD_SECONDS));
        return c.json({ error: "rate limit exceeded" }, 429);
      }
    }
    return next();
  };
}

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// --- Security headers (CSP + hardening) ------------------------------------
// Stamp the shared CSP + hardening headers onto every response. Registered
// FIRST so it wraps all routes (health, auth, REST, SSE). It runs the handler
// (`await next()`) then mutates the existing response `Headers` in place — it
// does NOT re-wrap the body, so the SSE `text/event-stream` stream is
// preserved and CORS headers set downstream are left untouched. WebSocket
// upgrades (the `/runs/:id/doc` collab handshake, 101 + `webSocket` handle) are
// skipped so the handle is never dropped. Shared constant lives in
// src/http/security-headers.ts (in sync with web/lib/security-headers.ts).
app.use("*", async (c, next) => {
  await next();
  if (c.res && !isWebSocketUpgrade(c.res)) {
    applySecurityHeaders(c.res.headers);
  }
});

app.get("/health", (c) => c.json({ status: "ok" }));

// --- Bot / crawler hygiene ---------------------------------------------------
// Internal tool on a public workers.dev URL: tell crawlers to go away and 403
// the well-known ones that show up anyway. /robots.txt is registered BEFORE
// both the crawler block (bots must be able to read the disallow) and
// requireAuth (it must be publicly fetchable). See src/http/bot-guard.ts.
app.get("/robots.txt", (c) => c.text(ROBOTS_TXT));
app.use("*", blockKnownCrawlers);

// Gate everything below: REST via the Supabase Bearer token, SSE / collab via
// `?ticket`. /health (+ /robots.txt) are registered above; OPTIONS preflight is
// exempted inside requireAuth.
app.use("*", requireAuth);

// Issue a short-lived SSE ticket to the authenticated user (cookie-protected by
// requireAuth above). The browser passes it on the cross-origin SSE URL.
app.get("/api/auth-ticket", async (c) => {
  // requireAuth binds `userId` on every authenticated branch, but the
  // AUTH_DISABLED bypass (and any future bypass) leaves it unset. Never mint a
  // ticket for an absent identity — otherwise we'd hand out a valid
  // `undefined.<exp>.<sig>` ticket that the SSE/collab layer would accept.
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const ticket = await mintTicket(c.env, userId);
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
// mounts. The `runs` router gates its own mutating routes internally; these
// cover the routers that take only Bindings (no AuthVars in their generic), so
// gating at the mount keeps their typing intact. Read-only routes are
// intentionally NOT listed — the requireAuth gate above already enforces an
// authenticated (viewer) session for them.

// prompts: edit (PUT) + revert (POST) → admin (config change). preview (POST) is
// a pure render of a candidate template, no persistence → author (a content
// authoring action under the 4-role capability map).
app.put("/prompts/templates/:id", requireRole("admin"));
app.post("/prompts/templates/:id/revert", requireRole("admin"));
app.post("/prompts/templates/:id/preview", requireRole("author"));

// personas: create / duplicate / edit / archive / restore → admin (config change).
app.post("/personas", requireRole("admin"));
app.post("/personas/:slug/duplicate", requireRole("admin"));
app.put("/personas/:slug", requireRole("admin"));
app.post("/personas/:slug/archive", requireRole("admin"));
app.post("/personas/:slug/restore", requireRole("admin"));

// source-policy: edit (PUT) + revert (POST) → admin (config change).
// preview (POST) → author (a content authoring action).
app.put("/source-policy", requireRole("admin"));
app.post("/source-policy/revert", requireRole("admin"));
app.post("/source-policy/preview", requireRole("author"));

// publish-targets: CRUD → admin (CMS-destination config). The readiness probe
// reveals which credential secrets are provisioned, so it is admin-only too.
// GET / and GET /:id/usage stay readable (they power the voice-editor dropdown).
app.post("/publish-targets", requireRole("admin"));
app.patch("/publish-targets/:id", requireRole("admin"));
app.post("/publish-targets/:id/archive", requireRole("admin"));
app.post("/publish-targets/:id/restore", requireRole("admin"));
app.get("/publish-targets/:id/readiness", requireRole("admin"));

// topic-batches: create batch + promote topics → author (create_run /
// promote_topics). skip a candidate + close a batch are editorial authoring
// mutations → author. DELETE batch → admin.
app.post("/topic-batches", requireRole("author"));
app.post("/topic-batches/:id/promote", requireRole("author"));
app.post("/topic-batches/:id/candidates/:cid/skip", requireRole("author"));
app.post("/topic-batches/:id/close", requireRole("author"));
app.delete("/topic-batches/:id", requireRole("admin"));

// refresh: kick a re-audit scan (existing post) → author (content authoring).
app.post("/refresh/scan", requireRole("author"));
app.post("/refresh/scan/:articleId", requireRole("author"));

// --- Rate limiting (abuse prevention) --------------------------------------
// Throttle the expensive / mutating endpoints. Registered AFTER requireAuth (so
// `userId` is bound → per-user keying) and BEFORE the router mounts below, so
// the limiter runs ahead of the heavy handler. Scoped to the exact POST paths —
// SSE (`/runs/:id/events`), the collab WS (`/runs/:id/doc`), and all GET reads
// are intentionally untouched. The minimum mandated coverage is run creation +
// resume (publish), plus apply-edits and topic-batch creation.
const mutationLimiter = makeRateLimitMiddleware("RATE_LIMITER_MUTATION");
app.post("/runs", mutationLimiter); // create a run (refresh / create / Front III)
app.post("/runs/:id/resume", mutationLimiter); // HITL resume → publish at HITL_2
app.post("/runs/:id/apply-edits", mutationLimiter); // stateless AI edit pass
app.post("/topic-batches", mutationLimiter); // Front II topic expansion fan-out

// Proof #1 — Postgres (Supabase) reachable from a Worker over TCP sockets.
// Admin-only: the response enumerates content_tool table names + Postgres
// version, so it stays behind requireRole("admin") (not just any viewer).
app.get("/db/ping", requireRole("admin"), async (c) => {
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
app.route("/publish-targets", publishTargetsRouter);
app.route("/prompts", promptsRouter);
app.route("/source-policy", sourcePolicyRouter);
app.route("/articles", articlesRouter);
app.route("/costs", costsRouter);
app.route("/wp-options", wpOptionsRouter);
app.route("/ghost-options", ghostOptionsRouter);
// Media upload writes to the CMS media library → author+.
app.post("/media/upload", requireRole("author"));
app.route("/media", mediaRouter);
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
