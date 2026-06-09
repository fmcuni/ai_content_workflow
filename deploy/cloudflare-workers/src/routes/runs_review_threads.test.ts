/**
 * Review-thread route tests (human-only highlight discussions) for the Workers
 * backend. Exercises the real Hono handlers against a stateful fake `sql`
 * (vi.mock on ../db/client), mirroring runs_rbac.test.ts. A SEPARATE pipeline
 * from the AI-edit comments — these never touch apply-edits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state: { runExists: boolean; threadExists: boolean } = {
  runExists: true,
  threadExists: true,
};

// run_id / thread_id are Postgres `uuid` columns, so the routes guard the path
// segments for uuid shape before querying. Tests must use real uuids on the
// happy paths (non-uuid ids are exercised separately, below).
const RUN = "11111111-1111-4111-8111-111111111111";
const TID = "22222222-2222-4222-8222-222222222222";

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
  return out;
}

// A canned RETURNING row. `status` lets the resolve test assert the toggle.
function cannedRow(status: string): Record<string, unknown> {
  return {
    thread_id: "t-1",
    run_id: "run-1",
    anchor_id: "r-1",
    anchor_text: "the lede",
    status,
    messages: [
      {
        id: "m-1",
        author_email: "ann@bowtie.com.hk",
        author_name: "Ann",
        body: "needs a citation",
        created_at: "2026-06-09T10:00:00.000Z",
      },
    ],
    created_by: "ann@bowtie.com.hk",
    created_by_name: "Ann",
    created_at: "2026-06-09 10:00:00.000000+00",
    resolved_by: null,
    resolved_by_name: null,
    resolved_at: null,
    updated_at: "2026-06-09 10:00:00.000000+00",
  };
}

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = renderText(strings, values);
    const lower = text.toLowerCase();

    if (!/^\s*(select|update|insert|delete)\b/.test(lower)) {
      return { __frag: true, text } as Fragment;
    }
    if (lower.includes("from content_tool.runs")) {
      return state.runExists ? [{ run_id: "run-1" }] : [];
    }
    if (lower.includes("insert into content_tool.run_event_logs")) {
      return [];
    }
    if (lower.includes("insert into content_tool.review_threads")) {
      return [cannedRow("open")];
    }
    if (lower.includes("select") && lower.includes("review_threads")) {
      return state.threadExists ? [{ messages: cannedRow("open").messages }] : [];
    }
    if (lower.includes("update content_tool.review_threads")) {
      if (!state.threadExists) return [];
      // The status is a bound VALUE (not literal text), so inspect `values`.
      return [cannedRow(values.includes("resolved") ? "resolved" : "open")];
    }
    if (lower.includes("delete from content_tool.review_threads")) {
      return { count: 1 };
    }
    return [];
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

function appWith(authEmail: string | null): AuthApp {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    if (authEmail) c.set("userEmail", authEmail);
    await next();
  });
  app.route("/", runsRouter);
  return app;
}

function makeEnv(): Record<string, unknown> {
  return {
    AUTH_DISABLED: "false",
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
  const init: RequestInit =
    body === null
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  return app.request(path, init, makeEnv(), executionCtx as unknown as ExecutionContext);
}

beforeEach(() => {
  state.runExists = true;
  state.threadExists = true;
});

describe("review-thread routes", () => {
  it("GET /:id/review-threads returns the thread list", async () => {
    const res = await req(appWith("ann@b.com"), "GET", `/${RUN}/review-threads`, null);
    // GET has no role gate; the fake list query returns [] for this branch.
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("POST create → 404 when the run is missing", async () => {
    state.runExists = false;
    const res = await req(appWith("ann@b.com"), "POST", `/${RUN}/review-threads`, {
      anchor_id: "r-1",
      anchor_text: "lede",
      body: "needs a citation",
    });
    expect(res.status).toBe(404);
  });

  it("POST create → 200 with an open thread and ISO timestamps", async () => {
    const res = await req(appWith("ann@b.com"), "POST", `/${RUN}/review-threads`, {
      anchor_id: "r-1",
      anchor_text: "lede",
      body: "needs a citation",
      editor_name: "Ann",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("open");
    expect(json.thread_id).toBe("t-1");
    expect(Array.isArray(json.messages)).toBe(true);
    // pg text timestamp normalised to ISO-8601 with a trailing Z.
    expect(json.created_at).toBe("2026-06-09T10:00:00.000000Z");
  });

  it("POST reply → 404 when the thread is missing", async () => {
    state.threadExists = false;
    const res = await req(appWith("ann@b.com"), "POST", `/${RUN}/review-threads/${TID}/replies`, {
      body: "added it",
    });
    expect(res.status).toBe(404);
  });

  it("POST reply → 200 when the thread exists", async () => {
    const res = await req(appWith("ann@b.com"), "POST", `/${RUN}/review-threads/${TID}/replies`, {
      body: "added it",
    });
    expect(res.status).toBe(200);
  });

  it("POST resolve {resolved:true} → status becomes 'resolved'", async () => {
    const res = await req(appWith("ann@b.com"), "POST", `/${RUN}/review-threads/${TID}/resolve`, {
      resolved: true,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("resolved");
  });

  it("POST resolve {resolved:false} → status becomes 'open'", async () => {
    const res = await req(appWith("ann@b.com"), "POST", `/${RUN}/review-threads/${TID}/resolve`, {
      resolved: false,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("open");
  });

  it("POST resolve → 404 when the thread is missing", async () => {
    state.threadExists = false;
    const res = await req(appWith("ann@b.com"), "POST", `/${RUN}/review-threads/${TID}/resolve`, {
      resolved: true,
    });
    expect(res.status).toBe(404);
  });

  it("DELETE → 204", async () => {
    const res = await req(appWith("ann@b.com"), "DELETE", `/${RUN}/review-threads/${TID}`, null);
    expect(res.status).toBe(204);
  });

  it("POST create is blocked (401) without an authenticated session", async () => {
    const res = await req(appWith(null), "POST", `/${RUN}/review-threads`, {
      anchor_id: "r-1",
      body: "x",
    });
    expect(res.status).toBe(401);
  });

  // Regression: a non-uuid thread id (e.g. the literal "undefined" sent by a
  // stale client) must NOT reach the `uuid`-column query — Postgres would throw
  // `invalid input syntax for type uuid` and surface as a 500. The route guards
  // the id shape and returns 404 instead. Reproduced live before the fix.
  it("POST reply with a non-uuid thread id → 404 (not 500)", async () => {
    const res = await req(
      appWith("ann@b.com"),
      "POST",
      `/${RUN}/review-threads/undefined/replies`,
      { body: "x" },
    );
    expect(res.status).toBe(404);
  });

  it("POST resolve with a non-uuid thread id → 404 (not 500)", async () => {
    const res = await req(
      appWith("ann@b.com"),
      "POST",
      `/${RUN}/review-threads/undefined/resolve`,
      { resolved: true },
    );
    expect(res.status).toBe(404);
  });

  it("POST create with a non-uuid run id → 404 (not 500)", async () => {
    const res = await req(appWith("ann@b.com"), "POST", "/not-a-uuid/review-threads", {
      anchor_id: "r-1",
      body: "x",
    });
    expect(res.status).toBe(404);
  });

  it("DELETE with a non-uuid thread id → 204 (no-op, not 500)", async () => {
    const res = await req(
      appWith("ann@b.com"),
      "DELETE",
      `/${RUN}/review-threads/undefined`,
      null,
    );
    expect(res.status).toBe(204);
  });

  it("GET with a non-uuid run id → 200 [] (not 500)", async () => {
    const res = await req(appWith("ann@b.com"), "GET", "/not-a-uuid/review-threads", null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
