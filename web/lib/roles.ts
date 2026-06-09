// Role-based access ranks + capability map. Pure, UI-gating-only mirror of the
// Workers backend contract — the server stays authoritative; this only decides
// what controls to show/disable. Keep ROLE_RANK and CAPABILITY_MIN_ROLE in sync
// with the backend.

export type Role = "viewer" | "author" | "reviewer" | "admin";

export const ROLES: readonly Role[] = ["viewer", "author", "reviewer", "admin"] as const;

// Cumulative ranks: viewer < author < reviewer < admin. Keep in sync with the
// backend `ROLE_RANK` in deploy/cloudflare-workers/src/auth/authz.ts.
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  author: 1,
  reviewer: 2,
  admin: 3,
};

// Capability → minimum role required.
//
// 4-role cumulative model (replaces the old viewer/editor/admin map). NOTE the
// semantic shift: the OLD `viewer` could edit content; the NEW `viewer` is
// read-only and content editing moves up to `author`.
//   - viewer   — read-only.
//   - author   — viewer + edit/save an existing run's content (outline, article
//                body, AI apply-edits, snapshots) AND run authoring
//                (create/regenerate runs, promote topics). CANNOT publish or
//                decide a HITL gate.
//   - reviewer — author + decide HITL gates and publish to WordPress.
//   - admin    — reviewer + config (prompts/personas/source policy), deletes,
//                and user management.
export type Capability =
  // viewer — read + content editing on existing runs
  | "read"
  | "edit_outline"
  | "edit_article"
  | "apply_edits"
  | "save_snapshot"
  // editor — run lifecycle + HITL decisions + publishing
  | "create_run"
  | "regenerate"
  | "promote_topics"
  | "hitl1_approve"
  | "hitl2_decide"
  | "publish"
  // admin
  | "edit_prompts"
  | "manage_personas"
  | "edit_source_policy"
  | "delete_run"
  | "delete_batch"
  | "manage_users";

export const CAPABILITY_MIN_ROLE: Record<Capability, Role> = {
  read: "viewer",

  // Content editing + run authoring → author (was viewer/editor in the 3-role map).
  edit_outline: "author",
  edit_article: "author",
  apply_edits: "author",
  save_snapshot: "author",
  create_run: "author",
  regenerate: "author",
  promote_topics: "author",

  // HITL decisions + publishing → reviewer (was editor).
  hitl1_approve: "reviewer",
  hitl2_decide: "reviewer",
  publish: "reviewer",

  edit_prompts: "admin",
  manage_personas: "admin",
  edit_source_policy: "admin",
  delete_run: "admin",
  delete_batch: "admin",
  manage_users: "admin",
};

function isRole(value: string): value is Role {
  return value in ROLE_RANK;
}

function isCapability(value: string): value is Capability {
  return value in CAPABILITY_MIN_ROLE;
}

/**
 * True when `role` ranks at or above `required`. `required` may be a bare role
 * ("reviewer") or a capability name ("publish") — the latter is resolved to its
 * minimum role via CAPABILITY_MIN_ROLE.
 *
 * Unknown role/requirement strings fail closed (return false) rather than
 * silently granting access.
 */
export function roleMeetsRequirement(
  role: Role | null | undefined,
  required: Role | Capability,
): boolean {
  if (!role || !isRole(role)) return false;

  let requiredRole: Role | null = null;
  if (isRole(required)) {
    requiredRole = required;
  } else if (isCapability(required)) {
    requiredRole = CAPABILITY_MIN_ROLE[required];
  }
  if (!requiredRole) return false;

  return ROLE_RANK[role] >= ROLE_RANK[requiredRole];
}
