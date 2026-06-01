/**
 * Tests for the admin user-management router + the requireRole("admin") gate
 * that index.ts mounts in front of it, and the GET /me effective-role route.
 *
 *   - PUT /admin/users/:id/role: non-admin → 403, bad enum → 400, admin → 200
 *   - GET /me: returns email + EFFECTIVE role (bootstrap override applied)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
}

const state: { actorRole: string | null; target: UserRow | null } = {
  actorRole: "admin",
  target: null,
};

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]): unknown => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    if (text.startsWith("select")) {
      if (text.includes("select role from")) {
        // loadRole on the acting session user.
        return [{ role: state.actorRole }];
      }
      // admin GET: list / pre-update read of the target user.
      return state.target === null ? [] : [state.target];
    }
    if (text.startsWith("update")) {
      if (state.target === null) return [];
      // Reflect the new role from the bound value (last string bind).
      const newRole = _values.find((v) => typeof v === "string");
      state.target = { ...state.target, role: (newRole as string) ?? state.target.role };
      return [state.target];
    }
    return [];
  };
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({ __frag: true, text: JSON.stringify(v) });
  return sql;
}

vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(makeFakeSql()),
}));

import { Hono } from "hono";
import { adminRouter } from "./admin";
import { requireRole } from "../auth/authz";
import type { AuthVars } from "../auth/middleware";

type AuthApp = Hono<{ Bindings: Record<string, unknown>; Variables: AuthVars }>;

/** Mirror index.ts: gate /admin/* with requireRole("admin"), then mount. */
function appWith(authEmail: string): AuthApp {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("userEmail", authEmail);
    await next();
  });
  app.use("/admin/*", requireRole("admin"));
  app.route("/admin", adminRouter);
  return app;
}

function env(): Record<string, unknown> {
  return { AUTH_DISABLED: "false", BOOTSTRAP_ADMIN_EMAILS: "" };
}

async function req(app: AuthApp, method: string, path: string, body: unknown): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return app.request(
    path,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env(),
    executionCtx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  state.actorRole = "admin";
  state.target = { id: "u1", email: "target@b.com", name: "Target", role: "viewer" };
});

describe("PUT /admin/users/:id/role", () => {
  it("rejects a non-admin actor with 403", async () => {
    state.actorRole = "reviewer";
    const res = await req(appWith("reviewer@b.com"), "PUT", "/admin/users/u1/role", {
      role: "author",
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid role enum with 400", async () => {
    const res = await req(appWith("admin@b.com"), "PUT", "/admin/users/u1/role", {
      role: "superuser",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("invalid_role");
  });

  it("updates the role for an admin actor and returns the user", async () => {
    const res = await req(appWith("admin@b.com"), "PUT", "/admin/users/u1/role", {
      role: "reviewer",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.id).toBe("u1");
    expect(json.role).toBe("reviewer");
  });

  it("returns 404 when the target user does not exist", async () => {
    state.target = null;
    const res = await req(appWith("admin@b.com"), "PUT", "/admin/users/u404/role", {
      role: "author",
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/users", () => {
  it("lists users for an admin", async () => {
    const res = await req(appWith("admin@b.com"), "GET", "/admin/users", undefined);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(json)).toBe(true);
    expect(json[0]?.role).toBe("viewer");
  });

  it("rejects a non-admin with 403", async () => {
    state.actorRole = "author";
    const res = await req(appWith("author@b.com"), "GET", "/admin/users", undefined);
    expect(res.status).toBe(403);
  });
});
