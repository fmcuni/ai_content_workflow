/**
 * RBAC tests exercising the real Hono handlers against a stateful fake `sql`
 * (vi.mock on ../db/client), mirroring the pattern in
 * runs_hitl_concurrency.test.ts.
 *
 * Three-role model (viewer < editor < admin), NO segregation of duties: an
 * editor may approve and publish their OWN run.
 *
 * Coverage:
 *   - requireRole: below-bar → 403, at/above-bar → proceeds
 *   - DELETE /runs/:id (admin gate): editor 403, admin 200
 *   - create / HITL approve / publish require editor; viewer blocked
 *   - an editor may approve + publish a run they created (no self-approval bar)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Stateful fake DB. `userRole` drives loadRole; `run` drives the run handlers.
// ---------------------------------------------------------------------------
interface RunRow {
  run_id: string;
  status: string;
  hitl_2_iteration: number;
  created_by: string | null;
}

const state: {
  userRole: string | null;
  run: RunRow | null;
  deleted: boolean;
} = { userRole: "viewer", run: null, deleted: false };

interface Fragment {
  __frag: true;
  text: string;
}
function isFragment(v: unknown): v is Fragment {
  return typeof v === "object" && v !== null && "__frag" in v;
}
function renderText(strings: TemplateStringsArray, values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    if (isFragment(values[i])) out += (values[i] as Fragment).text;
    out += strings[i + 1] ?? "";
  }
  return out.replace(/\s+/g, " ").trim();
}

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = renderText(strings, values);
    const lower = text.toLowerCase();

    // Nested fragment (capGuard / newIteration) — no leading verb.
    if (!/^\s*(select|update|insert|delete)\b/.test(lower)) {
      return { __frag: true, text } as Fragment;
    }

    if (lower.startsWith("select")) {
      // loadRole: role lookup on the user table.
      if (lower.includes('from content_tool."user"')) {
        return [{ role: state.userRole }];
      }
      // SoD: created_by on the run.
      if (lower.includes("select created_by from content_tool.runs")) {
        return state.run === null ? [] : [{ created_by: state.run.created_by }];
      }
      // hitl-2 state read.
      if (lower.includes("select status, hitl_2_iteration")) {
        return state.run === null
          ? []
          : [{ status: state.run.status, hitl_2_iteration: state.run.hitl_2_iteration }];
      }
      // resume (HITL_1) gate read — SELECT status FROM content_tool.runs.
      if (lower.includes("select status from content_tool.runs")) {
        return state.run === null ? [] : [{ status: state.run.status }];
      }
      // DELETE existence pre-check (SELECT run_id ...).
      if (lower.includes("select run_id from content_tool.runs")) {
        return state.run === null ? [] : [{ run_id: state.run.run_id }];
      }
      return [];
    }

    if (lower.startsWith("update") && state.run !== null) {
      // hitl-2 decision UPDATE — claim the gate (status moves off hitl_2).
      if (lower.includes("hitl_2_decision")) {
        if (state.run.status !== "hitl_2") return { count: 0 };
        state.run.status = "publishing";
        return { count: 1 };
      }
      // resume (HITL_1) decision UPDATE — claim the gate (status moves off hitl_1).
      if (lower.includes("hitl_1_decision")) {
        if (state.run.status !== "hitl_1") return { count: 0 };
        state.run.status = "production";
        return { count: 1 };
      }
      return { count: 0 };
    }

    if (lower.startsWith("delete")) {
      state.deleted = true;
      return { count: 1 };
    }

    return { count: 0 };
  };
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({
    __frag: true,
    text: JSON.stringify(v),
  });
  return sql;
}

vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(makeFakeSql()),
}));
vi.mock("../gemini/do_client", () => ({ DoGeminiClient: class {} }));

import { Hono } from "hono";
import runsRouter from "./runs";
import type { AuthVars } from "../auth/middleware";

type AuthApp = Hono<{ Variables: AuthVars }>;

function appWith(authEmail: string): AuthApp {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("userEmail", authEmail);
    await next();
  });
  app.route("/", runsRouter);
  return app;
}

function makeEnv(): Record<string, unknown> {
  const instance = { sendEvent: async () => undefined, restart: async () => undefined };
  return {
    AUTH_DISABLED: "false",
    PRODUCTION: { get: async () => instance, create: async () => undefined },
    FRONTEND_ORIGIN: "https://example.test",
    BOOTSTRAP_ADMIN_EMAILS: "",
  };
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
    makeEnv(),
    executionCtx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  state.userRole = "viewer";
  state.run = null;
  state.deleted = false;
});

// ---------------------------------------------------------------------------
// requireRole gate — DELETE /runs/:id requires admin.
// ---------------------------------------------------------------------------
describe("requireRole gate (DELETE /runs/:id → admin)", () => {
  it("returns 403 for a below-bar role (editor) with the flat error body", async () => {
    state.userRole = "editor";
    state.run = { run_id: "r1", status: "published", hitl_2_iteration: 0, created_by: "x@b.com" };
    const res = await req(appWith("editor@b.com"), "DELETE", "/r1", {});
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("forbidden");
    expect(json.required_role).toBe("admin");
    expect(json.message).toBe("requires admin role");
    expect(state.deleted).toBe(false);
  });

  it("proceeds at/above the bar (admin) and performs the delete", async () => {
    state.userRole = "admin";
    state.run = { run_id: "r1", status: "published", hitl_2_iteration: 0, created_by: "x@b.com" };
    const res = await req(appWith("admin@b.com"), "DELETE", "/r1", {});
    expect(res.status).toBe(200);
    expect(state.deleted).toBe(true);
  });
});

describe("requireRole gate (POST /runs → editor)", () => {
  it("returns 403 for a viewer", async () => {
    state.userRole = "viewer";
    const res = await req(appWith("viewer@b.com"), "POST", "/", {
      start_mode: "create",
      topic: "t",
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// HITL_2 approve — editor capability, NO segregation of duties.
// ---------------------------------------------------------------------------
describe("HITL_2 approve (editor, no SoD)", () => {
  it("returns 403 for a viewer", async () => {
    state.userRole = "viewer";
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("viewer@b.com"), "POST", "/r1/hitl-2", { decision: "approve" });
    expect(res.status).toBe(403);
    expect(state.run.status).toBe("hitl_2");
  });

  it("lets an editor approve a run created by someone else", async () => {
    state.userRole = "editor";
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "other@b.com" };
    const res = await req(appWith("editor@b.com"), "POST", "/r1/hitl-2", { decision: "approve" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sod_override).toBeUndefined();
  });

  it("lets an editor approve their OWN run (no self-approval bar)", async () => {
    state.userRole = "editor";
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "editor@b.com" };
    const res = await req(appWith("editor@b.com"), "POST", "/r1/hitl-2", { decision: "approve" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(state.run.status).toBe("publishing");
  });
});

// ---------------------------------------------------------------------------
// HITL_1 resume approve — editor capability, NO segregation of duties.
// ---------------------------------------------------------------------------
describe("HITL_1 resume approve (editor, no SoD)", () => {
  it("returns 403 for a viewer", async () => {
    state.userRole = "viewer";
    state.run = { run_id: "r1", status: "hitl_1", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("viewer@b.com"), "POST", "/r1/resume", { decision: "approve" });
    expect(res.status).toBe(403);
    expect(state.run.status).toBe("hitl_1");
  });

  it("lets an editor approve their OWN run's source selection", async () => {
    state.userRole = "editor";
    state.run = { run_id: "r1", status: "hitl_1", hitl_2_iteration: 0, created_by: "editor@b.com" };
    const res = await req(appWith("editor@b.com"), "POST", "/r1/resume", { decision: "approve" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sod_override).toBeUndefined();
    expect(state.run.status).toBe("production");
  });
});

// ---------------------------------------------------------------------------
// dry-publish requires the editor (publish-adjacent) capability.
// ---------------------------------------------------------------------------
describe("requireRole gate (POST /runs/:id/dry-publish → editor)", () => {
  it("returns 403 for a viewer", async () => {
    state.userRole = "viewer";
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("viewer@b.com"), "POST", "/r1/dry-publish", {});
    expect(res.status).toBe(403);
  });

  it("lets an editor past the gate (handler then runs DB logic — not a 403)", async () => {
    state.userRole = "editor";
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("editor@b.com"), "POST", "/r1/dry-publish", {});
    // The fake DB doesn't model the dry-publish run SELECT, so the handler reaches
    // its own "run not found" 404. The point is the requireRole gate PASSED — the
    // response is NOT a 403.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// republish — editor capability, NO segregation of duties. An editor may
// publish their OWN run.
// ---------------------------------------------------------------------------
describe("requireRole gate (POST /runs/:id/republish → editor)", () => {
  it("returns 403 for a viewer", async () => {
    state.userRole = "viewer";
    state.run = { run_id: "r1", status: "published", hitl_2_iteration: 0, created_by: "editor@b.com" };
    const res = await req(appWith("viewer@b.com"), "POST", "/r1/republish", {});
    expect(res.status).toBe(403);
  });

  it("lets an editor past the gate for their OWN run (no self-publish bar)", async () => {
    state.userRole = "editor";
    state.run = { run_id: "r1", status: "published", hitl_2_iteration: 0, created_by: "editor@b.com" };
    const res = await req(appWith("editor@b.com"), "POST", "/r1/republish", {});
    // The fake DB doesn't model the republish run SELECT, so the handler reaches
    // its own 404. The point is neither the requireRole gate NOR any SoD bar
    // returns 403.
    expect(res.status).not.toBe(403);
  });
});
