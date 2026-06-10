/**
 * Unit tests for `loadRole` (src/auth/authz.ts) — the provider-aware role
 * source added in WS1.
 *
 *   - AUTH_PROVIDER="supabase" → role comes from content_tool.app_user (id then
 *     email).
 *   - any other value (default better-auth) → role comes from content_tool."user".
 *   - id is preferred over email; email is the fallback.
 *   - bootstrap-admin override + the per-request cache still apply.
 *   - no session identity → null (caller maps to 401).
 *
 * `../db/client`'s `withDb` is mocked with a fake `sql` tag that records the
 * rendered query text, so each test asserts WHICH table was read and returns a
 * scripted role row.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../index";

// ---- Fake DB --------------------------------------------------------------
const state: { role: string | null; matchById: boolean; queries: string[] } = {
  role: "author",
  matchById: true,
  queries: [],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): unknown {
  let text = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    text += `$${i}` + (strings[i + 1] ?? "");
  }
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  state.queries.push(normalized);
  const byId = normalized.includes("where id =");
  // Return the scripted role only for the lookup we want to "hit"; the other
  // lookup returns no row so the fallback path is exercised when needed.
  if ((byId && state.matchById) || (!byId && !state.matchById)) {
    return Promise.resolve([{ role: state.role }]);
  }
  return Promise.resolve([]);
}

vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(fakeSql),
}));

import { loadRole } from "./authz";
import type { AuthVars } from "./middleware";

// ---- Harness --------------------------------------------------------------
/** Drive loadRole inside a real Hono request so the context vars are set. */
async function resolve(opts: {
  userId?: string;
  userEmail?: string;
  env: Partial<Env>;
}): Promise<string | null> {
  const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
  let result: string | null = null;
  app.get("/", async (c) => {
    if (opts.userId !== undefined) c.set("userId", opts.userId);
    if (opts.userEmail !== undefined) c.set("userEmail", opts.userEmail);
    result = await loadRole(c);
    return c.json({ ok: true });
  });
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  await app.request("https://api.test/", { method: "GET" }, opts.env as Env, executionCtx as unknown as ExecutionContext);
  return result;
}

beforeEach(() => {
  state.role = "author";
  state.matchById = true;
  state.queries = [];
});

// ---------------------------------------------------------------------------
// app_user path (AUTH_PROVIDER="supabase").
// ---------------------------------------------------------------------------
describe("loadRole — app_user path (supabase)", () => {
  const env: Partial<Env> = { AUTH_PROVIDER: "supabase", BOOTSTRAP_ADMIN_EMAILS: "" };

  it("reads the role from content_tool.app_user by id", async () => {
    state.role = "reviewer";
    state.matchById = true;
    const role = await resolve({ userId: "uuid-1", userEmail: "a@bowtie.com.hk", env });
    expect(role).toBe("reviewer");
    expect(state.queries.some((q) => q.includes("from content_tool.app_user"))).toBe(true);
    expect(state.queries.some((q) => q.includes('content_tool."user"'))).toBe(false);
  });

  it("falls back to the app_user email lookup when the id has no row", async () => {
    state.role = "author";
    state.matchById = false; // id lookup misses → email lookup hits
    const role = await resolve({ userId: "uuid-missing", userEmail: "a@bowtie.com.hk", env });
    expect(role).toBe("author");
    expect(state.queries.filter((q) => q.includes("from content_tool.app_user")).length).toBe(2);
  });

  it("DENIES (null) when app_user has no matching row at all — invite-only gate", async () => {
    // Under Google OAuth, GoTrue auto-creates a user for anyone who signs in, so an
    // authenticated-but-unprovisioned session must be denied here rather than floored
    // to viewer (which would be open self-signup with read access).
    state.matchById = false;
    state.role = null;
    const role = await resolve({ userId: "x", userEmail: "nobody@bowtie.com.hk", env });
    expect(role).toBeNull();
  });

  it("the bootstrap-admin override still wins over the stored app_user role", async () => {
    state.role = "viewer";
    const role = await resolve({
      userId: "uuid-1",
      userEmail: "boss@bowtie.com.hk",
      env: { AUTH_PROVIDER: "supabase", BOOTSTRAP_ADMIN_EMAILS: "boss@bowtie.com.hk" },
    });
    expect(role).toBe("admin");
  });

  it("a bootstrap admin with NO app_user row is still admin (not denied)", async () => {
    state.matchById = false;
    state.role = null;
    const role = await resolve({
      userId: "uuid-new",
      userEmail: "boss@bowtie.com.hk",
      env: { AUTH_PROVIDER: "supabase", BOOTSTRAP_ADMIN_EMAILS: "boss@bowtie.com.hk" },
    });
    expect(role).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// legacy "user" path (AUTH_PROVIDER unset / better-auth).
// ---------------------------------------------------------------------------
describe("loadRole — legacy user path (default)", () => {
  it("reads the role from content_tool.\"user\" when the provider is unset", async () => {
    state.role = "reviewer";
    state.matchById = true;
    const role = await resolve({ userId: "id-1", userEmail: "a@bowtie.com.hk", env: {} });
    expect(role).toBe("reviewer");
    expect(state.queries.some((q) => q.includes('content_tool."user"'))).toBe(true);
    expect(state.queries.some((q) => q.includes("from content_tool.app_user"))).toBe(false);
  });

  it("aliases a legacy stored 'editor' role to reviewer", async () => {
    state.role = "editor";
    const role = await resolve({ userId: "id-1", env: {} });
    expect(role).toBe("reviewer");
  });

  it("returns null when there is no session identity (→ 401)", async () => {
    const role = await resolve({ env: {} });
    expect(role).toBeNull();
    expect(state.queries.length).toBe(0);
  });

  it("KEEPS the viewer floor when an authenticated legacy user has no row", async () => {
    // The legacy better-auth path is unchanged by the OAuth invite-only gate:
    // a session with identity but no stored role still floors to viewer.
    state.matchById = false;
    state.role = null;
    const role = await resolve({ userId: "id-x", userEmail: "a@bowtie.com.hk", env: {} });
    expect(role).toBe("viewer");
  });
});
