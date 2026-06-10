import type { Context, Next } from "hono";

import type { Env } from "../index";
import { getAuth } from "./auth";
import { verifySupabaseJwt } from "./jwt";
import { verifyTicket } from "./ticket";

export interface AuthVars {
  userId: string;
  /** Authenticated user's email — the compliance record-of-truth identity.
   * Set on the cookie/session path; absent on the SSE ticket path (the ticket
   * carries only the user id) and when AUTH_DISABLED bypasses the gate. */
  userEmail?: string;
  /** Effective RBAC role, resolved once per request and cached by
   * src/auth/authz.ts `loadRole`. Absent until the first `requireRole`/`loadRole`.
   * `null` is a cached *denial* (authenticated but unprovisioned). */
  effectiveRole?: import("./authz").Role | null;
}

type AuthContext = Context<{ Bindings: Env; Variables: AuthVars }>;

/** Public paths that never require a session (auth endpoints + health). */
function isPublicPath(path: string): boolean {
  if (path === "/health" || path === "/db/ping") return false; // protected diagnostics
  return path === "/api/auth" || path.startsWith("/api/auth/");
}

/** Extract the bearer token from an `Authorization: Bearer <jwt>` header. */
function bearerToken(c: AuthContext): string | null {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/**
 * Validate the request session via Supabase JWT (`AUTH_PROVIDER="supabase"`).
 *
 * The frontend attaches the Supabase access token as `Authorization: Bearer
 * <jwt>` on every REST call; we verify it with the JWKS/HS256 verifier
 * (src/auth/jwt.ts) and bind `userId` (= `sub`) + `userEmail` (= `email`). On a
 * missing/invalid/expired token this returns the repo's flat 401 body — the same
 * shape the better-auth path returns. No DB hop here: the cookie session lookup
 * is replaced by stateless JWT verification.
 */
async function validateSupabaseSession(c: AuthContext): Promise<Response | void> {
  const token = bearerToken(c);
  const identity = token ? await verifySupabaseJwt(token, c.env) : null;
  if (identity === null) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", identity.sub);
  if (identity.email !== null) {
    c.set("userEmail", identity.email);
  }
}

/**
 * Validate the request session via the legacy better-auth cookie (the default
 * provider). Forwarded same-origin by the Next proxy.
 */
async function validateBetterAuthSession(c: AuthContext): Promise<Response | void> {
  const { auth, sql } = getAuth(c.env);
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", session.user.id);
    c.set("userEmail", session.user.email);
  } finally {
    c.executionCtx.waitUntil(sql.end().catch(() => undefined));
  }
}

/**
 * Backend auth gate. The backend Worker is publicly reachable on its
 * workers.dev URL, so it enforces sessions independently of the frontend.
 *
 * - REST: validates the session per `AUTH_PROVIDER`. Default (`better-auth`)
 *   reads the same-origin session cookie (the Next proxy forwards it);
 *   `supabase` verifies an `Authorization: Bearer <jwt>` Supabase access token.
 * - SSE (paths ending in "/events") and the collab WebSocket (paths ending in
 *   "/doc"): opened cross-origin without the cookie/header, so they are
 *   authenticated by the short-lived `?ticket=` HMAC instead — unchanged across
 *   both providers (the ticket is minted after this session check passes).
 * - `AUTH_DISABLED=true` bypasses the gate for local dev against the Python
 *   backend (which has no auth routes).
 */
export async function requireAuth(c: AuthContext, next: Next): Promise<Response | void> {
  if (c.env.AUTH_DISABLED === "true") return next();
  if (c.req.method === "OPTIONS") return next();

  const path = new URL(c.req.url).pathname;
  if (isPublicPath(path)) return next();

  // `/runs/:id/doc` is the collab WebSocket: opened cross-origin and cookie-less
  // (the browser cannot attach the session cookie / Bearer header to a WS
  // upgrade), so it is ticket-authed exactly like the SSE `/events` stream. This
  // transport is provider-agnostic — the ticket is HMAC-minted by the backend
  // after a REST session check, so it works identically on the supabase branch.
  // Scope the `/doc` match to `/runs/` so a future route ending in `/doc` can't
  // accidentally inherit ticket auth.
  if (path.endsWith("/events") || (path.startsWith("/runs/") && path.endsWith("/doc"))) {
    const ticket = c.req.query("ticket") ?? "";
    const userId = ticket ? await verifyTicket(c.env, ticket) : null;
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", userId);
    return next();
  }

  const denied =
    c.env.AUTH_PROVIDER === "supabase"
      ? await validateSupabaseSession(c)
      : await validateBetterAuthSession(c);
  if (denied !== undefined) return denied;
  return next();
}
