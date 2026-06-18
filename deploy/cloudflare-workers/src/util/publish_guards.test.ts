import { describe, expect, it } from "vitest";

import { checkPublishGuards } from "./publish_guards";

describe("checkPublishGuards — scheduled without a publish date", () => {
  it("rejects a future WordPress post with no publish date", () => {
    expect(
      checkPublishGuards({
        kind: "wordpress",
        status: "future",
        publishAt: null,
        categoryIds: null,
      }),
    ).toMatch(/scheduled publish needs a publish date/i);
  });

  it("rejects a scheduled Ghost post with a blank publish date", () => {
    expect(
      checkPublishGuards({
        kind: "ghost",
        status: "scheduled",
        publishAt: "   ",
        categoryIds: null,
      }),
    ).toMatch(/scheduled publish needs a publish date/i);
  });

  it("allows a future post once a publish date is set", () => {
    expect(
      checkPublishGuards({
        kind: "ghost",
        status: "future",
        publishAt: "2026-07-01T09:00:00Z",
        categoryIds: null,
      }),
    ).toBeNull();
  });

  it("ignores the scheduling check for draft/publish statuses", () => {
    expect(
      checkPublishGuards({ kind: "wordpress", status: "publish", publishAt: null, categoryIds: null }),
    ).toBeNull();
    expect(
      checkPublishGuards({ kind: "ghost", status: "draft", publishAt: null, categoryIds: null }),
    ).toBeNull();
  });
});

describe("checkPublishGuards — categories on a Ghost target", () => {
  it("rejects non-empty categories for a Ghost target", () => {
    expect(
      checkPublishGuards({ kind: "ghost", status: "publish", publishAt: null, categoryIds: [12] }),
    ).toMatch(/Ghost has no categories/i);
  });

  it("allows empty/absent categories for a Ghost target", () => {
    expect(
      checkPublishGuards({ kind: "ghost", status: "publish", publishAt: null, categoryIds: [] }),
    ).toBeNull();
    expect(
      checkPublishGuards({ kind: "ghost", status: "publish", publishAt: null, categoryIds: null }),
    ).toBeNull();
  });

  it("allows categories for a WordPress target", () => {
    expect(
      checkPublishGuards({ kind: "wordpress", status: "publish", publishAt: null, categoryIds: [12, 34] }),
    ).toBeNull();
  });

  it("reports the scheduling error first when both checks fail", () => {
    expect(
      checkPublishGuards({ kind: "ghost", status: "future", publishAt: null, categoryIds: [12] }),
    ).toMatch(/scheduled publish needs a publish date/i);
  });
});
