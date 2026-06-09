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

interface AppUserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: string | null;
  status: string | null;
  last_sign_in_at: string | null;
}

const state: { actorRole: string | null; target: UserRow | null; appUser: AppUserRow | null } = {
  actorRole: "admin",
  target: null,
  appUser: null,
};

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]): unknown => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    const lastStr = _values.find((v) => typeof v === "string") as string | undefined;

    // --- Supabase provider: content_tool.app_user ---
    if (text.includes("app_user")) {
      if (text.startsWith("insert")) {
        // POST /users create — bound order: id, email, role.
        const strs = _values.filter((v) => typeof v === "string") as string[];
        state.appUser = {
          id: strs[0] ?? "new",
          email: strs[1] ?? "x@b.com",
          display_name: null,
          role: strs[2] ?? "viewer",
          status: "active",
          last_sign_in_at: null,
        };
        return [state.appUser];
      }
      if (text.startsWith("select")) {
        return state.appUser === null ? [] : [state.appUser];
      }
      if (text.startsWith("update")) {
        if (state.appUser === null) return [];
        // role updates bind role; status updates bind status — pick the bound str.
        if (text.includes("set role")) {
          state.appUser = { ...state.appUser, role: lastStr ?? state.appUser.role };
        } else if (text.includes("set status")) {
          state.appUser = { ...state.appUser, status: lastStr ?? state.appUser.status };
        }
        return [state.appUser];
      }
      if (text.startsWith("delete")) {
        state.appUser = null;
        return [];
      }
      return [];
    }

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
      state.target = { ...state.target, role: lastStr ?? state.target.role };
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

// Mock the GoTrue admin wrapper so no network call is made. Each fn records its
// call so the route tests can assert the right admin operation was invoked.
const gotrue = {
  inviteUser: vi.fn(),
  createUser: vi.fn(),
  generateLink: vi.fn(),
  deleteUser: vi.fn(),
  updateUser: vi.fn(),
  signOutUser: vi.fn(),
  listUsers: vi.fn(),
};
vi.mock("../auth/gotrue-admin", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    inviteUser: (...a: unknown[]) => gotrue.inviteUser(...a),
    createUser: (...a: unknown[]) => gotrue.createUser(...a),
    generateLink: (...a: unknown[]) => gotrue.generateLink(...a),
    deleteUser: (...a: unknown[]) => gotrue.deleteUser(...a),
    updateUser: (...a: unknown[]) => gotrue.updateUser(...a),
    signOutUser: (...a: unknown[]) => gotrue.signOutUser(...a),
    listUsers: (...a: unknown[]) => gotrue.listUsers(...a),
  };
});

// Spy on the audit logger so mutation routes can be asserted to audit. We keep
// the real implementation (no console noise: it stringifies) and just record.
const auditCalls: Array<{ event: string; fields: Record<string, unknown> }> = [];
vi.mock("../auth/audit", () => ({
  auditLog: (event: string, fields: Record<string, unknown>) => {
    auditCalls.push({ event, fields });
  },
}));

import { Hono } from "hono";
import { adminRouter } from "./admin";
import { requireRole } from "../auth/authz";
import type { AuthVars } from "../auth/middleware";

type AuthApp = Hono<{ Bindings: Record<string, unknown>; Variables: AuthVars }>;

/** Mirror index.ts: gate /admin/* with requireRole("admin"), then mount. */
function appWith(authEmail: string, authUserId?: string): AuthApp {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("userEmail", authEmail);
    if (authUserId !== undefined) c.set("userId", authUserId);
    await next();
  });
  app.use("/admin/*", requireRole("admin"));
  app.route("/admin", adminRouter);
  return app;
}

function env(): Record<string, unknown> {
  return { AUTH_DISABLED: "false", BOOTSTRAP_ADMIN_EMAILS: "" };
}

/** Supabase-provider env: routes the user store to app_user + enables GoTrue. */
function supabaseEnv(): Record<string, unknown> {
  return {
    AUTH_DISABLED: "false",
    BOOTSTRAP_ADMIN_EMAILS: "",
    AUTH_PROVIDER: "supabase",
    SUPABASE_URL: "https://proj.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  };
}

async function req(
  app: AuthApp,
  method: string,
  path: string,
  body: unknown,
  envObj: Record<string, unknown> = env(),
): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return app.request(
    path,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    envObj,
    executionCtx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  state.actorRole = "admin";
  state.target = { id: "u1", email: "target@b.com", name: "Target", role: "viewer" };
  state.appUser = {
    id: "u1",
    email: "target@b.com",
    display_name: "Target",
    role: "viewer",
    status: "active",
    last_sign_in_at: null,
  };
  auditCalls.length = 0;
  for (const fn of Object.values(gotrue)) fn.mockReset();
});

describe("PUT /admin/users/:id/role", () => {
  it("rejects a non-admin actor with 403", async () => {
    state.actorRole = "reviewer";
    const res = await req(appWith("reviewer@b.com"), "PUT", "/admin/users/u1/role", {
      role: "reviewer",
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

  it("rejects the legacy 'editor' token (not assignable in the 4-role model) with 400", async () => {
    const res = await req(appWith("admin@b.com"), "PUT", "/admin/users/u1/role", {
      role: "editor",
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
      role: "reviewer",
    });
    expect(res.status).toBe(404);
  });

  it("rejects an admin demoting THEIR OWN role to a non-admin role with 409 (M2)", async () => {
    state.actorRole = "admin";
    state.target = { id: "self1", email: "admin@b.com", name: "Me", role: "admin" };
    const res = await req(
      appWith("admin@b.com", "self1"),
      "PUT",
      "/admin/users/self1/role",
      { role: "viewer" },
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("self_demotion_forbidden");
    // The role must NOT have changed.
    expect(state.target.role).toBe("admin");
  });

  it("allows an admin to change a DIFFERENT user's role to viewer (M2 does not over-block)", async () => {
    state.actorRole = "admin";
    state.target = { id: "u2", email: "other@b.com", name: "Other", role: "admin" };
    const res = await req(
      appWith("admin@b.com", "self1"),
      "PUT",
      "/admin/users/u2/role",
      { role: "viewer" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.role).toBe("viewer");
  });

  it("allows an admin to keep their OWN role as admin (no-op self update)", async () => {
    state.actorRole = "admin";
    state.target = { id: "self1", email: "admin@b.com", name: "Me", role: "admin" };
    const res = await req(
      appWith("admin@b.com", "self1"),
      "PUT",
      "/admin/users/self1/role",
      { role: "admin" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.role).toBe("admin");
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
    state.actorRole = "reviewer";
    const res = await req(appWith("reviewer@b.com"), "GET", "/admin/users", undefined);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Supabase-provider surface (AUTH_PROVIDER=supabase). GoTrue is mocked.
// ---------------------------------------------------------------------------
describe("Supabase provider: GET /admin/users", () => {
  it("reads app_user and enriches with GoTrue last-sign-in/confirmed", async () => {
    gotrue.listUsers.mockResolvedValue([
      { id: "u1", email: "target@b.com", last_sign_in_at: "2026-06-10T00:00:00Z", email_confirmed_at: "2026-06-09T00:00:00Z" },
    ]);
    const res = await req(appWith("admin@b.com"), "GET", "/admin/users", undefined, supabaseEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<Record<string, unknown>>;
    expect(json[0]?.status).toBe("active");
    expect(json[0]?.last_sign_in_at).toBe("2026-06-10T00:00:00Z");
    expect(json[0]?.confirmed).toBe(true);
  });

  it("still returns app_user rows when GoTrue enrichment fails", async () => {
    const { GoTrueAdminError } = await import("../auth/gotrue-admin");
    gotrue.listUsers.mockRejectedValue(new GoTrueAdminError("network_error", "down", 502));
    const res = await req(appWith("admin@b.com"), "GET", "/admin/users", undefined, supabaseEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<Record<string, unknown>>;
    expect(json[0]?.confirmed).toBe(false);
  });
});

describe("Supabase provider: POST /admin/users (create + invite)", () => {
  it("invites + inserts app_user, audits, returns 201", async () => {
    gotrue.inviteUser.mockResolvedValue({ id: "new1", email: "new@b.com" });
    const res = await req(appWith("admin@b.com", "self1"), "POST", "/admin/users", {
      email: "new@b.com",
      role: "author",
    }, supabaseEnv());
    expect(res.status).toBe(201);
    expect(gotrue.inviteUser).toHaveBeenCalledOnce();
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.role).toBe("author");
    expect(auditCalls.some((a) => a.event === "rbac.user_create")).toBe(true);
  });

  it("rejects an invalid role with 400 (no GoTrue call)", async () => {
    const res = await req(appWith("admin@b.com"), "POST", "/admin/users", {
      email: "new@b.com",
      role: "superuser",
    }, supabaseEnv());
    expect(res.status).toBe(400);
    expect(gotrue.inviteUser).not.toHaveBeenCalled();
  });

  it("rejects a missing email with 400", async () => {
    const res = await req(appWith("admin@b.com"), "POST", "/admin/users", {}, supabaseEnv());
    expect(res.status).toBe(400);
  });

  it("returns 501 on the better-auth provider", async () => {
    const res = await req(appWith("admin@b.com"), "POST", "/admin/users", { email: "x@b.com" });
    expect(res.status).toBe(501);
  });
});

describe("Supabase provider: PUT role writes to app_user", () => {
  it("updates app_user role and audits", async () => {
    const res = await req(appWith("admin@b.com"), "PUT", "/admin/users/u1/role", {
      role: "reviewer",
    }, supabaseEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.role).toBe("reviewer");
    expect(auditCalls.some((a) => a.event === "rbac.role_change")).toBe(true);
  });

  it("keeps the self-demotion guard (409) on the supabase path", async () => {
    state.appUser = {
      id: "self1",
      email: "admin@b.com",
      display_name: "Me",
      role: "admin",
      status: "active",
      last_sign_in_at: null,
    };
    const res = await req(appWith("admin@b.com", "self1"), "PUT", "/admin/users/self1/role", {
      role: "viewer",
    }, supabaseEnv());
    expect(res.status).toBe(409);
  });
});

describe("Supabase provider: disable / enable", () => {
  it("disable bans in GoTrue + sets status disabled + audits", async () => {
    gotrue.updateUser.mockResolvedValue({ id: "u1" });
    const res = await req(appWith("admin@b.com"), "POST", "/admin/users/u1/disable", {}, supabaseEnv());
    expect(res.status).toBe(200);
    expect(gotrue.updateUser).toHaveBeenCalledOnce();
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("disabled");
    expect(auditCalls.some((a) => a.event === "rbac.user_disable")).toBe(true);
  });

  it("enable unbans + sets status active", async () => {
    gotrue.updateUser.mockResolvedValue({ id: "u1" });
    const res = await req(appWith("admin@b.com"), "POST", "/admin/users/u1/enable", {}, supabaseEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("active");
    expect(auditCalls.some((a) => a.event === "rbac.user_enable")).toBe(true);
  });

  it("404 when the target app_user is absent", async () => {
    state.appUser = null;
    const res = await req(appWith("admin@b.com"), "POST", "/admin/users/ghost/disable", {}, supabaseEnv());
    expect(res.status).toBe(404);
    expect(gotrue.updateUser).not.toHaveBeenCalled();
  });

  it("501 on the better-auth provider", async () => {
    const res = await req(appWith("admin@b.com"), "POST", "/admin/users/u1/disable", {});
    expect(res.status).toBe(501);
  });
});

describe("Supabase provider: DELETE", () => {
  it("deletes GoTrue user + app_user row + audits, returns 204", async () => {
    gotrue.deleteUser.mockResolvedValue(undefined);
    const res = await req(appWith("admin@b.com", "self1"), "DELETE", "/admin/users/u1", undefined, supabaseEnv());
    expect(res.status).toBe(204);
    expect(gotrue.deleteUser).toHaveBeenCalledOnce();
    expect(auditCalls.some((a) => a.event === "rbac.user_delete")).toBe(true);
  });

  it("blocks self-delete with 409", async () => {
    state.appUser = {
      id: "self1",
      email: "admin@b.com",
      display_name: "Me",
      role: "admin",
      status: "active",
      last_sign_in_at: null,
    };
    const res = await req(appWith("admin@b.com", "self1"), "DELETE", "/admin/users/self1", undefined, supabaseEnv());
    expect(res.status).toBe(409);
    expect(gotrue.deleteUser).not.toHaveBeenCalled();
  });
});

describe("Supabase provider: resend-invite + revoke-sessions", () => {
  it("resend-invite calls generateLink + audits", async () => {
    gotrue.generateLink.mockResolvedValue({ action_link: "https://x", verification_type: "invite" });
    const res = await req(appWith("admin@b.com"), "POST", "/admin/users/u1/resend-invite", {}, supabaseEnv());
    expect(res.status).toBe(200);
    expect(gotrue.generateLink).toHaveBeenCalledOnce();
    expect(auditCalls.some((a) => a.event === "rbac.user_resend_invite")).toBe(true);
  });

  it("revoke-sessions calls signOutUser + audits", async () => {
    gotrue.signOutUser.mockResolvedValue(undefined);
    const res = await req(appWith("admin@b.com"), "POST", "/admin/users/u1/revoke-sessions", {}, supabaseEnv());
    expect(res.status).toBe(200);
    expect(gotrue.signOutUser).toHaveBeenCalledOnce();
    expect(auditCalls.some((a) => a.event === "rbac.user_revoke_sessions")).toBe(true);
  });

  it("revoke-sessions is admin-gated (403 for reviewer)", async () => {
    state.actorRole = "reviewer";
    const res = await req(appWith("reviewer@b.com"), "POST", "/admin/users/u1/revoke-sessions", {}, supabaseEnv());
    expect(res.status).toBe(403);
    expect(gotrue.signOutUser).not.toHaveBeenCalled();
  });
});
