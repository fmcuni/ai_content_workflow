/**
 * Admin-only user-management routes (RBAC). Mounted at /admin; every route is
 * gated by `requireRole("admin")` at registration in src/index.ts.
 *
 *   GET  /admin/users           → list all users with their STORED role
 *   PUT  /admin/users/:id/role  → set a user's stored role (enum-validated)
 *
 * Role changes are audited via the structured logger (actor, target, old→new).
 * The list returns the STORED role (not the effective role) so an admin can see
 * and correct what is actually persisted — the bootstrap override is a runtime
 * lens, not a stored value.
 */
import { Hono } from "hono";
import type { Sql } from "postgres";

import type { Env } from "../index";
import { withDb } from "../db/client";
import type { AuthVars } from "../auth/middleware";
import { isRole, type Role } from "../auth/authz";
import { resolveActorIdentity } from "./identity";
import { auditLog } from "../auth/audit";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
}

interface RoleUpdateBody {
  role?: unknown;
}

const adminRouter = new Hono<{ Bindings: Env; Variables: AuthVars }>();

// ---------------------------------------------------------------------------
// GET /admin/users — list users (stored role)
// ---------------------------------------------------------------------------
adminRouter.get("/users", async (c) => {
  const rows = await withDb(c.env, c.executionCtx, (sql: Sql) =>
    sql<UserRow[]>`
      SELECT id, email, name, role
      FROM content_tool."user"
      ORDER BY email ASC
    `,
  );
  return c.json(
    rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      // Surface the stored role verbatim (default to "viewer" only when NULL,
      // matching the column default) so an admin sees the persisted value.
      role: r.role ?? "viewer",
    })),
  );
});

// ---------------------------------------------------------------------------
// PUT /admin/users/:id/role — set a user's stored role
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
      {
        error: "self_demotion_forbidden",
        message: "an admin cannot remove their own admin role",
      },
      409,
    );
  }

  const actor = resolveActorIdentity(
    { userEmail: c.get("userEmail"), userId: c.get("userId") },
    null,
  );

  const outcome = await withDb(c.env, c.executionCtx, async (sql: Sql) => {
    const before = await sql<UserRow[]>`
      SELECT id, email, name, role FROM content_tool."user" WHERE id = ${targetId} LIMIT 1
    `;
    const existing = before[0];
    if (existing === undefined) {
      return { kind: "not_found" as const };
    }
    const rows = await sql<UserRow[]>`
      UPDATE content_tool."user"
      SET role = ${newRole}
      WHERE id = ${targetId}
      RETURNING id, email, name, role
    `;
    return { kind: "ok" as const, oldRole: existing.role ?? "viewer", user: rows[0]! };
  });

  if (outcome.kind === "not_found") {
    return c.json({ detail: "user not found" }, 404);
  }

  auditLog("rbac.role_change", {
    actor,
    target_id: outcome.user.id,
    target_email: outcome.user.email,
    old_role: outcome.oldRole,
    new_role: newRole,
  });

  return c.json({
    id: outcome.user.id,
    email: outcome.user.email,
    name: outcome.user.name,
    role: outcome.user.role ?? "viewer",
  });
});

export { adminRouter };
export default adminRouter;
