/**
 * GET /me returns the session email + EFFECTIVE role. The handler in index.ts
 * delegates to loadRole; this test reproduces that exact handler against the
 * mocked DB so the effective-role resolution (incl. bootstrap override) is
 * covered without importing the full Worker entrypoint (which pulls in DO /
 * Workflow bindings).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state: { storedRole: string | null } = { storedRole: "viewer" };

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray): unknown => {
    const text = strings.join(" ").toLowerCase();
    if (text.includes("select role")) return [{ role: state.storedRole }];
    return [];
  };
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return sql;
}

vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(makeFakeSql()),
}));

import { Hono } from "hono";
import { loadRole } from "../auth/authz";
import type { AuthVars } from "../auth/middleware";
import type { Env } from "../index";

type MeApp = Hono<{ Bindings: Env; Variables: AuthVars }>;

function appWith(authEmail: string | null): MeApp {
  const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    if (authEmail !== null) c.set("userEmail", authEmail);
    await next();
  });
  // Same handler as index.ts GET /me.
  app.get("/me", async (c) => {
    const role = await loadRole(c);
    if (role === null) return c.json({ error: "unauthorized" }, 401);
    return c.json({ email: c.get("userEmail") ?? null, role });
  });
  return app;
}

async function get(app: MeApp, bootstrap: string): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return app.request(
    "/me",
    { method: "GET" },
    { AUTH_DISABLED: "false", BOOTSTRAP_ADMIN_EMAILS: bootstrap } as unknown as Env,
    executionCtx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  state.storedRole = "viewer";
});

describe("GET /me", () => {
  it("returns the stored effective role", async () => {
    state.storedRole = "editor";
    const res = await get(appWith("user@b.com"), "");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ email: "user@b.com", role: "editor" });
  });

  it("applies the bootstrap admin override", async () => {
    state.storedRole = "viewer";
    const res = await get(appWith("boss@b.com"), "boss@b.com");
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.role).toBe("admin");
  });

  it("returns 401 when there is no session identity", async () => {
    const res = await get(appWith(null), "");
    expect(res.status).toBe(401);
  });
});
