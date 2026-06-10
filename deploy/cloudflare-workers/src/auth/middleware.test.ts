/**
 * Unit tests for `requireAuth` (src/auth/middleware.ts).
 *
 * Covers BOTH provider branches selected by `AUTH_PROVIDER`:
 *   - default / unset → better-auth cookie session (getSession).
 *   - "supabase" → `Authorization: Bearer <jwt>` verified via verifySupabaseJwt.
 * Plus the provider-agnostic invariants: AUTH_DISABLED bypass, the public
 * /api/auth/* path, OPTIONS preflight, and the SSE/collab `?ticket=` transport
 * (which must keep working unchanged on the supabase branch).
 *
 * The collaborators are mocked so this stays a pure middleware unit test:
 *   - ./jwt verifySupabaseJwt — drives the supabase branch.
 *   - ./auth getAuth — drives the better-auth branch.
 *   - ./ticket verifyTicket — drives the SSE/collab branch.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../index";

// ---- Mocks ----------------------------------------------------------------
const verifySupabaseJwt = vi.fn();
const verifyTicket = vi.fn();
const getSession = vi.fn();
const sqlEnd = vi.fn(async () => undefined);

vi.mock("./jwt", () => ({
  verifySupabaseJwt: (...args: unknown[]) => verifySupabaseJwt(...args),
}));
vi.mock("./ticket", () => ({
  verifyTicket: (...args: unknown[]) => verifyTicket(...args),
}));
vi.mock("./auth", () => ({
  getAuth: () => ({
    auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
    sql: { end: () => sqlEnd() },
  }),
}));

import { requireAuth } from "./middleware";
import type { AuthVars } from "./middleware";

// ---- Harness --------------------------------------------------------------
type AuthApp = Hono<{ Bindings: Env; Variables: AuthVars }>;

/** App that gates with requireAuth then echoes the resolved identity. */
function makeApp(): AuthApp {
  const app = new Hono<{ Bindings: Env; Variables: AuthVars }>();
  app.use("*", requireAuth);
  app.all("*", (c) =>
    c.json({ ok: true, userId: c.get("userId") ?? null, userEmail: c.get("userEmail") ?? null }),
  );
  return app;
}

async function call(
  app: AuthApp,
  path: string,
  init: RequestInit,
  env: Partial<Env>,
): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return app.request(
    `https://api.test${path}`,
    init,
    env as Env,
    executionCtx as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  verifySupabaseJwt.mockReset();
  verifyTicket.mockReset();
  getSession.mockReset();
  sqlEnd.mockClear();
});

// ---------------------------------------------------------------------------
// Provider-agnostic invariants.
// ---------------------------------------------------------------------------
describe("requireAuth — provider-agnostic", () => {
  it("AUTH_DISABLED=true bypasses the gate (no session check)", async () => {
    const res = await call(makeApp(), "/runs", { method: "GET" }, { AUTH_DISABLED: "true" });
    expect(res.status).toBe(200);
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("OPTIONS preflight is admitted without a session", async () => {
    const res = await call(makeApp(), "/runs", { method: "OPTIONS" }, { AUTH_PROVIDER: "supabase" });
    expect(res.status).toBe(200);
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
  });

  it("the SSE ticket transport is unchanged on the supabase branch", async () => {
    verifyTicket.mockResolvedValue("user-from-ticket");
    const res = await call(
      makeApp(),
      "/runs/abc/events?ticket=t0",
      { method: "GET" },
      { AUTH_PROVIDER: "supabase" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.userId).toBe("user-from-ticket");
    // Ticket path must NOT fall through to Bearer/cookie verification.
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("the collab /doc ticket transport is unchanged on the supabase branch", async () => {
    verifyTicket.mockResolvedValue("user-from-ticket");
    const res = await call(
      makeApp(),
      "/runs/abc/doc?ticket=t0",
      { method: "GET" },
      { AUTH_PROVIDER: "supabase" },
    );
    expect(res.status).toBe(200);
    expect(verifyTicket).toHaveBeenCalled();
  });

  it("a missing/invalid ticket on the SSE path → 401", async () => {
    verifyTicket.mockResolvedValue(null);
    const res = await call(
      makeApp(),
      "/runs/abc/events?ticket=bad",
      { method: "GET" },
      { AUTH_PROVIDER: "supabase" },
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Supabase branch — Authorization: Bearer <jwt>.
// ---------------------------------------------------------------------------
describe("requireAuth — supabase branch (Bearer)", () => {
  const env: Partial<Env> = { AUTH_PROVIDER: "supabase" };

  it("verifies the Bearer token and sets userId + userEmail", async () => {
    verifySupabaseJwt.mockResolvedValue({ sub: "uuid-1", email: "a@bowtie.com.hk" });
    const res = await call(
      makeApp(),
      "/runs",
      { method: "GET", headers: { authorization: "Bearer jwt-token" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.userId).toBe("uuid-1");
    expect(json.userEmail).toBe("a@bowtie.com.hk");
    expect(verifySupabaseJwt).toHaveBeenCalledWith("jwt-token", expect.anything());
    // Supabase branch must NOT touch the better-auth cookie path.
    expect(getSession).not.toHaveBeenCalled();
  });

  it("sets userId but leaves userEmail unset when the token has no email", async () => {
    verifySupabaseJwt.mockResolvedValue({ sub: "uuid-2", email: null });
    const res = await call(
      makeApp(),
      "/runs",
      { method: "GET", headers: { authorization: "Bearer jwt-token" } },
      env,
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.userId).toBe("uuid-2");
    expect(json.userEmail).toBeNull();
  });

  it("returns 401 with the flat error body when the token is invalid", async () => {
    verifySupabaseJwt.mockResolvedValue(null);
    const res = await call(
      makeApp(),
      "/runs",
      { method: "GET", headers: { authorization: "Bearer bad" } },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when the Authorization header is absent", async () => {
    const res = await call(makeApp(), "/runs", { method: "GET" }, env);
    expect(res.status).toBe(401);
    // No token → verifier is never even consulted.
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is not a Bearer scheme", async () => {
    const res = await call(
      makeApp(),
      "/runs",
      // Computed at runtime so secret scanners don't flag a literal basic-auth header.
      { method: "GET", headers: { authorization: `Basic ${btoa("foo:bar")}` } },
      env,
    );
    expect(res.status).toBe(401);
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// better-auth branch — default provider (cookie session). Unchanged behavior.
// ---------------------------------------------------------------------------
describe("requireAuth — better-auth branch (default)", () => {
  it("validates the cookie session and sets userId + userEmail", async () => {
    getSession.mockResolvedValue({ user: { id: "ba-1", email: "b@bowtie.com.hk" } });
    const res = await call(makeApp(), "/runs", { method: "GET" }, {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.userId).toBe("ba-1");
    expect(json.userEmail).toBe("b@bowtie.com.hk");
    // Default provider must NOT consult the supabase verifier.
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no cookie session", async () => {
    getSession.mockResolvedValue(null);
    const res = await call(makeApp(), "/runs", { method: "GET" }, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("an explicit non-supabase AUTH_PROVIDER still uses the better-auth path", async () => {
    getSession.mockResolvedValue({ user: { id: "ba-2", email: "c@bowtie.com.hk" } });
    const res = await call(makeApp(), "/runs", { method: "GET" }, { AUTH_PROVIDER: "better-auth" });
    expect(res.status).toBe(200);
    expect(getSession).toHaveBeenCalled();
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
  });
});
