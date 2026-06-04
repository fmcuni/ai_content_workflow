import { describe, expect, it } from "vitest";

import {
  BRIEF_COLUMNS,
  columnGroupSpans,
  columnsForTab,
  RUN_COLUMNS,
  totalColumnCount,
  WORDPRESS_COLUMNS,
} from "@/lib/runs-grid/columns";

describe("RUN_COLUMNS", () => {
  it("is BRIEF followed by WORDPRESS, in order", () => {
    expect(RUN_COLUMNS.map((c) => c.key)).toEqual([
      "voice",
      "adv",
      "widget",
      "author",
      "category",
      "slug",
      "publish",
      "postDate",
    ]);
  });

  it("marks the ACF id columns numeric and the slug as decoded", () => {
    expect(BRIEF_COLUMNS.find((c) => c.key === "adv")?.numeric).toBe(true);
    expect(WORDPRESS_COLUMNS.find((c) => c.key === "slug")?.label).toBe("Slug (decoded)");
  });
});

describe("columnsForTab", () => {
  it("includes the WordPress group when shown", () => {
    expect(columnsForTab("all", true)).toHaveLength(RUN_COLUMNS.length);
  });

  it("drops the WordPress group, keeping BRIEF, when hidden", () => {
    const cols = columnsForTab("all", false);
    expect(cols).toHaveLength(BRIEF_COLUMNS.length);
    expect(cols.every((c) => c.group === "brief")).toBe(true);
  });

  it("keeps one constant run-column set across every run-bearing tab", () => {
    expect(columnsForTab("rewrite", true)).toEqual(columnsForTab("create", true));
    expect(columnsForTab("rewrite", true)).toEqual(columnsForTab("topic_gen", true));
  });
});

describe("columnGroupSpans", () => {
  it("spans both kicker groups when WordPress is shown", () => {
    expect(columnGroupSpans(true)).toEqual([
      { group: "brief", label: "Brief", span: 3 },
      { group: "wordpress", label: "WordPress destination", span: 5 },
    ]);
  });

  it("spans only BRIEF when WordPress is hidden", () => {
    expect(columnGroupSpans(false)).toEqual([{ group: "brief", label: "Brief", span: 3 }]);
  });
});

describe("totalColumnCount", () => {
  it("counts select + identity + data columns + action", () => {
    // select(1) + identity(1) + brief(3) + wordpress(5) + action(1)
    expect(totalColumnCount(true)).toBe(11);
    // select(1) + identity(1) + brief(3) + action(1)
    expect(totalColumnCount(false)).toBe(6);
  });
});
