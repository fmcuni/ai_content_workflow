/**
 * Unit tests for `loadRole` (src/auth/authz.ts) — the role source.
 *
 *   - role comes from content_tool.app_user (id then email).
 *   - id is preferred over email; email is the fallback.
 *   - an authenticated session with no app_user row is DENIED (invite-only).
 *   - bootstrap-admin override + the per-request cache still apply.
 *   - no session identity → null (caller maps to 401).
 *
 * `../db/client`'s `withDb` is mocked with a fake `sql` tag that records the
 * rendered query text, so each test asserts the table read and returns a
 * scripted role row.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../index";

// ---- Fake DB --------------------------------------------------------------
const state: {
  role: string | null;
  status: string | null;
  sessionsRevokedEpoch: number | null;
  matchById: boolean;
  queries: string[];
} = {
  role: "author",
  status: "active",
  sessionsRevokedEpoch: null,
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
    // The app_user query projects role+status+sessions_revoked_epoch.
    return Promise.resolve([
      {
        role: state.role,
        status: state.status,
        sessions_revoked_epoch: state.sessionsRevokedEpoch,
      },
    ]);
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
  tokenIssuedAt?: number;
  env: Partial<Env>;
}): Promise<string | null> {
  const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
  let result: string | null = null;
  app.get("/", async (c) => {
    if (opts.userId !== undefined) c.set("userId", opts.userId);
    if (opts.userEmail !== undefined) c.set("userEmail", opts.userEmail);
    if (opts.tokenIssuedAt !== undefined) c.set("tokenIssuedAt", opts.tokenIssuedAt);
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
  state.status = "active";
  state.sessionsRevokedEpoch = null;
  state.matchById = true;
  state.queries = [];
});

// ---------------------------------------------------------------------------
// app_user path.
// ---------------------------------------------------------------------------
describe("loadRole — app_user path", () => {
  const env: Partial<Env> = { BOOTSTRAP_ADMIN_EMAILS: "" };

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
      env: { BOOTSTRAP_ADMIN_EMAILS: "boss@bowtie.com.hk" },
    });
    expect(role).toBe("admin");
  });

  it("a bootstrap admin with NO app_user row is still admin (not denied)", async () => {
    state.matchById = false;
    state.role = null;
    const role = await resolve({
      userId: "uuid-new",
      userEmail: "boss@bowtie.com.hk",
      env: { BOOTSTRAP_ADMIN_EMAILS: "boss@bowtie.com.hk" },
    });
    expect(role).toBe("admin");
  });

  it("DENIES (null) a disabled app_user regardless of stored role", async () => {
    // The GoTrue ban only blocks NEW sign-ins; the live access token stays
    // valid until expiry, so the per-request denial must happen here.
    state.role = "admin";
    state.status = "disabled";
    const role = await resolve({ userId: "uuid-1", userEmail: "a@bowtie.com.hk", env });
    expect(role).toBeNull();
  });

  it("DENIES (null) a token issued BEFORE sessions_revoked_at (admin revoke)", async () => {
    // GoTrue's admin sign-out only kills refresh tokens; the live access token
    // stays valid until expiry, so the revocation cut-off is enforced here.
    state.role = "reviewer";
    state.sessionsRevokedEpoch = 1_000_000;
    const role = await resolve({
      userId: "uuid-1",
      userEmail: "a@bowtie.com.hk",
      tokenIssuedAt: 999_900,
      env,
    });
    expect(role).toBeNull();
  });

  it("allows a token issued AFTER sessions_revoked_at (fresh sign-in)", async () => {
    state.role = "reviewer";
    state.sessionsRevokedEpoch = 1_000_000;
    const role = await resolve({
      userId: "uuid-1",
      userEmail: "a@bowtie.com.hk",
      tokenIssuedAt: 1_000_100,
      env,
    });
    expect(role).toBe("reviewer");
  });

  it("ignores sessions_revoked_at when the request carries no token iat (ticket path)", async () => {
    state.role = "reviewer";
    state.sessionsRevokedEpoch = 1_000_000;
    const role = await resolve({ userId: "uuid-1", userEmail: "a@bowtie.com.hk", env });
    expect(role).toBe("reviewer");
  });

  it("the admin-eligible bootstrap break-glass survives a revocation", async () => {
    // Same lockout-recovery property as the disabled row: BOOTSTRAP_ADMIN_EMAILS
    // keeps working even when the stored row says revoked.
    state.role = "admin";
    state.sessionsRevokedEpoch = 1_000_000;
    const role = await resolve({
      userId: "uuid-1",
      userEmail: "boss@bowtie.com.hk",
      tokenIssuedAt: 999_900,
      env: { BOOTSTRAP_ADMIN_EMAILS: "boss@bowtie.com.hk" },
    });
    expect(role).toBe("admin");
  });

  it("the admin-eligible bootstrap break-glass survives a disabled row", async () => {
    // Lockout recovery: BOOTSTRAP_ADMIN_EMAILS must keep working even if every
    // admin row was mass-disabled. Eligible-domain emails only.
    state.role = "admin";
    state.status = "disabled";
    const role = await resolve({
      userId: "uuid-1",
      userEmail: "boss@bowtie.com.hk",
      env: { BOOTSTRAP_ADMIN_EMAILS: "boss@bowtie.com.hk" },
    });
    expect(role).toBe("admin");
  });

  it("aliases a legacy stored 'editor' role to reviewer", async () => {
    // Rows written under the old 3-role model persisted "editor"; coerceRole
    // maps it onto the new "reviewer" tier regardless of the table.
    state.role = "editor";
    const role = await resolve({ userId: "uuid-1", env });
    expect(role).toBe("reviewer");
  });

  it("returns null when there is no session identity (→ 401)", async () => {
    const role = await resolve({ env });
    expect(role).toBeNull();
    expect(state.queries.length).toBe(0);
  });
});
