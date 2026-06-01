/**
 * Role-based authorization (RBAC) for the Workers backend.
 *
 * Roles are cumulative: viewer < editor < admin. A capability is
 * granted to a role iff that role's rank meets-or-exceeds the capability's
 * minimum-role rank. There is NO segregation of duties: an editor may approve
 * and publish their OWN run.
 *
 * The *effective* role layers a break-glass bootstrap on top of the stored
 * role: an email listed in BOOTSTRAP_ADMIN_EMAILS is always `admin`, so a fresh
 * DB (every user defaulting to `viewer`) is never locked out of role
 * management. Everything below derives authorization from the effective role.
 *
 * Identity comes from the session (set by src/auth/middleware.ts): `userEmail`
 * on the cookie/session path, `userId` on the SSE-ticket path. Role lookup
 * prefers the id (stable PK) and falls back to the email.
 */
import type { Context, MiddlewareHandler } from "hono";

import type { Env } from "../index";
import { withDb } from "../db/client";
import type { AuthVars } from "./middleware";

/** The Hono environment shape every authenticated route shares. */
type AuthzEnv = { Bindings: Env; Variables: AuthVars };

export const ROLES = ["viewer", "editor", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Cumulative rank — higher number = more capability. */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

/** Context variable key under which the resolved effective role is cached. */
const ROLE_CACHE_KEY = "effectiveRole" as const;

/** Narrow an arbitrary string to a Role, defaulting to "viewer". */
export function coerceRole(value: string | null | undefined): Role {
  return value !== null && value !== undefined && (ROLES as readonly string[]).includes(value)
    ? (value as Role)
    : "viewer";
}

/** True iff `value` is a valid role string (for request-body validation). */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Parse BOOTSTRAP_ADMIN_EMAILS (comma-separated) into a lowercased Set. Empty /
 * unset → empty Set. Whitespace around each entry is trimmed; blanks dropped.
 */
function bootstrapAdminEmails(env: Env): Set<string> {
  const raw = env.BOOTSTRAP_ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

/**
 * The effective role for a session: `admin` when the email is a bootstrap admin
 * (case-insensitive), otherwise the stored role (default "viewer" when null).
 *
 * Pure — unit-testable without an HTTP/DB harness.
 */
export function effectiveRole(
  storedRole: string | null | undefined,
  email: string | null | undefined,
  env: Env,
): Role {
  if (email !== null && email !== undefined && email.trim().length > 0) {
    if (bootstrapAdminEmails(env).has(email.trim().toLowerCase())) {
      return "admin";
    }
  }
  return coerceRole(storedRole);
}

/** True iff `role` meets-or-exceeds the `required` role on the cumulative scale. */
export function roleMeetsRequirement(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

type AuthzContext = Context<AuthzEnv>;

/**
 * Load the effective role for the current session, caching it on the context so
 * repeated middleware / handler reads hit the DB once per request.
 *
 * Resolution: SELECT role FROM content_tool."user" WHERE id = userId (else by
 * email), then apply `effectiveRole`. Returns null when there is NO session
 * identity at all (neither id nor email) — the caller maps that to 401.
 */
export async function loadRole(c: AuthzContext): Promise<Role | null> {
  const cached = c.get(ROLE_CACHE_KEY);
  if (cached !== undefined) {
    return cached;
  }

  const userId = c.get("userId");
  const userEmail = c.get("userEmail");
  const hasIdentity =
    (typeof userId === "string" && userId.length > 0) ||
    (typeof userEmail === "string" && userEmail.length > 0);
  if (!hasIdentity) {
    return null;
  }

  const storedRole = await withDb(c.env, c.executionCtx, async (sql) => {
    if (typeof userId === "string" && userId.length > 0) {
      const rows = await sql<{ role: string | null }[]>`
        SELECT role FROM content_tool."user" WHERE id = ${userId} LIMIT 1
      `;
      if (rows[0] !== undefined) {
        return rows[0].role;
      }
    }
    if (typeof userEmail === "string" && userEmail.length > 0) {
      const rows = await sql<{ role: string | null }[]>`
        SELECT role FROM content_tool."user" WHERE email = ${userEmail} LIMIT 1
      `;
      return rows[0]?.role ?? null;
    }
    return null;
  });

  const resolved = effectiveRole(storedRole, userEmail, c.env);
  c.set(ROLE_CACHE_KEY, resolved);
  return resolved;
}

/**
 * Hono middleware factory: gate the route behind a minimum role.
 *
 * - No session identity at all → 401 (mirrors src/auth/middleware.ts, which
 *   already gates every non-public route; this is defense in depth).
 * - Authenticated but below the bar → 403 with the repo's flat error body.
 * - At/above the bar → proceeds.
 */
export function requireRole(required: Role): MiddlewareHandler<AuthzEnv> {
  return async (c, next) => {
    const role = await loadRole(c);
    if (role === null) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!roleMeetsRequirement(role, required)) {
      return c.json(
        {
          error: "forbidden",
          message: `requires ${required} role`,
          required_role: required,
        },
        403,
      );
    }
    return next();
  };
}
