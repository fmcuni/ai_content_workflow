/**
 * Role-based authorization (RBAC) for the Workers backend.
 *
 * Roles are cumulative: viewer < author < reviewer < admin. A capability is
 * granted to a role iff that role's rank meets-or-exceeds the capability's
 * minimum-role rank. There is NO segregation of duties: a reviewer may approve
 * and publish their OWN run.
 *
 * The role set was widened from the legacy 3-role model (viewer < editor <
 * admin). The old `editor` tier — create/HITL/publish — maps onto the new
 * `reviewer` tier; content authoring splits down into the new `author` tier.
 * `coerceRole` aliases a stored legacy "editor" → "reviewer" so rows written
 * under the old model (and the still-active better-auth path before the
 * AUTH_PROVIDER cutover) keep their authority. This matches the WS4
 * user-migration mapping (admin→admin, editor→reviewer, viewer→author).
 *
 * The *effective* role layers a break-glass bootstrap on top of the stored
 * role: an admin-eligible email listed in BOOTSTRAP_ADMIN_EMAILS is always
 * `admin`, so a fresh DB (every user defaulting to `viewer`) is never locked out
 * of role management. The bootstrap grant is ADMIN-only — a non-admin-eligible
 * email in the list grants NOTHING (it does not silently confer reviewer), so
 * the escape hatch can never become an invite-only bypass. Everything below
 * derives authorization from the effective role.
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

export const ROLES = ["viewer", "author", "reviewer", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Cumulative rank — higher number = more capability. */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  viewer: 0,
  author: 1,
  reviewer: 2,
  admin: 3,
};

/**
 * Legacy stored-role aliases. The pre-4-role model persisted "editor" for the
 * create/HITL/publish tier; map it onto "reviewer" so existing rows (and the
 * better-auth path before cutover) retain that authority. Aliases apply only to
 * `coerceRole` (reading stored/legacy values) — NOT to `isRole`, so an admin can
 * never *assign* the dead "editor" token via the role-change endpoint.
 */
const LEGACY_ROLE_ALIASES: Readonly<Record<string, Role>> = {
  editor: "reviewer",
};

/** Context variable key under which the resolved effective role is cached. */
const ROLE_CACHE_KEY = "effectiveRole" as const;

/**
 * Narrow an arbitrary string to a Role, defaulting to "viewer". A recognized
 * legacy alias (e.g. "editor") resolves to its modern equivalent.
 */
export function coerceRole(value: string | null | undefined): Role {
  if (value === null || value === undefined) {
    return "viewer";
  }
  if ((ROLES as readonly string[]).includes(value)) {
    return value as Role;
  }
  return LEGACY_ROLE_ALIASES[value] ?? "viewer";
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

/** Default domains whose users may hold the `admin` role. */
const DEFAULT_ADMIN_EMAIL_DOMAINS = "bowtie.com.hk,bowtie.com.sg";

/**
 * Domains eligible for the `admin` role, from ADMIN_EMAIL_DOMAINS (comma-
 * separated, lowercased) or the bowtie.com.hk/sg default. Configurable without a
 * code deploy, mirroring ALLOWED_EMAIL_DOMAINS.
 */
function adminEmailDomains(env: Env): Set<string> {
  const raw = env.ADMIN_EMAIL_DOMAINS ?? DEFAULT_ADMIN_EMAIL_DOMAINS;
  return new Set(
    raw
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0),
  );
}

/**
 * Whether `email` may hold the `admin` role. Policy: only bowtie.com.hk /
 * bowtie.com.sg staff may be admins — an invited external user (e.g. a gmail
 * account) can log in and hold any lower role, but never `admin`. Enforced both
 * here (resolution) and at assignment time in routes/admin.ts.
 */
export function isAdminEligibleEmail(email: string | null | undefined, env: Env): boolean {
  if (email === null || email === undefined) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 && adminEmailDomains(env).has(domain);
}

/**
 * The effective role for a session: `admin` when the email is an admin-eligible
 * bootstrap admin (case-insensitive); otherwise the stored role. A bootstrap
 * entry whose email is NOT admin-eligible is ignored (grants nothing) — see the
 * file header for why this matters for invite-only enforcement.
 *
 * `unprovisionedFloor` is returned when there is NO stored role (null/undefined,
 * i.e. no `app_user` / legacy `user` row). It defaults to `"viewer"` to preserve
 * the legacy better-auth behavior, but the supabase path passes `null` so that an
 * authenticated-but-unprovisioned user is DENIED rather than silently granted
 * read access — invite-only is enforced here at the authorization layer, since
 * Google OAuth (unlike magic-link's `shouldCreateUser:false`) auto-creates a
 * GoTrue user for anyone who signs in.
 *
 * Pure — unit-testable without an HTTP/DB harness.
 */
export function effectiveRole(
  storedRole: string | null | undefined,
  email: string | null | undefined,
  env: Env,
  unprovisionedFloor: Role | null = "viewer",
): Role | null {
  const isBootstrap =
    email !== null &&
    email !== undefined &&
    email.trim().length > 0 &&
    bootstrapAdminEmails(env).has(email.trim().toLowerCase());

  // Break-glass bootstrap is an ADMIN grant and applies ONLY to admin-eligible
  // emails. A non-eligible entry (e.g. a gmail account) grants NOTHING — it must
  // NOT be silently downgraded to reviewer, or the admin escape hatch becomes an
  // invite-only bypass: a deleted/unprovisioned external account would retain
  // access just by being listed, surviving account deletion entirely (Google
  // OAuth re-creates the GoTrue user on every login). When the bootstrap grant
  // does not apply, resolution falls through to the stored role exactly as if the
  // email were not listed at all.
  if (isBootstrap && isAdminEligibleEmail(email, env)) {
    return "admin";
  }

  if (storedRole === null || storedRole === undefined) {
    return unprovisionedFloor;
  }

  let resolved = coerceRole(storedRole);
  // Domain rule (hard ceiling): only bowtie.com.hk / bowtie.com.sg emails may be
  // admin. A non-eligible email with a stored "admin" role is capped to the
  // highest non-admin role. Defense in depth alongside the assignment-time check
  // in routes/admin.ts.
  if (resolved === "admin" && !isAdminEligibleEmail(email, env)) {
    resolved = "reviewer";
  }
  return resolved;
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
 * Resolution is provider-aware so `main` stays deployable under the flag:
 *   - `AUTH_PROVIDER="supabase"` reads the Supabase-backed `content_tool.app_user`
 *     table (id = the auth user uuid, else email).
 *   - any other value (default `better-auth`) reads the legacy
 *     `content_tool."user"` table exactly as before.
 * Both paths prefer the id (stable PK) and fall back to email, then apply
 * `effectiveRole` (bootstrap-admin override + default "viewer"). Returns null
 * when there is NO session identity at all (neither id nor email) — the caller
 * maps that to 401.
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

  const useAppUser = c.env.AUTH_PROVIDER === "supabase";

  type StoredRow = { role: string | null; status?: string | null };
  const stored = await withDb(c.env, c.executionCtx, async (sql): Promise<StoredRow | null> => {
    if (typeof userId === "string" && userId.length > 0) {
      const rows = useAppUser
        ? await sql<StoredRow[]>`
            SELECT role, status FROM content_tool.app_user WHERE id = ${userId} LIMIT 1
          `
        : await sql<StoredRow[]>`
            SELECT role FROM content_tool."user" WHERE id = ${userId} LIMIT 1
          `;
      if (rows[0] !== undefined) {
        return rows[0];
      }
    }
    if (typeof userEmail === "string" && userEmail.length > 0) {
      const rows = useAppUser
        ? await sql<StoredRow[]>`
            SELECT role, status FROM content_tool.app_user WHERE email = ${userEmail} LIMIT 1
          `
        : await sql<StoredRow[]>`
            SELECT role FROM content_tool."user" WHERE email = ${userEmail} LIMIT 1
          `;
      return rows[0] ?? null;
    }
    return null;
  });

  // Supabase path: an authenticated user with no app_user row is DENIED (null),
  // not floored to "viewer" — Google OAuth auto-creates GoTrue users, so the
  // invite-only gate lives here. Legacy better-auth path keeps the viewer floor.
  //
  // status='disabled' is likewise a DENIAL: the GoTrue ban only blocks new
  // sign-ins/refreshes, so live access tokens must be cut off here, per request.
  // A disabled row resolves exactly like a missing row — except the bootstrap
  // break-glass (admin-eligible email in BOOTSTRAP_ADMIN_EMAILS) still wins
  // inside `effectiveRole`, so lockout recovery survives a mass-disable.
  const isDisabled = useAppUser && stored !== null && stored.status === "disabled";
  const resolved = isDisabled
    ? effectiveRole(null, userEmail, c.env, null)
    : effectiveRole(stored?.role ?? null, userEmail, c.env, useAppUser ? null : "viewer");
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
