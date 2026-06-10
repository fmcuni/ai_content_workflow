/**
 * Security regression tests for two auth-bypass hardenings:
 *
 *  1. The `/api/auth-ticket` handler must NEVER mint a ticket when no userId is
 *     bound to the context (e.g. the AUTH_DISABLED bypass leaves it unset). It
 *     must 401 instead — otherwise it hands out a valid `undefined.<exp>.<sig>`
 *     ticket that the SSE/collab layer accepts.
 *  2. The `AUTH_DISABLED` escape hatch must only be honored in a non-production
 *     runtime. In a production-like env (SUPABASE_URL present) it must throw.
 *
 * The handler is reproduced here as a tiny Hono app with the SAME guard +
 * the REAL mintTicket, so the test exercises the actual mint path without
 * booting the full app (index.ts wires routers/workflows we don't need).
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { Env } from "../index";
import { authDisabledHonored, isProductionLikeEnv } from "./middleware";
import { mintTicket, verifyTicket } from "./ticket";

type Vars = { userId?: string };

/** Mirrors the `/api/auth-ticket` handler region in src/index.ts. */
function makeTicketApp(boundUserId: string | undefined): Hono<{ Bindings: Env; Variables: Vars }> {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  // Stand in for requireAuth: bind (or deliberately omit) userId.
  app.use("*", async (c, next) => {
    if (boundUserId !== undefined) c.set("userId", boundUserId);
    await next();
  });
  app.get("/api/auth-ticket", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const ticket = await mintTicket(c.env, userId);
    return c.json({ ticket });
  });
  return app;
}

const env = { AUTH_SECRET: "test-secret-not-a-real-key" } as Env;

describe("/api/auth-ticket handler — userId guard", () => {
  it("401s and mints NO ticket when userId is absent (AUTH_DISABLED branch)", async () => {
    const res = await makeTicketApp(undefined).request("https://api.test/api/auth-ticket", {}, env);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ error: "unauthorized" });
    expect(json.ticket).toBeUndefined();
  });

  it("mints a valid ticket on the happy path (userId present)", async () => {
    const res = await makeTicketApp("user-7").request("https://api.test/api/auth-ticket", {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ticket: string };
    expect(typeof json.ticket).toBe("string");
    // The minted ticket is genuinely bound to the user and verifies.
    expect(await verifyTicket(env, json.ticket)).toBe("user-7");
    // And it is NOT the forged "undefined.*" shape.
    expect(json.ticket.startsWith("undefined.")).toBe(false);
  });
});

describe("AUTH_DISABLED is only honored in non-production runtimes", () => {
  it("is silent and honored in a local/dev env (no SUPABASE_URL)", () => {
    expect(isProductionLikeEnv({ AUTH_DISABLED: "true" } as Env)).toBe(false);
    expect(authDisabledHonored({ AUTH_DISABLED: "true" } as Env)).toBe(true);
  });

  it("throws LOUDLY in a production-like env (SUPABASE_URL present)", () => {
    const prodEnv = { AUTH_DISABLED: "true", SUPABASE_URL: "https://x.supabase.co" } as Env;
    expect(isProductionLikeEnv(prodEnv)).toBe(true);
    expect(() => authDisabledHonored(prodEnv)).toThrow(/production-like/i);
  });

  it("returns false (no bypass) when AUTH_DISABLED is unset", () => {
    expect(authDisabledHonored({} as Env)).toBe(false);
    expect(authDisabledHonored({ SUPABASE_URL: "https://x.supabase.co" } as Env)).toBe(false);
  });
});
