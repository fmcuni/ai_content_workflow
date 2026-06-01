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
    expect(roleMeetsRequirement("admin", "editor")).toBe(true);
    expect(roleMeetsRequirement("editor", "viewer")).toBe(true);
  });

  it("returns true when role exactly equals the required role", () => {
    (Object.keys(ROLE_RANK) as Role[]).forEach((r) => {
      expect(roleMeetsRequirement(r, r)).toBe(true);
    });
  });

  it("returns false when the role ranks below the required role", () => {
    expect(roleMeetsRequirement("viewer", "editor")).toBe(false);
    expect(roleMeetsRequirement("editor", "admin")).toBe(false);
  });

  it("resolves capability names to their minimum role", () => {
    // editor capabilities (run lifecycle + approve + publish)
    expect(roleMeetsRequirement("editor", "create_run")).toBe(true);
    expect(roleMeetsRequirement("viewer", "create_run")).toBe(false);
    expect(roleMeetsRequirement("editor", "publish")).toBe(true);
    expect(roleMeetsRequirement("viewer", "publish")).toBe(false);
    // admin capability
    expect(roleMeetsRequirement("admin", "manage_users")).toBe(true);
    expect(roleMeetsRequirement("editor", "manage_users")).toBe(false);
  });

  it("lets a viewer edit & save an existing run's content (but not publish)", () => {
    // Content editing is a viewer capability …
    expect(roleMeetsRequirement("viewer", "edit_outline")).toBe(true);
    expect(roleMeetsRequirement("viewer", "edit_article")).toBe(true);
    expect(roleMeetsRequirement("viewer", "apply_edits")).toBe(true);
    expect(roleMeetsRequirement("viewer", "save_snapshot")).toBe(true);
    // … while publishing, HITL decisions, run creation, and regenerate are not.
    expect(roleMeetsRequirement("viewer", "publish")).toBe(false);
    expect(roleMeetsRequirement("viewer", "hitl2_decide")).toBe(false);
    expect(roleMeetsRequirement("viewer", "hitl1_approve")).toBe(false);
    expect(roleMeetsRequirement("viewer", "create_run")).toBe(false);
    expect(roleMeetsRequirement("viewer", "regenerate")).toBe(false);
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
