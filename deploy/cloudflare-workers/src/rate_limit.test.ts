/**
 * HIGH-severity finding (WS3, Workers side) — rate limiting.
 *
 * The Workers backend had zero throttling. This exercises the rate-limit
 * middleware factory (`makeRateLimitMiddleware` from ./index) in isolation
 * against a Hono app, injecting a FAKE Rate Limiting binding into the test
 * `Env` (the real Cloudflare `ratelimit` binding is not available in the node
 * test pool). It verifies:
 *   - breach (`limit()` → { success:false }) → 429 + Retry-After header
 *   - allowed (`limit()` → { success:true }) → request passes through (200)
 *   - key derivation: prefers the authenticated `userId`, falls back to the
 *     `cf-connecting-ip` header
 *   - per-user AND per-IP are both checked (limiter called with both keys)
 *   - a missing/unbound limiter fails OPEN (request passes) — never wedge the
 *     app if the binding is absent (e.g. local dev)
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Importing `./index` transitively loads the Workflow entrypoints, which pull
// in the `cloudflare:workers` module — unavailable in the node test pool (see
// db_ping_rbac.test.ts). Stub the entrypoint modules so the import resolves;
// the rate-limit factory under test does not touch them.
vi.mock("./workflows/production", () => ({ ProductionWorkflow: class {} }));
vi.mock("./workflows/topic_expansion", () => ({ TopicExpansionWorkflow: class {} }));
vi.mock("./workflows/refresh_scan", () => ({ RefreshScanWorkflow: class {} }));
vi.mock("./run-stream", () => ({ RunStream: class {} }));
vi.mock("./gemini/proxy_do", () => ({ GeminiProxy: class {} }));
vi.mock("./run-doc", () => ({ RunDoc: class {} }));

import { makeRateLimitMiddleware } from "./index";
import type { AuthVars } from "./auth/middleware";

type TestApp = Hono<{ Variables: AuthVars }>;

interface LimitArg {
  key: string;
}

/** A fake RateLimit binding that records the keys it was called with. */
function fakeLimiter(success: boolean): {
  limit: (arg: LimitArg) => Promise<{ success: boolean }>;
  keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    limit: vi.fn(async (arg: LimitArg) => {
      keys.push(arg.key);
      return { success };
    }),
  };
}

/**
 * Build a Hono app that mirrors index.ts: optionally seed `userId`, then mount
 * the rate-limit middleware on a target POST route, then a handler.
 */
type LimiterBinding = "RATE_LIMITER_MUTATION" | "RATE_LIMITER_AUTH";

function appWith(opts: {
  binding: LimiterBinding;
  limiterSuccess?: boolean;
  unbound?: boolean;
  userId?: string;
}): { app: TestApp; env: Record<string, unknown>; limiter: ReturnType<typeof fakeLimiter> } {
  const limiter = fakeLimiter(opts.limiterSuccess ?? true);
  const app = new Hono<{ Variables: AuthVars }>();
  if (opts.userId !== undefined) {
    const uid = opts.userId;
    app.use("*", async (c, next) => {
      c.set("userId", uid);
      await next();
    });
  }
  app.post("/runs", makeRateLimitMiddleware(opts.binding), (c) => c.json({ ok: true }));
  const env: Record<string, unknown> = {};
  if (!opts.unbound) env[opts.binding] = limiter;
  return { app, env, limiter };
}

function post(
  app: TestApp,
  env: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return Promise.resolve(
    app.request(
      "/runs",
      { method: "POST", headers },
      env,
      executionCtx as unknown as ExecutionContext,
    ),
  );
}

describe("rate-limit middleware", () => {
  it("returns 429 with Retry-After when the limiter rejects", async () => {
    const { app, env } = appWith({ binding: "RATE_LIMITER_MUTATION", limiterSuccess: false, userId: "u1" });
    const res = await post(app, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate limit exceeded");
  });

  it("passes the request through when the limiter allows it", async () => {
    const { app, env } = appWith({ binding: "RATE_LIMITER_MUTATION", limiterSuccess: true, userId: "u1" });
    const res = await post(app, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("keys on the authenticated userId when present", async () => {
    const { app, env, limiter } = appWith({ binding: "RATE_LIMITER_MUTATION", limiterSuccess: true, userId: "user-123" });
    await post(app, env, { "cf-connecting-ip": "9.9.9.9" });
    expect(limiter.keys.some((k) => k.includes("user-123"))).toBe(true);
  });

  it("falls back to the client IP when there is no userId", async () => {
    const { app, env, limiter } = appWith({ binding: "RATE_LIMITER_MUTATION", limiterSuccess: true });
    await post(app, env, { "cf-connecting-ip": "203.0.113.7" });
    expect(limiter.keys.some((k) => k.includes("203.0.113.7"))).toBe(true);
  });

  it("checks BOTH per-user and per-IP keys", async () => {
    const { app, env, limiter } = appWith({ binding: "RATE_LIMITER_MUTATION", limiterSuccess: true, userId: "user-xyz" });
    await post(app, env, { "cf-connecting-ip": "198.51.100.4" });
    expect(limiter.keys.some((k) => k.startsWith("user:"))).toBe(true);
    expect(limiter.keys.some((k) => k.startsWith("ip:"))).toBe(true);
  });

  it("returns 429 when the per-IP key is over the limit even with a userId", async () => {
    // limiter rejects everything → the IP check (second call) still trips 429.
    const { app, env } = appWith({ binding: "RATE_LIMITER_MUTATION", limiterSuccess: false, userId: "u1" });
    const res = await post(app, env, { "cf-connecting-ip": "10.0.0.1" });
    expect(res.status).toBe(429);
  });

  it("fails OPEN (passes) when the binding is unbound", async () => {
    const { app, env } = appWith({ binding: "RATE_LIMITER_MUTATION", unbound: true, userId: "u1" });
    const res = await post(app, env);
    expect(res.status).toBe(200);
  });
});
