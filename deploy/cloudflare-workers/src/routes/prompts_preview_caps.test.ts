/**
 * Preview-endpoint resource caps. The POST /templates/:id/preview handler accepts
 * unsaved drafts as untrusted input; oversized payloads must be rejected (413/422)
 * BEFORE any DB work. These caps run prior to `withDb`, so a stubbed DB suffices —
 * if a cap fails, the handler would fall through to the (here, 404) DB path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbCalls = { count: 0 };

vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) => {
    dbCalls.count += 1;
    // Minimal snapshot stub: an empty view → the handler 404s if it ever runs.
    const sql = (() => []) as unknown;
    (sql as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return fn(sql);
  },
}));

import { Hono } from "hono";
import { promptsRouter } from "./prompts";
import type { Env } from "../index";

function app(): Hono<{ Bindings: Env }> {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/prompts", promptsRouter);
  return a;
}

async function preview(bodyObj: Record<string, unknown>): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return app().request(
    "/prompts/templates/writer_small_refresh/preview",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "x", ...bodyObj }),
    },
    {} as unknown as Env,
    executionCtx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  dbCalls.count = 0;
});

describe("preview resource caps", () => {
  it("rejects partial_overrides with > 100 entries (422, before DB)", async () => {
    const overrides: Record<string, string> = {};
    for (let i = 0; i < 101; i += 1) overrides[`p${i}`] = "x";
    const res = await preview({ partial_overrides: overrides });
    expect(res.status).toBe(422);
    expect(dbCalls.count).toBe(0);
  });

  it("rejects an oversized partial_overrides value (413, before DB)", async () => {
    const res = await preview({ partial_overrides: { p: "a".repeat(64 * 1024 + 1) } });
    expect(res.status).toBe(413);
    expect(dbCalls.count).toBe(0);
  });

  it("rejects an oversized source_policy.prompt_block (413, before DB)", async () => {
    const res = await preview({ source_policy: { prompt_block: "a".repeat(64 * 1024 + 1) } });
    expect(res.status).toBe(413);
    expect(dbCalls.count).toBe(0);
  });

  it("rejects a glossary with > 500 entries (422, before DB)", async () => {
    const glossary = Array.from({ length: 501 }, () => ({ term: "t" }));
    const res = await preview({ glossary });
    expect(res.status).toBe(422);
    expect(dbCalls.count).toBe(0);
  });

  it("rejects an over-long glossary field (422, before DB)", async () => {
    const res = await preview({ glossary: [{ term: "a".repeat(501) }] });
    expect(res.status).toBe(422);
    expect(dbCalls.count).toBe(0);
  });
});
