/**
 * Input-validation tests for the runs routes (WS5 MEDIUM finding).
 *
 * The run-creation and publish-bearing mutation routes previously read request
 * bodies via unchecked `c.req.json<T>()` casts. These tests assert that the new
 * Zod schemas (./runs.schemas) REJECT malformed/malicious input with HTTP 400
 * while still ACCEPTING currently-valid create/refresh/publish bodies.
 *
 * Harness mirrors runs_rbac.test.ts: a stateful fake `sql` (vi.mock on
 * ../db/client) drives loadRole + the run handlers; the real Hono handlers run
 * under the node pool. Validation runs BEFORE the DB write, so a 400 fires even
 * against the minimal fake DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Stateful fake DB — `userRole` drives loadRole; `run` drives the handlers.
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
} = { userRole: "reviewer", run: null };

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

    if (!/^\s*(select|update|insert|delete)\b/.test(lower)) {
      return { __frag: true, text } as Fragment;
    }

    if (lower.startsWith("select")) {
      // loadRole: role lookup on the user table.
      if (lower.includes('from content_tool."user"')) {
        return [{ role: state.userRole }];
      }
      if (lower.includes("select created_by from content_tool.runs")) {
        return state.run === null ? [] : [{ created_by: state.run.created_by }];
      }
      if (lower.includes("select status, hitl_2_iteration")) {
        return state.run === null
          ? []
          : [{ status: state.run.status, hitl_2_iteration: state.run.hitl_2_iteration }];
      }
      if (lower.includes("select status from content_tool.runs")) {
        return state.run === null ? [] : [{ status: state.run.status }];
      }
      if (lower.includes("select run_id from content_tool.runs")) {
        return state.run === null ? [] : [{ run_id: state.run.run_id }];
      }
      return [];
    }

    if (lower.startsWith("insert")) {
      // create-run INSERT ... RETURNING run_id, created_at, article_id.
      return [{ run_id: "new-run", created_at: "2026-06-10T00:00:00Z", article_id: null }];
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
  const instance = { sendEvent: async () => undefined, create: async () => undefined };
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
  state.userRole = "reviewer";
  state.run = null;
});

// ---------------------------------------------------------------------------
// POST /runs — run creation. Author capability; role set to reviewer (>= author).
// ---------------------------------------------------------------------------
describe("POST /runs body validation", () => {
  it("rejects a malformed article_url (not a URL) with 400", async () => {
    const res = await req(appWith("a@b.com"), "POST", "/", {
      start_mode: "refresh",
      article_url: "not a url",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("invalid request body");
  });

  it("rejects keywords longer than 20 entries with 400", async () => {
    const res = await req(appWith("a@b.com"), "POST", "/", {
      start_mode: "create",
      keywords: Array.from({ length: 21 }, (_, i) => `k${i}`),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown start_mode enum with 400", async () => {
    const res = await req(appWith("a@b.com"), "POST", "/", {
      start_mode: "destroy",
    });
    expect(res.status).toBe(400);
  });

  it("rejects keywords that are not strings with 400", async () => {
    const res = await req(appWith("a@b.com"), "POST", "/", {
      start_mode: "create",
      keywords: [1, 2, 3],
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid create body (start_mode=create, no article_url)", async () => {
    const res = await req(appWith("a@b.com"), "POST", "/", {
      start_mode: "create",
      topic: "Health basics",
      keywords: ["vhis", "tax"],
      mode: "auto",
      persona: "bowtie-editor",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.run_id).toBe("new-run");
  });

  it("accepts a valid refresh body (start_mode=refresh + article_url)", async () => {
    const res = await req(appWith("a@b.com"), "POST", "/", {
      start_mode: "refresh",
      article_url: "https://www.bowtie.com.hk/blog/health",
      keywords: ["a", "b"],
    });
    expect(res.status).toBe(200);
  });

  it("still enforces the create/article_url business rule (422, not 400)", async () => {
    // A schema-valid body that violates the create→no-article_url invariant
    // must keep returning the existing 422 (validation passed, business rule failed).
    const res = await req(appWith("a@b.com"), "POST", "/", {
      start_mode: "create",
      article_url: "https://www.bowtie.com.hk/blog/x",
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// POST /runs/:id/resume — reviewer capability. decision + new_route enums.
// ---------------------------------------------------------------------------
describe("POST /runs/:id/resume body validation", () => {
  it("rejects an invalid decision enum with 400", async () => {
    state.run = { run_id: "r1", status: "hitl_1", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/resume", { decision: "explode" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid new_route enum with 400", async () => {
    state.run = { run_id: "r1", status: "hitl_1", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/resume", {
      decision: "override_route",
      new_route: "teleport",
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid approve decision", async () => {
    state.run = { run_id: "r1", status: "hitl_1", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/resume", { decision: "approve" });
    expect(res.status).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /runs/:id/hitl-2 — reviewer. decision enum + wp_publish_status + datetime.
// ---------------------------------------------------------------------------
describe("POST /runs/:id/hitl-2 body validation", () => {
  it("rejects an invalid decision enum with 400", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/hitl-2", { decision: "yolo" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid wp_publish_status enum with 400", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/hitl-2", {
      decision: "approve",
      wp_publish_status: "trash",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-datetime wp_publish_at with 400", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/hitl-2", {
      decision: "approve",
      wp_publish_at: "next tuesday",
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid approve with publish status + ISO datetime", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/hitl-2", {
      decision: "approve",
      wp_publish_status: "future",
      wp_publish_at: "2026-07-01T09:00:00Z",
      wp_category_ids: [1, 2],
    });
    expect(res.status).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /runs/:id/dry-publish — reviewer. wp_publish_status + datetime.
// ---------------------------------------------------------------------------
describe("POST /runs/:id/dry-publish body validation", () => {
  it("rejects an invalid wp_publish_status enum with 400", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/dry-publish", {
      wp_publish_status: "garbage",
    });
    expect(res.status).toBe(400);
  });

  it("accepts an empty body (all fields optional)", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/dry-publish", {});
    expect(res.status).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PUT /runs/:id/article — author. wp_publish_status + datetime.
// ---------------------------------------------------------------------------
describe("PUT /runs/:id/article body validation", () => {
  it("rejects an invalid wp_publish_status enum with 400", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "PUT", "/r1/article", {
      html_body: "<p>x</p>",
      wp_publish_status: "nope",
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid article edit body", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "PUT", "/r1/article", {
      html_body: "<p>x</p>",
      wp_publish_status: "draft",
      expected_version: 3,
    });
    expect(res.status).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /runs/:id — reviewer. wp_publish_status + datetime.
// ---------------------------------------------------------------------------
describe("PATCH /runs/:id body validation", () => {
  it("rejects an invalid wp_publish_status enum with 400", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "PATCH", "/r1", {
      wp_publish_status: "bogus",
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid metadata patch", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "PATCH", "/r1", {
      wp_publish_status: "publish",
      wp_author_id: 5,
    });
    expect(res.status).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /runs/:id/hitl2-snapshots — author. trigger enum + wp_publish_status.
// ---------------------------------------------------------------------------
describe("POST /runs/:id/hitl2-snapshots body validation", () => {
  it("rejects an invalid trigger enum with 400", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/hitl2-snapshots", {
      html_body: "<p>x</p>",
      trigger: "explode",
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid manual snapshot", async () => {
    state.run = { run_id: "r1", status: "hitl_2", hitl_2_iteration: 0, created_by: "a@b.com" };
    const res = await req(appWith("a@b.com"), "POST", "/r1/hitl2-snapshots", {
      html_body: "<p>x</p>",
      trigger: "manual",
      wp_publish_status: "draft",
    });
    expect(res.status).not.toBe(400);
  });
});
