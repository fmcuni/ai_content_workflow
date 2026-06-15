/**
 * Unit tests for `requireAuth` (src/auth/middleware.ts).
 *
 * Covers the Supabase auth flow:
 *   - `Authorization: Bearer <jwt>` verified via verifySupabaseJwt.
 *   - AUTH_DISABLED bypass, OPTIONS preflight, and the SSE/collab `?ticket=`
 *     transport.
 *   - the provisioning gate: a valid session whose app_user row is gone/disabled
 *     (loadRole → null) is denied at the gate.
 *
 * The collaborators are mocked so this stays a pure middleware unit test:
 *   - ./jwt verifySupabaseJwt — verifies the Bearer token.
 *   - ./ticket verifyTicket — drives the SSE/collab branch.
 *   - ./authz loadRole — the provisioning gate.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../index";

// ---- Mocks ----------------------------------------------------------------
const verifySupabaseJwt = vi.fn();
const verifyTicket = vi.fn();
const loadRole = vi.fn();

vi.mock("./jwt", () => ({
  verifySupabaseJwt: (...args: unknown[]) => verifySupabaseJwt(...args),
}));
vi.mock("./ticket", () => ({
  verifyTicket: (...args: unknown[]) => verifyTicket(...args),
}));
// The middleware's provisioning gate consults loadRole; mock it so this stays a
// pure middleware unit test (no DB).
vi.mock("./authz", () => ({
  loadRole: (...args: unknown[]) => loadRole(...args),
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
  // Default: the session user IS provisioned (app_user row, active). Tests for
  // the deletion/disable gate override this with null.
  loadRole.mockReset();
  loadRole.mockResolvedValue("viewer");
});

// ---------------------------------------------------------------------------
// Transport invariants.
// ---------------------------------------------------------------------------
describe("requireAuth — transport invariants", () => {
  it("AUTH_DISABLED=true bypasses the gate (no session check)", async () => {
    const res = await call(makeApp(), "/runs", { method: "GET" }, { AUTH_DISABLED: "true" });
    expect(res.status).toBe(200);
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
  });

  it("OPTIONS preflight is admitted without a session", async () => {
    const res = await call(makeApp(), "/runs", { method: "OPTIONS" }, {});
    expect(res.status).toBe(200);
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
  });

  it("the SSE ticket transport authenticates via `?ticket=`", async () => {
    verifyTicket.mockResolvedValue("user-from-ticket");
    const res = await call(makeApp(), "/runs/abc/events?ticket=t0", { method: "GET" }, {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.userId).toBe("user-from-ticket");
    // Ticket path must NOT fall through to Bearer verification.
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
  });

  it("the collab /doc ticket transport authenticates via `?ticket=`", async () => {
    verifyTicket.mockResolvedValue("user-from-ticket");
    const res = await call(makeApp(), "/runs/abc/doc?ticket=t0", { method: "GET" }, {});
    expect(res.status).toBe(200);
    expect(verifyTicket).toHaveBeenCalled();
  });

  it("a missing/invalid ticket on the SSE path → 401", async () => {
    verifyTicket.mockResolvedValue(null);
    const res = await call(makeApp(), "/runs/abc/events?ticket=bad", { method: "GET" }, {});
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Bearer token — Authorization: Bearer <jwt>.
// ---------------------------------------------------------------------------
describe("requireAuth — Bearer token", () => {
  it("verifies the Bearer token and sets userId + userEmail", async () => {
    verifySupabaseJwt.mockResolvedValue({ sub: "uuid-1", email: "a@bowtie.com.hk" });
    const res = await call(
      makeApp(),
      "/runs",
      { method: "GET", headers: { authorization: "Bearer jwt-token" } },
      {},
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.userId).toBe("uuid-1");
    expect(json.userEmail).toBe("a@bowtie.com.hk");
    expect(verifySupabaseJwt).toHaveBeenCalledWith("jwt-token", expect.anything());
  });

  it("sets userId but leaves userEmail unset when the token has no email", async () => {
    verifySupabaseJwt.mockResolvedValue({ sub: "uuid-2", email: null });
    const res = await call(
      makeApp(),
      "/runs",
      { method: "GET", headers: { authorization: "Bearer jwt-token" } },
      {},
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
      {},
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when the Authorization header is absent", async () => {
    const res = await call(makeApp(), "/runs", { method: "GET" }, {});
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
      {},
    );
    expect(res.status).toBe(401);
    expect(verifySupabaseJwt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Provisioning gate: a cryptographically valid session whose app_user row is
// gone (deleted) or disabled is denied AT THE AUTH GATE, on every route — this
// is what makes admin delete/disable take effect on the target's next request
// instead of "whenever their access token happens to expire".
// ---------------------------------------------------------------------------
describe("requireAuth — provisioning gate (deleted/disabled users)", () => {
  const bearer = { method: "GET" as const, headers: { authorization: "Bearer tok" } };

  it("401s a valid Bearer session whose role resolves to null (deleted/disabled)", async () => {
    verifySupabaseJwt.mockResolvedValue({ sub: "deleted-1", email: "gone@gmail.com" });
    loadRole.mockResolvedValue(null);
    const res = await call(makeApp(), "/runs", bearer, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("admits a valid Bearer session with a provisioned role", async () => {
    verifySupabaseJwt.mockResolvedValue({ sub: "u-1", email: "a@bowtie.com.hk" });
    loadRole.mockResolvedValue("viewer");
    const res = await call(makeApp(), "/runs", bearer, {});
    expect(res.status).toBe(200);
    expect(loadRole).toHaveBeenCalledOnce();
  });

  it("401s a valid SSE ticket whose user was deleted/disabled after mint", async () => {
    verifyTicket.mockResolvedValue("deleted-1");
    loadRole.mockResolvedValue(null);
    const res = await call(makeApp(), "/runs/abc/events?ticket=t0", { method: "GET" }, {});
    expect(res.status).toBe(401);
  });

  it("does NOT consult loadRole when AUTH_DISABLED bypasses the gate", async () => {
    const res = await call(makeApp(), "/runs", { method: "GET" }, { AUTH_DISABLED: "true" });
    expect(res.status).toBe(200);
    expect(loadRole).not.toHaveBeenCalled();
  });
});
