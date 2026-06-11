import { describe, expect, it } from "vitest";

import {
  byNewest,
  batchGroup,
  DONE_GROUPS,
  GROUPS,
  groupOf,
  runGroup,
  type GroupKey,
} from "@/lib/runs-grid/groups";
import type { BatchStatus, RunStatus } from "@/lib/types";

describe("GROUPS ordering", () => {
  it("lists the four groups review → generating → approved → failed", () => {
    expect(GROUPS.map((g) => g.key)).toEqual(["review", "generating", "approved", "failed"]);
  });

  it("only tags the review group with a 'waiting on you' hint", () => {
    const withHint = GROUPS.filter((g) => g.hint).map((g) => g.key);
    expect(withHint).toEqual(["review"]);
  });

  it("collapses only the terminal groups under 'Collapse done'", () => {
    expect([...DONE_GROUPS]).toEqual(["approved", "failed"]);
  });
});

describe("runGroup", () => {
  it.each<[RunStatus, GroupKey]>([
    ["hitl_1", "review"],
    ["hitl_2", "review"],
    ["changes_requested", "review"],
    ["pending", "generating"],
    ["fetching", "generating"],
    ["strategy", "generating"],
    ["production", "generating"],
    ["publishing", "generating"],
    ["revising", "generating"],
    ["persisted", "approved"],
    ["published", "approved"],
    ["failed", "failed"],
    ["rejected", "failed"],
    ["cancelled", "failed"],
  ])("maps run status %s → %s", (status, group) => {
    expect(runGroup(status)).toBe(group);
  });
});

describe("batchGroup", () => {
  it.each<[BatchStatus, GroupKey]>([
    ["ready_for_review", "review"],
    ["partially_promoted", "review"],
    ["pending", "generating"],
    ["generating", "generating"],
    ["analysing", "generating"],
    ["done", "approved"],
    ["failed", "failed"],
  ])("maps batch status %s → %s", (status, group) => {
    expect(batchGroup(status)).toBe(group);
  });
});

describe("groupOf", () => {
  it("dispatches on kind", () => {
    expect(groupOf("run", "hitl_2")).toBe("review");
    expect(groupOf("batch", "done")).toBe("approved");
  });
});

describe("byNewest", () => {
  it("sorts newest createdAt first", () => {
    const items = [
      { createdAt: "2026-05-01T00:00:00Z" },
      { createdAt: "2026-06-10T00:00:00Z" },
      { createdAt: "2026-06-01T00:00:00Z" },
    ];
    expect([...items].sort(byNewest).map((i) => i.createdAt)).toEqual([
      "2026-06-10T00:00:00Z",
      "2026-06-01T00:00:00Z",
      "2026-05-01T00:00:00Z",
    ]);
  });
});
