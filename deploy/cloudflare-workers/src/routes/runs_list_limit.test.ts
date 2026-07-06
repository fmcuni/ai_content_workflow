/**
 * GET /runs list-limit clamp — perf/worker-cpu-hackathon.
 *
 * DEFAULT_LIST_LIMIT dropped 2000 -> 200 and a hard MAX_LIST_LIMIT (500) now
 * clamps client-supplied `?limit=`, so the LEFT JOIN LATERAL in the list query
 * can never re-blow-up CPU by re-shaping thousands of rows. Mirrors the fake-DB
 * harness in runs_rbac.test.ts, but only needs to capture the numeric `LIMIT`
 * value substituted into the tagged-template SQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let capturedLimit: unknown;

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = strings.join(" ");
    if (/LIMIT/i.test(text) && values.length > 0) {
      capturedLimit = values[values.length - 1];
    }
    if (!/^\s*select/i.test(text)) {
      return { __frag: true };
    }
    return Promise.resolve([]);
  };
  return sql;
}

vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(makeFakeSql()),
}));

import { Hono } from "hono";
import runsRouter from "./runs";
import type { AuthVars } from "../auth/middleware";

function appWith(): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("userEmail", "reviewer@example.test");
    await next();
  });
  app.route("/", runsRouter);
  return app;
}

async function getRuns(query: string): Promise<void> {
  const executionCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
  await appWith().request(
    `/${query}`,
    { method: "GET" },
    {},
    executionCtx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  capturedLimit = undefined;
});

describe("GET /runs limit clamp", () => {
  it("defaults to 200 when no ?limit= is given", async () => {
    await getRuns("");
    expect(capturedLimit).toBe(200);
  });

  it("honors a client-supplied limit under the ceiling", async () => {
    await getRuns("?limit=50");
    expect(capturedLimit).toBe(50);
  });

  it("clamps a client-supplied limit above MAX_LIST_LIMIT down to 500", async () => {
    await getRuns("?limit=2000");
    expect(capturedLimit).toBe(500);
  });

  it("floors a non-positive limit at 1", async () => {
    await getRuns("?limit=0");
    expect(capturedLimit).toBe(1);
  });
});
