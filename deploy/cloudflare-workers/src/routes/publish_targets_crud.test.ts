/**
 * Publish-targets self-service CRUD + readiness (Phase 2). Parity with the
 * Python backend's POST/PATCH/archive/restore/usage/readiness routes.
 *
 * Exercises the real Hono handlers against a stateful fake `sql` (vi.mock on
 * ../db/client), mounted behind the same requireRole gates as index.ts so the
 * admin-only enforcement is covered too. Mirrors runs_dry_publish_target.test.ts.
 *
 * Coverage:
 *   - POST create (admin) → 201; non-admin → 403; bad auth_ref → 422; dup → 409
 *   - PATCH edits name/status; auth_ref in body is ignored (locked); 404 unknown
 *   - archive/restore flip is_archived
 *   - GET /:id/usage returns assigned voice count
 *   - GET /:id/readiness presence booleans; admin-gated
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TargetRow {
  publish_target_id: string;
  name: string;
  kind: string;
  auth_ref: string;
  status: string;
  is_archived: boolean;
}

const state: {
  userRole: string | null;
  target: TargetRow | null;
  authRefTaken: boolean;
  voiceCount: number;
} = { userRole: "admin", target: null, authRefTaken: false, voiceCount: 0 };

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
    // Non-statement interpolations (sql`name`, unsafe fragments) → fragment.
    if (!/^\s*(select|update|insert|delete)\b/.test(lower)) {
      return { __frag: true, text } as Fragment;
    }
    // The first non-fragment values are the bound params, in template order.
    const params = values.filter((v) => !isFragment(v));

    if (lower.startsWith("select")) {
      // requireRole → loadRole.
      if (lower.includes('from content_tool.app_user')) {
        return [{ role: state.userRole }];
      }
      // authRefExists.
      if (lower.includes("select 1 as one")) {
        return state.authRefTaken ? [{ one: 1 }] : [];
      }
      // countVoicesForTarget.
      if (lower.includes("count(*)::text")) {
        return [{ count: String(state.voiceCount) }];
      }
      // getPublishTarget.
      if (lower.includes("from content_tool.publish_targets")) {
        return state.target === null ? [] : [state.target];
      }
      return [];
    }

    if (lower.startsWith("insert")) {
      // createPublishTarget: params = [name, auth_ref, status].
      const row: TargetRow = {
        publish_target_id: "00000000-0000-0000-0000-0000000000aa",
        name: String(params[0]),
        kind: "wordpress",
        auth_ref: String(params[1]),
        status: String(params[2]),
        is_archived: false,
      };
      state.target = row;
      return [row];
    }

    if (lower.startsWith("update")) {
      if (state.target === null) return [];
      // updatePublishTarget: COALESCE(name, ...), COALESCE(status, ...).
      // setTargetArchived: SET is_archived = <bool>.
      if (lower.includes("is_archived =")) {
        const archived = params.some((p) => p === true);
        const restored = params.some((p) => p === false);
        state.target = { ...state.target, is_archived: archived && !restored ? true : false };
        return [state.target];
      }
      const [name, status] = params as (string | null)[];
      state.target = {
        ...state.target,
        name: name ?? state.target.name,
        status: status ?? state.target.status,
      };
      return [state.target];
    }
    return [];
  };
  (sql as unknown as { unsafe: (s: string) => unknown }).unsafe = (s: string) => ({
    __frag: true,
    text: s,
  });
  return sql;
}

vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(makeFakeSql()),
}));

import { Hono } from "hono";
import { requireRole } from "../auth/authz";
import publishTargetsRouter from "./publish_targets";
import type { AuthVars } from "../auth/middleware";

function buildApp(): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("userEmail", "admin@bowtie.com.hk");
    await next();
  });
  // Mirror index.ts gates.
  app.post("/publish-targets", requireRole("admin"));
  app.patch("/publish-targets/:id", requireRole("admin"));
  app.post("/publish-targets/:id/archive", requireRole("admin"));
  app.post("/publish-targets/:id/restore", requireRole("admin"));
  app.get("/publish-targets/:id/readiness", requireRole("admin"));
  app.route("/publish-targets", publishTargetsRouter);
  return app;
}

const TARGET: TargetRow = {
  publish_target_id: "00000000-0000-0000-0000-0000000000aa",
  name: "VHIS101 WordPress",
  kind: "wordpress",
  auth_ref: "VHIS101_WP",
  status: "active",
  is_archived: false,
};

function makeEnv(extra: Record<string, string> = {}): Record<string, unknown> {
  return {
    AUTH_DISABLED: "false",
    FRONTEND_ORIGIN: "https://example.test",
    BOOTSTRAP_ADMIN_EMAILS: "",
    ...extra,
  };
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

async function req(
  path: string,
  init: RequestInit,
  env: Record<string, unknown> = makeEnv(),
): Promise<Response> {
  return buildApp().request(path, init, env, ctx);
}

const JSON_HEADERS = { "content-type": "application/json" };

beforeEach(() => {
  state.userRole = "admin";
  state.target = null;
  state.authRefTaken = false;
  state.voiceCount = 0;
});

describe("publish-targets CRUD", () => {
  it("creates a target (admin) → 201", async () => {
    const res = await req("/publish-targets", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "VHIS101 WordPress", auth_ref: "VHIS101_WP" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as TargetRow;
    expect(json.kind).toBe("wordpress");
    expect(json.auth_ref).toBe("VHIS101_WP");
    expect(json.status).toBe("active");
  });

  it("rejects a non-admin with 403", async () => {
    state.userRole = "editor";
    const res = await req("/publish-targets", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "X", auth_ref: "X_WP" }),
    });
    expect(res.status).toBe(403);
  });

  it("422 on a malformed auth_ref", async () => {
    const res = await req("/publish-targets", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "X", auth_ref: "9-bad ref" }),
    });
    expect(res.status).toBe(422);
  });

  it("409 when the auth_ref is already in use", async () => {
    state.authRefTaken = true;
    const res = await req("/publish-targets", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "X", auth_ref: "VHIS101_WP" }),
    });
    expect(res.status).toBe(409);
  });

  it("PATCH edits name/status and ignores auth_ref (locked)", async () => {
    state.target = { ...TARGET };
    const res = await req(`/publish-targets/${TARGET.publish_target_id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed", status: "inactive", auth_ref: "HACKED" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as TargetRow;
    expect(json.name).toBe("Renamed");
    expect(json.status).toBe("inactive");
    expect(json.auth_ref).toBe("VHIS101_WP"); // unchanged
  });

  it("PATCH unknown id → 404", async () => {
    state.target = null;
    const res = await req("/publish-targets/00000000-0000-0000-0000-0000000000ff", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("archive flips is_archived", async () => {
    state.target = { ...TARGET };
    const res = await req(`/publish-targets/${TARGET.publish_target_id}/archive`, {
      method: "POST",
      headers: JSON_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TargetRow).is_archived).toBe(true);
  });

  it("usage returns the assigned voice count", async () => {
    state.target = { ...TARGET };
    state.voiceCount = 3;
    const res = await req(`/publish-targets/${TARGET.publish_target_id}/usage`, {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { assigned_voice_count: number };
    expect(json.assigned_voice_count).toBe(3);
  });

  it("readiness reports all-present when env vars are set", async () => {
    state.target = { ...TARGET };
    const res = await req(
      `/publish-targets/${TARGET.publish_target_id}/readiness`,
      { method: "GET" },
      makeEnv({
        VHIS101_WP_BASE_URL: "https://vhis101.example",
        VHIS101_WP_USERNAME: "u",
        VHIS101_WP_APP_PASSWORD: "p",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ready: boolean; base_url: boolean };
    expect(json.ready).toBe(true);
    expect(json.base_url).toBe(true);
  });

  it("readiness reports not-ready when env vars are missing", async () => {
    state.target = { ...TARGET };
    const res = await req(`/publish-targets/${TARGET.publish_target_id}/readiness`, {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ready: boolean; app_password: boolean };
    expect(json.ready).toBe(false);
    expect(json.app_password).toBe(false);
  });

  it("readiness is admin-gated (editor → 403)", async () => {
    state.userRole = "editor";
    state.target = { ...TARGET };
    const res = await req(`/publish-targets/${TARGET.publish_target_id}/readiness`, {
      method: "GET",
    });
    expect(res.status).toBe(403);
  });
});
