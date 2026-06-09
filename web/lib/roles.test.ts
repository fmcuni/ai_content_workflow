import { describe, expect, it } from "vitest";

import {
  CAPABILITY_MIN_ROLE,
  type Capability,
  ROLE_RANK,
  type Role,
  roleMeetsRequirement,
} from "@/lib/roles";

describe("roleMeetsRequirement", () => {
  it("treats roles as cumulative: a higher rank satisfies a lower required role", () => {
    expect(roleMeetsRequirement("admin", "viewer")).toBe(true);
    expect(roleMeetsRequirement("admin", "reviewer")).toBe(true);
    expect(roleMeetsRequirement("reviewer", "author")).toBe(true);
    expect(roleMeetsRequirement("author", "viewer")).toBe(true);
  });

  it("returns true when role exactly equals the required role", () => {
    (Object.keys(ROLE_RANK) as Role[]).forEach((r) => {
      expect(roleMeetsRequirement(r, r)).toBe(true);
    });
  });

  it("returns false when the role ranks below the required role", () => {
    expect(roleMeetsRequirement("viewer", "author")).toBe(false);
    expect(roleMeetsRequirement("author", "reviewer")).toBe(false);
    expect(roleMeetsRequirement("reviewer", "admin")).toBe(false);
  });

  it("resolves capability names to their minimum role", () => {
    // author capabilities (content editing + run authoring)
    expect(roleMeetsRequirement("author", "create_run")).toBe(true);
    expect(roleMeetsRequirement("viewer", "create_run")).toBe(false);
    // reviewer capabilities (HITL decisions + publish)
    expect(roleMeetsRequirement("reviewer", "publish")).toBe(true);
    expect(roleMeetsRequirement("author", "publish")).toBe(false);
    // admin capability
    expect(roleMeetsRequirement("admin", "manage_users")).toBe(true);
    expect(roleMeetsRequirement("reviewer", "manage_users")).toBe(false);
  });

  it("makes the new viewer read-only (content editing moves up to author)", () => {
    // Content editing + run authoring is an AUTHOR capability now …
    expect(roleMeetsRequirement("author", "edit_outline")).toBe(true);
    expect(roleMeetsRequirement("author", "edit_article")).toBe(true);
    expect(roleMeetsRequirement("author", "apply_edits")).toBe(true);
    expect(roleMeetsRequirement("author", "save_snapshot")).toBe(true);
    expect(roleMeetsRequirement("author", "regenerate")).toBe(true);
    expect(roleMeetsRequirement("author", "promote_topics")).toBe(true);
    // … and the new viewer can do NONE of it (read-only).
    expect(roleMeetsRequirement("viewer", "edit_outline")).toBe(false);
    expect(roleMeetsRequirement("viewer", "edit_article")).toBe(false);
    expect(roleMeetsRequirement("viewer", "apply_edits")).toBe(false);
    expect(roleMeetsRequirement("viewer", "save_snapshot")).toBe(false);
    // Author authors but does not publish or decide HITL gates.
    expect(roleMeetsRequirement("author", "publish")).toBe(false);
    expect(roleMeetsRequirement("author", "hitl2_decide")).toBe(false);
    expect(roleMeetsRequirement("author", "hitl1_approve")).toBe(false);
  });

  it("grants the read capability to every role", () => {
    (Object.keys(ROLE_RANK) as Role[]).forEach((r) => {
      expect(roleMeetsRequirement(r, "read")).toBe(true);
    });
  });

  it("fails closed for null/undefined or unknown roles", () => {
    expect(roleMeetsRequirement(null, "read")).toBe(false);
    expect(roleMeetsRequirement(undefined, "read")).toBe(false);
    expect(roleMeetsRequirement("superuser" as Role, "read")).toBe(false);
    // The legacy 'editor' token is no longer a known role → fails closed.
    expect(roleMeetsRequirement("editor" as Role, "read")).toBe(false);
  });

  it("fails closed for unknown requirement strings", () => {
    expect(roleMeetsRequirement("admin", "launch_missiles" as Capability)).toBe(false);
  });

  it("keeps every capability mapped to a known role (contract sanity)", () => {
    (Object.keys(CAPABILITY_MIN_ROLE) as Capability[]).forEach((cap) => {
      expect(ROLE_RANK).toHaveProperty(CAPABILITY_MIN_ROLE[cap]);
    });
  });
});
