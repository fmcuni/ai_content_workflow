import type { Context, Next } from "hono";

import type { Env } from "../index";
import { getAuth } from "./auth";
import { verifyTicket } from "./ticket";

export interface AuthVars {
  userId: string;
  /** Authenticated user's email — the compliance record-of-truth identity.
   * Set on the cookie/session path; absent on the SSE ticket path (the ticket
   * carries only the user id) and when AUTH_DISABLED bypasses the gate. */
  userEmail?: string;
  /** Effective RBAC role, resolved once per request and cached by
   * src/auth/authz.ts `loadRole`. Absent until the first `requireRole`/`loadRole`. */
  effectiveRole?: import("./authz").Role;
}

type AuthContext = Context<{ Bindings: Env; Variables: AuthVars }>;

/** Public paths that never require a session (auth endpoints + health). */
function isPublicPath(path: string): boolean {
  if (path === "/health" || path === "/db/ping") return false; // protected diagnostics
  return path === "/api/auth" || path.startsWith("/api/auth/");
}

/**
 * Backend auth gate. The backend Worker is publicly reachable on its
 * workers.dev URL, so it enforces sessions independently of the frontend.
 *
 * - REST: validates the same-origin session cookie (the Next proxy forwards it).
 * - SSE (paths ending in "/events") and the collab WebSocket (paths ending in
 *   "/doc"): opened cross-origin without the cookie, so they are authenticated
 *   by the short-lived `?ticket=` HMAC instead.
 * - `AUTH_DISABLED=true` bypasses the gate for local dev against the Python
 *   backend (which has no auth routes).
 */
export async function requireAuth(c: AuthContext, next: Next): Promise<Response | void> {
  if (c.env.AUTH_DISABLED === "true") return next();
  if (c.req.method === "OPTIONS") return next();

  const path = new URL(c.req.url).pathname;
  if (isPublicPath(path)) return next();

  // `/runs/:id/doc` is the collab WebSocket: opened cross-origin and cookie-less
  // (the browser cannot attach the better-auth session cookie to a WS upgrade),
  // so it is ticket-authed exactly like the SSE `/events` stream. Scope the `/doc`
  // match to `/runs/` so a future route ending in `/doc` can't accidentally
  // inherit ticket auth.
  if (path.endsWith("/events") || (path.startsWith("/runs/") && path.endsWith("/doc"))) {
    const ticket = c.req.query("ticket") ?? "";
    const userId = ticket ? await verifyTicket(c.env, ticket) : null;
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", userId);
    return next();
  }

  const { auth, sql } = getAuth(c.env);
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", session.user.id);
    c.set("userEmail", session.user.email);
  } finally {
    c.executionCtx.waitUntil(sql.end().catch(() => undefined));
  }
  return next();
}
