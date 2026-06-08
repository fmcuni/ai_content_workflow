/**
 * /wp-options/* per-voice target scoping.
 *
 * The HITL_2 author/category pickers must read the cached taxonomy of the run's
 * own CMS instance: ?run_id resolves run.persona → publish target → auth_ref,
 * and the wp_users/wp_categories query filters by that auth_ref. No run_id, an
 * unknown run, or an unassigned voice → the legacy 'WP' default.
 *
 * Exercises the real Hono handler against a fake `sql` (vi.mock on ../db/client).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Fragment {
  __frag: true;
  text: string;
}
function isFragment(v: unknown): v is Fragment {
  return typeof v === "object" && v !== null && "__frag" in v;
}
function render(strings: TemplateStringsArray, values: unknown[]): { text: string; values: unknown[] } {
  let out = strings[0] ?? "";
  const flat: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    if (isFragment(values[i])) out += (values[i] as Fragment).text;
    else flat.push(values[i]);
    out += strings[i + 1] ?? "";
  }
  return { text: out.replace(/\s+/g, " ").trim().toLowerCase(), values: flat };
}

const state: {
  persona: string | null;
  targetAuthRef: string | null; // null → voice has no target row
  lastUsersAuthRef: string | null;
  lastCatsAuthRef: string | null;
} = { persona: "vhis101", targetAuthRef: "VHIS101_WP", lastUsersAuthRef: null, lastCatsAuthRef: null };

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const { text, values: flat } = render(strings, values);

    if (text.includes("from content_tool.runs")) {
      return state.persona === null ? [] : [{ persona: state.persona }];
    }
    if (text.includes("join content_tool.publish_targets")) {
      return state.targetAuthRef === null
        ? []
        : [
            {
              publish_target_id: "t-1",
              name: "VHIS101 WordPress",
              kind: "wordpress",
              auth_ref: state.targetAuthRef,
              status: "active",
              is_archived: false,
            },
          ];
    }
    if (text.includes("from content_tool.wp_users")) {
      state.lastUsersAuthRef = (flat[0] as string) ?? null;
      return [{ id: 1, name: `user-for-${flat[0] as string}`, slug: "u1" }];
    }
    if (text.includes("from content_tool.wp_categories")) {
      state.lastCatsAuthRef = (flat[0] as string) ?? null;
      return [{ id: 2, name: `cat-for-${flat[0] as string}`, slug: "c1" }];
    }
    return [];
  };
  (sql as unknown as { end: () => Promise<void> }).end = async () => undefined;
  return sql;
}

vi.mock("../db/client", () => ({ getSql: () => makeFakeSql() }));

import { Hono } from "hono";
import wpOptionsRouter from "./wp-options";
import type { Env } from "../index";

function app(): Hono<{ Bindings: Env }> {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/wp-options", wpOptionsRouter);
  return a;
}

async function get(path: string): Promise<Response> {
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
  return app().request(path, {}, {} as Env, ctx as unknown as ExecutionContext);
}

beforeEach(() => {
  state.persona = "vhis101";
  state.targetAuthRef = "VHIS101_WP";
  state.lastUsersAuthRef = null;
  state.lastCatsAuthRef = null;
});

describe("/wp-options per-voice target scoping", () => {
  it("scopes users to the run's resolved auth_ref", async () => {
    const res = await get("/wp-options/users?run_id=r1");
    expect(res.status).toBe(200);
    expect(state.lastUsersAuthRef).toBe("VHIS101_WP");
  });

  it("scopes categories to the run's resolved auth_ref", async () => {
    const res = await get("/wp-options/categories?run_id=r1");
    expect(res.status).toBe(200);
    expect(state.lastCatsAuthRef).toBe("VHIS101_WP");
  });

  it("falls back to 'WP' when no run_id is given", async () => {
    await get("/wp-options/users");
    expect(state.lastUsersAuthRef).toBe("WP");
  });

  it("falls back to 'WP' for an unassigned voice (no target row)", async () => {
    state.targetAuthRef = null;
    await get("/wp-options/users?run_id=r1");
    expect(state.lastUsersAuthRef).toBe("WP");
  });

  it("falls back to 'WP' for an unknown run", async () => {
    state.persona = null;
    await get("/wp-options/categories?run_id=does-not-exist");
    expect(state.lastCatsAuthRef).toBe("WP");
  });
});
