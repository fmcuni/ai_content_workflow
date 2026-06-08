import { describe, expect, it } from "vitest";

import { authorDisplay, categoryDisplay, nameFromOptions } from "@/lib/runs-grid/wp-names";

const OPTIONS = [
  { id: 5, name: "Alice", slug: "alice" },
  { id: 7, name: "Bob", slug: "bob" },
  { id: 12, name: "Health", slug: "health" },
];

describe("nameFromOptions", () => {
  it("returns the matching option's name", () => {
    expect(nameFromOptions(OPTIONS, 7)).toBe("Bob");
  });

  it("returns null when the id is not in the (voice-scoped) snapshot", () => {
    expect(nameFromOptions(OPTIONS, 99)).toBeNull();
  });

  it("returns null when options have not loaded yet", () => {
    expect(nameFromOptions(undefined, 5)).toBeNull();
  });
});

describe("authorDisplay", () => {
  it("shows the resolved name for an in-snapshot id", () => {
    expect(authorDisplay(OPTIONS, 5)).toBe("Alice");
  });

  it("falls back to #id when the id is off-snapshot (wrong CMS / not synced)", () => {
    expect(authorDisplay(OPTIONS, 99)).toBe("#99");
  });

  it("shows the em-dash sentinel when unassigned", () => {
    expect(authorDisplay(OPTIONS, null)).toBe("—");
    expect(authorDisplay(OPTIONS, undefined)).toBe("—");
  });
});

describe("categoryDisplay", () => {
  it("shows the first category's name", () => {
    expect(categoryDisplay(OPTIONS, [12])).toBe("Health");
  });

  it("marks +N when a run carries extra categories (never silently single)", () => {
    expect(categoryDisplay(OPTIONS, [12, 7])).toBe("Health +1");
    expect(categoryDisplay(OPTIONS, [12, 7, 5])).toBe("Health +2");
  });

  it("falls back to #id for an off-snapshot first id", () => {
    expect(categoryDisplay(OPTIONS, [99])).toBe("#99");
  });

  it("shows the em-dash sentinel for empty / null ids", () => {
    expect(categoryDisplay(OPTIONS, [])).toBe("—");
    expect(categoryDisplay(OPTIONS, null)).toBe("—");
  });
});
