/**
 * Unit tests for the pure RBAC helpers (no DB / HTTP harness).
 *
 *   - effectiveRole: bootstrap-admin override (case-insensitive), null/default
 *   - roleMeetsRequirement: the cumulative viewer < editor < admin scale
 *   - coerceRole / isRole: enum narrowing + validation
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
    expect(effectiveRole("editor", "someone@bowtie.com.hk", envWith())).toBe("editor");
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
    expect(effectiveRole(null, "a@b.com", env)).toBe("admin");
  });

  it("does not promote a non-bootstrap email", () => {
    const env = envWith("boss@bowtie.com.hk");
    expect(effectiveRole("editor", "peon@bowtie.com.hk", env)).toBe("editor");
  });

  it("ignores a null/empty email (no bootstrap match possible)", () => {
    const env = envWith("boss@bowtie.com.hk");
    expect(effectiveRole("editor", null, env)).toBe("editor");
    expect(effectiveRole(null, "", env)).toBe("viewer");
  });
});

describe("roleMeetsRequirement", () => {
  it("passes when the role exactly meets the requirement", () => {
    expect(roleMeetsRequirement("editor", "editor")).toBe(true);
  });

  it("passes when the role exceeds the requirement", () => {
    expect(roleMeetsRequirement("admin", "viewer")).toBe(true);
    expect(roleMeetsRequirement("editor", "viewer")).toBe(true);
    expect(roleMeetsRequirement("admin", "editor")).toBe(true);
  });

  it("fails when the role is below the requirement", () => {
    expect(roleMeetsRequirement("editor", "admin")).toBe(false);
    expect(roleMeetsRequirement("viewer", "editor")).toBe(false);
    expect(roleMeetsRequirement("viewer", "admin")).toBe(false);
  });

  it("orders the cumulative ranks viewer < editor < admin", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.editor);
    expect(ROLE_RANK.editor).toBeLessThan(ROLE_RANK.admin);
  });
});

describe("coerceRole / isRole", () => {
  it("coerces a known role string", () => {
    expect(coerceRole("editor")).toBe("editor");
  });

  it("coerces unknown / null / undefined to viewer", () => {
    expect(coerceRole("nope")).toBe("viewer");
    expect(coerceRole(null)).toBe("viewer");
    expect(coerceRole(undefined)).toBe("viewer");
  });

  it("validates role strings", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("viewer")).toBe(true);
    expect(isRole("superuser")).toBe(false);
    expect(isRole(42)).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});
