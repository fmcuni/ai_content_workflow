/**
 * Admin-only user-management routes (RBAC). Mounted at /admin; every route is
 * gated by `requireRole("admin")` at registration in src/index.ts.
 *
 *   GET    /admin/users                  → list users (stored role)
 *   POST   /admin/users                  → create + invite a user
 *   PUT    /admin/users/:id/role         → set a user's stored role (enum-validated)
 *   POST   /admin/users/:id/disable      → ban in GoTrue + status='disabled'
 *   POST   /admin/users/:id/enable       → unban in GoTrue + status='active'
 *   DELETE /admin/users/:id              → delete GoTrue user + app_user row
 *   POST   /admin/users/:id/revoke-sessions → GoTrue admin sign-out (all sessions)
 *
 * The user store is `content_tool.app_user` and GoTrue (Supabase Auth) is the
 * identity provider. The GoTrue-backed routes (create/disable/enable/delete/
 * revoke) surface 501 when GoTrue is unconfigured (no SUPABASE_SERVICE_ROLE_KEY).
 *
 * Every mutation is audited via the structured logger (actor, target, old→new).
 * The list returns the STORED role (not the effective role) so an admin sees and
 * corrects what is actually persisted — the bootstrap override is a runtime lens.
 *
 * SECURITY: the Supabase `service_role` key NEVER appears here directly — it is
 * read and used only inside src/auth/gotrue-admin.ts (REST headers). This module
 * passes `c.env` to those helpers and never logs or returns the key.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Sql } from "postgres";

import type { Env } from "../index";
import { withDb } from "../db/client";
import type { AuthVars } from "../auth/middleware";
import { isRole, isAdminEligibleEmail, type Role } from "../auth/authz";
import { resolveActorIdentity } from "./identity";
import { auditLog } from "../auth/audit";
import {
  GoTrueAdminError,
  DISABLE_BAN_DURATION,
  ENABLE_BAN_DURATION,
  createUser,
  deleteUser,
  findUserByEmail,
  listUsers,
  updateUser,
} from "../auth/gotrue-admin";
import type { GoTrueUser } from "../auth/gotrue-admin";

/** A row from the `content_tool.app_user` table. */
interface AppUserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: string | null;
  status: string | null;
  last_sign_in_at: string | null;
}

interface RoleUpdateBody {
  role?: unknown;
}

interface CreateUserBody {
  email?: unknown;
  role?: unknown;
}

/** The list/response shape the web UI consumes (superset of `AdminUser`). */
interface AdminUserResponse {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status?: string;
  last_sign_in_at?: string | null;
  confirmed?: boolean;
}

/** The Hono environment shape every admin route shares. */
type AdminEnv = { Bindings: Env; Variables: AuthVars };
type AdminContext = Context<AdminEnv>;

const adminRouter = new Hono<AdminEnv>();

/** Resolve the audit actor from the verified session (never the payload). */
function actorOf(c: { get: (k: "userEmail" | "userId") => string | undefined }): string {
  return resolveActorIdentity({ userEmail: c.get("userEmail"), userId: c.get("userId") }, null);
}

/**
 * Map a GoTrueAdminError to the flat error body + status the rest of the router
 * uses. `not_configured` surfaces as 501 (the route needs GoTrue but
 * SUPABASE_SERVICE_ROLE_KEY/SUPABASE_URL is unset). The message is always secret-free.
 */
function gotrueErrorResponse(e: GoTrueAdminError): { body: Record<string, string>; status: 400 | 404 | 409 | 501 | 502 } {
  switch (e.code) {
    case "not_configured":
      return { body: { error: "supabase_not_configured", message: e.message }, status: 501 };
    case "invalid_input":
      return { body: { error: "invalid_input", message: e.message }, status: 400 };
    case "network_error":
      return { body: { error: "gotrue_unreachable", message: e.message }, status: 502 };
    case "gotrue_error":
    default: {
      // Reflect a 404 (user gone) but keep other GoTrue errors as 502 so we
      // never echo a raw upstream 5xx detail beyond the safe message.
      const status = e.status === 404 ? 404 : 502;
      return { body: { error: "gotrue_error", message: e.message }, status };
    }
  }
}

/**
 * GoTrue's "this email already has an identity" rejection (422 on current
 * Supabase; the message is the stable signal across versions). The create
 * route treats it as "adopt the existing identity", not an error.
 */
function isAlreadyRegistered(e: GoTrueAdminError): boolean {
  return (
    e.code === "gotrue_error" &&
    (/already (been )?registered|email.{0,2}exists/i.test(e.message) || e.status === 422)
  );
}

/** GoTrue marks confirmation on either field depending on version/flow. */
function isConfirmed(u: GoTrueUser): boolean {
  return Boolean(u.email_confirmed_at ?? u.confirmed_at);
}

// ---------------------------------------------------------------------------
// GET /admin/users — list users (stored role)
// ---------------------------------------------------------------------------
adminRouter.get("/users", async (c) => {
  // app_user is the source of truth for role/status; enrich with
  // GoTrue (last-sign-in, confirmed). GoTrue enrichment is best-effort — if it
  // is unconfigured/unreachable we still return the app_user list.
  const rows = await withDb(c.env, c.executionCtx, (sql: Sql) =>
    sql<AppUserRow[]>`
      SELECT id, email, display_name, role, status, last_sign_in_at
      FROM content_tool.app_user
      ORDER BY email ASC
    `,
  );

  const gotrueById = new Map<string, { lastSignIn: string | null; confirmed: boolean }>();
  try {
    const users = await listUsers(c.env);
    for (const u of users) {
      gotrueById.set(u.id, {
        lastSignIn: u.last_sign_in_at ?? null,
        confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
      });
    }
  } catch (e: unknown) {
    if (!(e instanceof GoTrueAdminError)) throw e;
    // Best-effort enrichment only — proceed with DB rows.
  }

  const out: AdminUserResponse[] = rows.map((r) => {
    const enrich = gotrueById.get(r.id);
    return {
      id: r.id,
      email: r.email,
      name: r.display_name,
      role: (r.role ?? "viewer") as Role,
      status: r.status ?? "active",
      last_sign_in_at: enrich?.lastSignIn ?? r.last_sign_in_at ?? null,
      confirmed: enrich?.confirmed ?? false,
    };
  });
  return c.json(out);
});

// ---------------------------------------------------------------------------
// POST /admin/users — create + invite a user
// ---------------------------------------------------------------------------
adminRouter.post("/users", async (c) => {
  const body = await c.req.json<CreateUserBody>().catch(() => ({}) as CreateUserBody);
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email.length === 0) {
    return c.json({ error: "invalid_input", message: "email is required" }, 400);
  }
  // Default new users to the lowest privilege; an explicit role must be valid.
  const role: Role = body.role === undefined ? "viewer" : isRole(body.role) ? body.role : "viewer";
  if (body.role !== undefined && !isRole(body.role)) {
    return c.json(
      { error: "invalid_role", message: "role must be one of viewer, author, reviewer, admin" },
      400,
    );
  }
  // Domain rule: only bowtie.com.hk / bowtie.com.sg emails may be admin.
  if (role === "admin" && !isAdminEligibleEmail(email, c.env)) {
    return c.json(
      {
        error: "admin_domain_forbidden",
        message: "the admin role requires a bowtie.com.hk or bowtie.com.sg email",
      },
      422,
    );
  }

  try {
    // Admin-create the GoTrue user directly (pre-confirmed, NO email is sent —
    // GoTrue's shared email rate limit made /invite 502, and provisioning never
    // needed the email: Google OAuth auto-links on the verified address). When
    // the GoTrue identity already exists, ADOPT it instead of failing: Google
    // OAuth auto-creates an identity for anyone who signs in, so a previously
    // deleted (or never-provisioned) user who tried to log in would otherwise be
    // impossible to (re-)add — GoTrue rejects the create with
    // "A user with this email address has already been registered".
    let gotrueUser: GoTrueUser;
    let adoptedExisting = false;
    try {
      gotrueUser = await createUser(c.env, email);
    } catch (e: unknown) {
      if (!(e instanceof GoTrueAdminError) || !isAlreadyRegistered(e)) throw e;
      const existing = await findUserByEmail(c.env, email);
      if (existing === null) throw e; // registered yet not findable — surface as-is
      gotrueUser = existing;
      adoptedExisting = true;
    }

    // Insert (or adopt) the app_user row with the chosen role. The stale-email
    // purge covers a row left behind under a DIFFERENT GoTrue id (delete +
    // Google re-login mints a new id; email has a unique index, so the insert
    // would otherwise conflict). ON CONFLICT keeps the id path idempotent and
    // re-activates a previously disabled row — re-adding IS the operator's
    // explicit intent to restore access.
    const inserted = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
      await sql`
        DELETE FROM content_tool.app_user
        WHERE lower(email) = lower(${gotrueUser.email ?? email}) AND id <> ${gotrueUser.id}
      `;
      const rows = await sql<AppUserRow[]>`
        INSERT INTO content_tool.app_user (id, email, role, status)
        VALUES (${gotrueUser.id}, ${gotrueUser.email ?? email}, ${role}, 'active')
        ON CONFLICT (id) DO UPDATE
          SET email = EXCLUDED.email, role = EXCLUDED.role, status = EXCLUDED.status,
              updated_at = now()
        RETURNING id, email, display_name, role, status, last_sign_in_at
      `;
      return rows[0]!;
    });

    auditLog("rbac.user_create", {
      actor: actorOf(c),
      target_id: inserted.id,
      target_email: inserted.email,
      new_role: role,
      adopted_existing_identity: adoptedExisting,
    });

    const out: AdminUserResponse = {
      id: inserted.id,
      email: inserted.email,
      name: inserted.display_name,
      role: (inserted.role ?? role) as Role,
      status: inserted.status ?? "active",
      confirmed: isConfirmed(gotrueUser),
    };
    return c.json(out, 201);
  } catch (e: unknown) {
    if (e instanceof GoTrueAdminError) {
      const { body: errBody, status } = gotrueErrorResponse(e);
      return c.json(errBody, status);
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// PUT /admin/users/:id/role — set a user's stored role (provider-aware writes)
// ---------------------------------------------------------------------------
adminRouter.put("/users/:id/role", async (c) => {
  const targetId = c.req.param("id");
  const body = await c.req.json<RoleUpdateBody>().catch(() => ({}) as RoleUpdateBody);

  if (!isRole(body.role)) {
    return c.json(
      { error: "invalid_role", message: "role must be one of viewer, author, reviewer, admin" },
      400,
    );
  }
  const newRole: Role = body.role;

  // Self-demotion lockout guard: an admin must not strip their OWN admin role,
  // which could lock the system out of role management. Comparing the target id
  // to the acting session user id is simpler and race-free vs counting admins;
  // BOOTSTRAP_ADMIN_EMAILS remains the ultimate recovery path either way.
  const actingUserId = c.get("userId");
  if (
    typeof actingUserId === "string" &&
    actingUserId.length > 0 &&
    actingUserId === targetId &&
    newRole !== "admin"
  ) {
    return c.json(
      { error: "self_demotion_forbidden", message: "an admin cannot remove their own admin role" },
      409,
    );
  }

  const actor = actorOf(c);

  const outcome = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const before = await sql<AppUserRow[]>`
      SELECT id, email, display_name, role, status, last_sign_in_at
      FROM content_tool.app_user WHERE id = ${targetId} LIMIT 1
    `;
    const existing = before[0];
    if (existing === undefined) return { kind: "not_found" as const };
    // Domain rule: only bowtie.com.hk / bowtie.com.sg emails may be admin.
    if (newRole === "admin" && !isAdminEligibleEmail(existing.email, c.env)) {
      return { kind: "admin_domain_forbidden" as const };
    }
    const rows = await sql<AppUserRow[]>`
      UPDATE content_tool.app_user
      SET role = ${newRole}, updated_at = now()
      WHERE id = ${targetId}
      RETURNING id, email, display_name, role, status, last_sign_in_at
    `;
    const u = rows[0]!;
    return {
      kind: "ok" as const,
      oldRole: existing.role ?? "viewer",
      id: u.id,
      email: u.email,
      name: u.display_name,
      role: (u.role ?? "viewer") as Role,
    };
  });

  if (outcome.kind === "not_found") {
    return c.json({ detail: "user not found" }, 404);
  }
  if (outcome.kind === "admin_domain_forbidden") {
    return c.json(
      {
        error: "admin_domain_forbidden",
        message: "the admin role requires a bowtie.com.hk or bowtie.com.sg email",
      },
      422,
    );
  }

  auditLog("rbac.role_change", {
    actor,
    target_id: outcome.id,
    target_email: outcome.email,
    old_role: outcome.oldRole,
    new_role: newRole,
  });

  const out: AdminUserResponse = {
    id: outcome.id,
    email: outcome.email,
    name: outcome.name,
    role: outcome.role,
  };
  return c.json(out);
});

// ---------------------------------------------------------------------------
// Shared helper: load the target app_user row (supabase path), 404 if absent.
// ---------------------------------------------------------------------------
async function loadAppUser(c: AdminContext, targetId: string): Promise<AppUserRow | null> {
  return withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const rows = await sql<AppUserRow[]>`
      SELECT id, email, display_name, role, status, last_sign_in_at
      FROM content_tool.app_user WHERE id = ${targetId} LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

// ---------------------------------------------------------------------------
// POST /admin/users/:id/disable  &  /enable — GoTrue ban/unban + status
// ---------------------------------------------------------------------------
function registerDisableEnable(action: "disable" | "enable"): void {
  adminRouter.post(`/users/:id/${action}`, async (c) => {
    const targetId = c.req.param("id");
    const existing = await loadAppUser(c, targetId);
    if (existing === null) return c.json({ detail: "user not found" }, 404);

    const disabling = action === "disable";
    try {
      await updateUser(c.env, targetId, {
        ban_duration: disabling ? DISABLE_BAN_DURATION : ENABLE_BAN_DURATION,
      });
    } catch (e: unknown) {
      if (e instanceof GoTrueAdminError) {
        const { body, status } = gotrueErrorResponse(e);
        return c.json(body, status);
      }
      throw e;
    }

    // Disabling also revokes refresh tokens (best-effort): the ban blocks NEW
    // sign-ins, the middleware provisioning gate kills live access tokens on
    // their next request, and this DB-level session kill cuts the refresh path
    // so the session can't silently mint a fresh access token in the meantime.
    // A failure here is non-fatal — the other two layers already deny.
    if (disabling) {
      try {
        await withDb(c.env, c.executionCtx, (sql: Sql) =>
          sql`SELECT content_tool.revoke_auth_sessions(${targetId}::uuid)`,
        );
      } catch {
        // non-fatal by design
      }
    }

    const newStatus = disabling ? "disabled" : "active";
    const updated = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
      const rows = await sql<AppUserRow[]>`
        UPDATE content_tool.app_user
        SET status = ${newStatus}, updated_at = now()
        WHERE id = ${targetId}
        RETURNING id, email, display_name, role, status, last_sign_in_at
      `;
      return rows[0]!;
    });

    auditLog(disabling ? "rbac.user_disable" : "rbac.user_enable", {
      actor: actorOf(c),
      target_id: existing.id,
      target_email: existing.email,
      old_status: existing.status ?? "active",
      new_status: newStatus,
    });

    const out: AdminUserResponse = {
      id: updated.id,
      email: updated.email,
      name: updated.display_name,
      role: (updated.role ?? "viewer") as Role,
      status: updated.status ?? newStatus,
    };
    return c.json(out);
  });
}
registerDisableEnable("disable");
registerDisableEnable("enable");

// ---------------------------------------------------------------------------
// DELETE /admin/users/:id — delete GoTrue user + app_user row
// ---------------------------------------------------------------------------
adminRouter.delete("/users/:id", async (c) => {
  const targetId = c.req.param("id");

  // Self-delete guard: an admin must not delete their OWN account (mirrors the
  // self-demotion lockout). BOOTSTRAP_ADMIN_EMAILS remains the recovery path.
  const actingUserId = c.get("userId");
  if (typeof actingUserId === "string" && actingUserId.length > 0 && actingUserId === targetId) {
    return c.json(
      { error: "self_delete_forbidden", message: "an admin cannot delete their own account" },
      409,
    );
  }

  const existing = await loadAppUser(c, targetId);
  if (existing === null) return c.json({ detail: "user not found" }, 404);

  try {
    await deleteUser(c.env, targetId);
  } catch (e: unknown) {
    if (e instanceof GoTrueAdminError) {
      // A 404 from GoTrue (already gone) is tolerated — proceed to drop the row.
      if (e.code !== "gotrue_error" || e.status !== 404) {
        const { body, status } = gotrueErrorResponse(e);
        return c.json(body, status);
      }
    } else {
      throw e;
    }
  }

  await withDb(c.env, c.executionCtx, (sql: Sql) =>
    sql`DELETE FROM content_tool.app_user WHERE id = ${targetId}`,
  );

  auditLog("rbac.user_delete", {
    actor: actorOf(c),
    target_id: existing.id,
    target_email: existing.email,
    old_role: existing.role ?? "viewer",
  });

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// POST /admin/users/:id/revoke-sessions — sign the user out of all sessions
// ---------------------------------------------------------------------------
adminRouter.post("/users/:id/revoke-sessions", async (c) => {
  const targetId = c.req.param("id");
  const existing = await loadAppUser(c, targetId);
  if (existing === null) return c.json({ detail: "user not found" }, 404);

  // Two cuts make revocation complete (GoTrue's admin REST has NO per-user
  // sign-out endpoint, so both happen in the DB):
  //   1. revoke_auth_sessions deletes the user's auth.sessions/refresh_tokens
  //      (SECURITY DEFINER fn) — no new access token can be minted by refresh.
  //   2. sessions_revoked_at makes the per-request gate (auth/authz.ts
  //      loadRole) deny every access token issued before now — live tokens die
  //      on the target's next request instead of at expiry (~1h).
  // A fresh sign-in afterwards mints a later-iat token and works normally.
  await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    await sql`SELECT content_tool.revoke_auth_sessions(${targetId}::uuid)`;
    await sql`UPDATE content_tool.app_user SET sessions_revoked_at = now() WHERE id = ${targetId}`;
  });

  auditLog("rbac.user_revoke_sessions", {
    actor: actorOf(c),
    target_id: existing.id,
    target_email: existing.email,
  });

  return c.json({ ok: true });
});

export { adminRouter };
export default adminRouter;
