import { describe, expect, it } from "vitest";

import type { Env } from "../index";
import type { PublishTargetRow } from "../db/schema";
import { buildTargetEnv, targetFromRow, type ResolvedTarget } from "./wp_factory";

function row(overrides: Partial<PublishTargetRow> = {}): PublishTargetRow {
  return {
    publish_target_id: "00000000-0000-0000-0000-000000000002",
    name: "VHIS101 WordPress",
    kind: "wordpress",
    auth_ref: "VHIS101_WP",
    status: "active",
    is_archived: false,
    ...overrides,
  };
}

// Minimal Env stub: the factory only ever reads WP_* string keys by name.
function env(extra: Record<string, string | undefined> = {}): Env {
  return {
    WP_BASE_URL: "https://www.bowtie.com.hk/blog",
    WP_USERNAME: "bowtie",
    WP_APP_PASSWORD: "default-pw",
    ...extra,
  } as unknown as Env;
}

describe("targetFromRow", () => {
  it("returns the default descriptor when the voice has no target row", () => {
    expect(targetFromRow(null, "Bowtie WordPress")).toEqual<ResolvedTarget>({
      authRef: null,
      label: "Bowtie WordPress",
      isDefault: true,
    });
  });

  it("maps an active wordpress row to its auth_ref + name", () => {
    expect(targetFromRow(row(), "Bowtie WordPress")).toEqual<ResolvedTarget>({
      authRef: "VHIS101_WP",
      label: "VHIS101 WordPress",
      isDefault: false,
    });
  });

  it("throws for an archived target", () => {
    expect(() => targetFromRow(row({ is_archived: true }), "x")).toThrow(/archived/);
  });

  it("throws for an unsupported kind", () => {
    expect(() => targetFromRow(row({ kind: "ghost" }), "x")).toThrow(/unsupported/);
  });
});

describe("buildTargetEnv", () => {
  it("returns env unchanged for the default target", () => {
    const base = env();
    const result = buildTargetEnv(base, { authRef: null, label: "d", isDefault: true });
    expect(result).toBe(base);
  });

  it("overrides WP_* from the auth_ref-prefixed env vars", () => {
    const base = env({
      VHIS101_WP_BASE_URL: "https://vhis101.example.com",
      VHIS101_WP_USERNAME: "editor",
      VHIS101_WP_APP_PASSWORD: "vhis-pw",
    });
    const result = buildTargetEnv(base, {
      authRef: "VHIS101_WP",
      label: "VHIS101 WordPress",
      isDefault: false,
    });
    expect(result.WP_BASE_URL).toBe("https://vhis101.example.com");
    expect(result.WP_USERNAME).toBe("editor");
    expect(result.WP_APP_PASSWORD).toBe("vhis-pw");
    // The default creds are not mutated on the original env.
    expect(base.WP_BASE_URL).toBe("https://www.bowtie.com.hk/blog");
  });

  it("throws when a target credential env var is missing", () => {
    const base = env({ VHIS101_WP_BASE_URL: "https://vhis101.example.com" });
    expect(() =>
      buildTargetEnv(base, { authRef: "VHIS101_WP", label: "x", isDefault: false }),
    ).toThrow(/VHIS101_WP_USERNAME/);
  });
});
