/**
 * FIX M4 — `/db/ping` is admin-only.
 *
 * The diagnostic enumerates content_tool table names + the Postgres version, so
 * it must sit behind requireRole("admin"), not merely an authenticated viewer.
 *
 * Importing the top-level `app` from ./index transitively loads the Workflow
 * entrypoints (`cloudflare:workers`), which isn't available in the node test
 * pool. So this exercises the REAL `requireRole("admin")` middleware from
 * ./auth/authz against a Hono app registering `/db/ping` exactly as index.ts
 * does (gate, then a handler that would touch the DB). It verifies:
 *   - viewer session → 403 (gate blocks before the handler runs)
 *   - admin session  → past the gate (handler runs)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const roleState: { role: string | null } = { role: "viewer" };

// loadRole() goes through withDb → return the stored role for the session user.
vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(() => [{ role: roleState.role }]),
}));
// authz.ts imports withDb from "./db/client" relative to itself (src/auth/).
vi.mock("./db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(() => [{ role: roleState.role }]),
}));

import { Hono } from "hono";
import { requireRole } from "./auth/authz";
import type { AuthVars } from "./auth/middleware";

type AuthApp = Hono<{ Variables: AuthVars }>;

/** Mirror the index.ts registration: requireRole("admin") then the handler. */
function appWith(email: string): AuthApp {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("userEmail", email);
    await next();
  });
  app.get("/db/ping", requireRole("admin"), (c) => c.json({ ok: true, handler: true }));
  return app;
}

function makeEnv(): Record<string, unknown> {
  return { AUTH_DISABLED: "false", BOOTSTRAP_ADMIN_EMAILS: "" };
}

async function ping(app: AuthApp): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return app.request(
    "/db/ping",
    { method: "GET" },
    makeEnv(),
    executionCtx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  roleState.role = "viewer";
});

describe("GET /db/ping (FIX M4 — admin-only)", () => {
  it("returns 403 for an authenticated viewer", async () => {
    roleState.role = "viewer";
    const res = await ping(appWith("viewer@bowtie.com.hk"));
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("forbidden");
    expect(json.required_role).toBe("admin");
  });

  it("admits an admin past the gate to the handler", async () => {
    roleState.role = "admin";
    const res = await ping(appWith("admin@bowtie.com.hk"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.handler).toBe(true);
  });
});
