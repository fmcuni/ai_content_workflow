// Role-based access ranks + capability map. Pure, UI-gating-only mirror of the
// Workers backend contract — the server stays authoritative; this only decides
// what controls to show/disable. Keep ROLE_RANK and CAPABILITY_MIN_ROLE in sync
// with the backend.

export type Role = "viewer" | "editor" | "admin";

export const ROLES: readonly Role[] = ["viewer", "editor", "admin"] as const;

// Cumulative ranks: viewer < editor < admin.
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

// Capability → minimum role required.
export type Capability =
  // viewer
  | "read"
  // editor
  | "create_run"
  | "edit_outline"
  | "edit_article"
  | "regenerate"
  | "apply_edits"
  | "promote_topics"
  | "save_snapshot"
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

  create_run: "editor",
  edit_outline: "editor",
  edit_article: "editor",
  regenerate: "editor",
  apply_edits: "editor",
  promote_topics: "editor",
  save_snapshot: "editor",
  hitl1_approve: "editor",
  hitl2_decide: "editor",
  publish: "editor",

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
 * ("editor") or a capability name ("publish") — the latter is resolved to its
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
