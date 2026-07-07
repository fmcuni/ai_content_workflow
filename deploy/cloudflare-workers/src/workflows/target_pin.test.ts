/**
 * Pin-comparison semantics for the publish-step assertion (issue #15). These
 * are the exact rules the workflow's assertPinnedTarget enforces before any
 * CMS write — kept pure in target_pin.ts so the node pool can test them
 * (production.ts itself only loads under workerd).
 */

import { describe, expect, it } from "vitest";

import { pinnedTargetMatches, pinMismatchMessage } from "./target_pin";

const WP_PIN = {
  approved_target_kind: "wordpress",
  approved_post_id: "123",
  approved_target_label: "Bowtie Blog (prod)",
};

const WP_ACTUAL = { kind: "wordpress", postId: "123", label: "Bowtie Blog (prod)" };

const NO_PIN = {
  approved_target_kind: null,
  approved_post_id: null,
  approved_target_label: null,
};

describe("pinnedTargetMatches", () => {
  it("matches when kind, post id and label are all identical", () => {
    expect(pinnedTargetMatches(WP_PIN, WP_ACTUAL)).toBe(true);
  });

  it("fails closed on a missing pin (approval predating the pin columns)", () => {
    expect(pinnedTargetMatches(NO_PIN, WP_ACTUAL)).toBe(false);
  });

  it("rejects a different post id (approved A, resolving B)", () => {
    expect(pinnedTargetMatches(WP_PIN, { ...WP_ACTUAL, postId: "456" })).toBe(false);
  });

  it("rejects a CMS-kind switch even with an equal id", () => {
    expect(pinnedTargetMatches(WP_PIN, { ...WP_ACTUAL, kind: "ghost" })).toBe(false);
  });

  it("rejects a target-label (CMS instance) switch — post ids collide across instances", () => {
    expect(pinnedTargetMatches(WP_PIN, { ...WP_ACTUAL, label: "VHIS101 (prod)" })).toBe(false);
  });

  it("matches an approved-as-create-new pin only against a create-new resolution", () => {
    const createNewPin = { ...WP_PIN, approved_post_id: null };
    expect(pinnedTargetMatches(createNewPin, { ...WP_ACTUAL, postId: null })).toBe(true);
    expect(pinnedTargetMatches(createNewPin, WP_ACTUAL)).toBe(false);
    expect(pinnedTargetMatches(WP_PIN, { ...WP_ACTUAL, postId: null })).toBe(false);
  });

  it("matches Ghost string ids exactly", () => {
    const ghostPin = {
      approved_target_kind: "ghost",
      approved_post_id: "64f0a1b2c3d4e5f6a7b8c9d0",
      approved_target_label: "healthycheckhk",
    };
    const ghostActual = {
      kind: "ghost",
      postId: "64f0a1b2c3d4e5f6a7b8c9d0",
      label: "healthycheckhk",
    };
    expect(pinnedTargetMatches(ghostPin, ghostActual)).toBe(true);
    expect(
      pinnedTargetMatches(ghostPin, { ...ghostActual, postId: "64f0a1b2c3d4e5f6a7b8c9d1" }),
    ).toBe(false);
  });
});

describe("pinMismatchMessage", () => {
  it("starts with the prefix the restart route matches on (load-bearing)", () => {
    expect(pinMismatchMessage(NO_PIN, WP_ACTUAL)).toMatch(/^publish target mismatch: /);
  });

  it("names both the pinned and the resolved target", () => {
    const msg = pinMismatchMessage(WP_PIN, { ...WP_ACTUAL, postId: "456" });
    expect(msg).toContain("approved wordpress post 123");
    expect(msg).toContain("resolved wordpress post 456");
    expect(msg).toContain("re-run the publish preview");
  });

  it("describes a missing pin and a create-new resolution readably", () => {
    const msg = pinMismatchMessage(NO_PIN, { ...WP_ACTUAL, postId: null });
    expect(msg).toContain("no pinned target on this approval");
    expect(msg).toContain("post <new>");
  });
});
