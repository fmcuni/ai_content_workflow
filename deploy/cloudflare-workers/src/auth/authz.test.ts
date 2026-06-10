/**
 * Unit tests for the pure RBAC helpers (no DB / HTTP harness).
 *
 *   - effectiveRole: bootstrap-admin override (case-insensitive), null/default
 *   - roleMeetsRequirement: the cumulative viewer < author < reviewer < admin scale
 *   - coerceRole / isRole: enum narrowing + legacy "editor" → "reviewer" alias
 */
import { describe, expect, it } from "vitest";

import type { Env } from "../index";
import {
  coerceRole,
  effectiveRole,
  isRole,
  roleMeetsRequirement,
  ROLE_RANK,
} from "./authz";

function envWith(bootstrap?: string): Env {
  return { BOOTSTRAP_ADMIN_EMAILS: bootstrap } as Env;
}

describe("effectiveRole", () => {
  it("returns the stored role when no bootstrap list is set", () => {
    expect(effectiveRole("reviewer", "someone@bowtie.com.hk", envWith())).toBe("reviewer");
    expect(effectiveRole("author", "someone@bowtie.com.hk", envWith())).toBe("author");
  });

  it("aliases a legacy stored 'editor' to 'reviewer'", () => {
    expect(effectiveRole("editor", "someone@bowtie.com.hk", envWith())).toBe("reviewer");
  });

  it("defaults to viewer when the stored role is null", () => {
    expect(effectiveRole(null, "someone@bowtie.com.hk", envWith())).toBe("viewer");
  });

  it("defaults to viewer when the stored role is undefined", () => {
    expect(effectiveRole(undefined, "someone@bowtie.com.hk", envWith())).toBe("viewer");
  });

  it("coerces an unknown stored role string to viewer", () => {
    expect(effectiveRole("superuser", "someone@bowtie.com.hk", envWith())).toBe("viewer");
  });

  it("overrides a viewer stored role to admin for a bootstrap email", () => {
    const env = envWith("boss@bowtie.com.hk");
    expect(effectiveRole("viewer", "boss@bowtie.com.hk", env)).toBe("admin");
  });

  it("matches bootstrap emails case-insensitively", () => {
    const env = envWith("Boss@Bowtie.com.hk");
    expect(effectiveRole("viewer", "BOSS@bowtie.COM.HK", env)).toBe("admin");
  });

  it("handles a comma-separated bootstrap list with whitespace", () => {
    const env = envWith(" a@b.com , boss@bowtie.com.hk ,c@d.com ");
    expect(effectiveRole(null, "boss@bowtie.com.hk", env)).toBe("admin");
    // a@b.com is parsed + matched, but it is NOT admin-eligible, so the bootstrap
    // grant does not apply — it falls through to the stored role (null → viewer
    // floor here). The break-glass list is an ADMIN list; a non-eligible entry
    // grants nothing rather than silently conferring reviewer.
    expect(effectiveRole(null, "a@b.com", env)).toBe("viewer");
  });

  it("does NOT grant a bootstrap email outside the eligible domains (ignored, not capped)", () => {
    // SECURITY: BOOTSTRAP_ADMIN_EMAILS is a break-glass ADMIN escape hatch. A
    // non-eligible email (e.g. a gmail) in the list must grant NOTHING — never a
    // silent reviewer floor — or it becomes an invite-only bypass that survives
    // account deletion (Google OAuth re-creates the GoTrue user on every login).
    const env = envWith("ext@gmail.com");
    // No stored row (deleted account) + supabase floor=null → denied.
    expect(effectiveRole(null, "ext@gmail.com", env, null)).toBeNull();
    // Legacy/default viewer floor → falls through to the floor, not reviewer.
    expect(effectiveRole(null, "ext@gmail.com", env)).toBe("viewer");
    // A stored role is honored as-is (bootstrap adds nothing for a gmail).
    expect(effectiveRole("author", "ext@gmail.com", env)).toBe("author");
  });

  it("still caps a stored 'admin' on a non-eligible domain to reviewer", () => {
    // The stored-role admin ceiling is unchanged: a provisioned non-bowtie user
    // whose row says "admin" is capped to reviewer (defense in depth).
    expect(effectiveRole("admin", "ext@gmail.com", envWith())).toBe("reviewer");
  });

  it("allows admin for bowtie.com.sg as well as bowtie.com.hk", () => {
    expect(effectiveRole("admin", "ops@bowtie.com.sg", envWith())).toBe("admin");
    expect(effectiveRole("admin", "ops@bowtie.com.hk", envWith())).toBe("admin");
  });

  it("honors a custom ADMIN_EMAIL_DOMAINS override", () => {
    const env = { BOOTSTRAP_ADMIN_EMAILS: "", ADMIN_EMAIL_DOMAINS: "acme.io" } as Env;
    expect(effectiveRole("admin", "boss@acme.io", env)).toBe("admin");
    // The default bowtie domains are replaced, not merged.
    expect(effectiveRole("admin", "boss@bowtie.com.hk", env)).toBe("reviewer");
  });

  it("does not promote a non-bootstrap email", () => {
    const env = envWith("boss@bowtie.com.hk");
    expect(effectiveRole("reviewer", "peon@bowtie.com.hk", env)).toBe("reviewer");
  });

  it("ignores a null/empty email (no bootstrap match possible)", () => {
    const env = envWith("boss@bowtie.com.hk");
    expect(effectiveRole("reviewer", null, env)).toBe("reviewer");
    expect(effectiveRole(null, "", env)).toBe("viewer");
  });
});

describe("roleMeetsRequirement", () => {
  it("passes when the role exactly meets the requirement", () => {
    expect(roleMeetsRequirement("reviewer", "reviewer")).toBe(true);
    expect(roleMeetsRequirement("author", "author")).toBe(true);
  });

  it("passes when the role exceeds the requirement", () => {
    expect(roleMeetsRequirement("admin", "viewer")).toBe(true);
    expect(roleMeetsRequirement("author", "viewer")).toBe(true);
    expect(roleMeetsRequirement("reviewer", "author")).toBe(true);
    expect(roleMeetsRequirement("admin", "reviewer")).toBe(true);
  });

  it("fails when the role is below the requirement", () => {
    expect(roleMeetsRequirement("author", "reviewer")).toBe(false);
    expect(roleMeetsRequirement("viewer", "author")).toBe(false);
    expect(roleMeetsRequirement("reviewer", "admin")).toBe(false);
    expect(roleMeetsRequirement("viewer", "admin")).toBe(false);
  });

  it("orders the cumulative ranks viewer < author < reviewer < admin", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.author);
    expect(ROLE_RANK.author).toBeLessThan(ROLE_RANK.reviewer);
    expect(ROLE_RANK.reviewer).toBeLessThan(ROLE_RANK.admin);
  });
});

describe("coerceRole / isRole", () => {
  it("coerces a known role string", () => {
    expect(coerceRole("reviewer")).toBe("reviewer");
    expect(coerceRole("author")).toBe("author");
    expect(coerceRole("viewer")).toBe("viewer");
    expect(coerceRole("admin")).toBe("admin");
  });

  it("aliases the legacy 'editor' token to 'reviewer'", () => {
    expect(coerceRole("editor")).toBe("reviewer");
  });

  it("coerces unknown / null / undefined to viewer", () => {
    expect(coerceRole("nope")).toBe("viewer");
    expect(coerceRole(null)).toBe("viewer");
    expect(coerceRole(undefined)).toBe("viewer");
  });

  it("validates role strings (4-role model; legacy 'editor' is NOT assignable)", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("reviewer")).toBe(true);
    expect(isRole("author")).toBe(true);
    expect(isRole("viewer")).toBe(true);
    expect(isRole("editor")).toBe(false);
    expect(isRole("superuser")).toBe(false);
    expect(isRole(42)).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});
