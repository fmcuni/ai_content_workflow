import { describe, expect, test } from "vitest";

import type { BoardRecord } from "@/lib/runs-grid/board-record";
import type { GroupKey } from "@/lib/runs-grid/groups";
import {
  buildNavOrder,
  findNavRow,
  moveFocus,
  type NavRow,
  rowHref,
  shouldIgnoreKbd,
} from "@/lib/runs-grid/keyboard";

// Minimal record factories — buildNavOrder only reads kind/id/group/createdAt.
function run(id: string, group: GroupKey, createdAt: string): BoardRecord {
  // The run payload is never inspected by buildNavOrder; cast a stub.
  return { kind: "run", id, group, createdAt, voice: "", run: { run_id: id } as never };
}
function batch(id: string, group: GroupKey, createdAt: string): BoardRecord {
  return { kind: "batch", id, group, createdAt, voice: "", batch: { batch_id: id } as never };
}

const allOpen = () => true;
const noChildren = () => [];

describe("buildNavOrder", () => {
  test("walks groups in GROUPS order, newest-first within a group", () => {
    const records = [
      run("r-old", "review", "2026-06-01T00:00:00Z"),
      run("r-new", "review", "2026-06-03T00:00:00Z"),
      run("g1", "generating", "2026-06-02T00:00:00Z"),
    ];
    const order = buildNavOrder(records, allOpen, new Set(), noChildren);
    // review group precedes generating; within review, newest (r-new) first.
    expect(order.map((r) => r.id)).toEqual(["r-new", "r-old", "g1"]);
  });

  test("omits rows in collapsed groups", () => {
    const records = [
      run("r1", "review", "2026-06-03T00:00:00Z"),
      run("done1", "approved", "2026-06-02T00:00:00Z"),
    ];
    const isOpen = (k: GroupKey) => k !== "approved";
    const order = buildNavOrder(records, isOpen, new Set(), noChildren);
    expect(order.map((r) => r.id)).toEqual(["r1"]);
  });

  test("inlines an expanded batch's promoted children right after it", () => {
    const records = [batch("b1", "review", "2026-06-03T00:00:00Z")];
    const childIdsOf = (id: string) => (id === "b1" ? ["c1", "c2"] : []);
    const order = buildNavOrder(records, allOpen, new Set(["b1"]), childIdsOf);
    expect(order).toEqual<NavRow[]>([
      { id: "b1", kind: "batch" },
      { id: "c1", kind: "run" },
      { id: "c2", kind: "run" },
    ]);
  });

  test("an unexpanded batch contributes only its own row", () => {
    const records = [batch("b1", "review", "2026-06-03T00:00:00Z")];
    const childIdsOf = () => ["c1"];
    const order = buildNavOrder(records, allOpen, new Set(), childIdsOf);
    expect(order.map((r) => r.id)).toEqual(["b1"]);
  });
});

describe("moveFocus", () => {
  const order: NavRow[] = [
    { id: "a", kind: "run" },
    { id: "b", kind: "run" },
    { id: "c", kind: "run" },
  ];

  test("j from nothing focuses the first row; k from nothing focuses the last", () => {
    expect(moveFocus(order, null, 1)).toBe("a");
    expect(moveFocus(order, null, -1)).toBe("c");
  });

  test("moves forward and backward by one", () => {
    expect(moveFocus(order, "a", 1)).toBe("b");
    expect(moveFocus(order, "b", -1)).toBe("a");
  });

  test("clamps at both ends (no wrap)", () => {
    expect(moveFocus(order, "c", 1)).toBe("c");
    expect(moveFocus(order, "a", -1)).toBe("a");
  });

  test("re-enters at the nearest end when the current id is gone", () => {
    expect(moveFocus(order, "gone", 1)).toBe("a");
    expect(moveFocus(order, "gone", -1)).toBe("c");
  });

  test("returns null for an empty order", () => {
    expect(moveFocus([], null, 1)).toBeNull();
    expect(moveFocus([], "a", 1)).toBeNull();
  });
});

describe("shouldIgnoreKbd", () => {
  test("ignores keystrokes while an overlay is open", () => {
    expect(shouldIgnoreKbd("TR", false, true)).toBe(true);
  });

  test("ignores typing in form controls and links", () => {
    for (const tag of ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A", "option"]) {
      expect(shouldIgnoreKbd(tag, false, false)).toBe(true);
    }
  });

  test("ignores contenteditable", () => {
    expect(shouldIgnoreKbd("DIV", true, false)).toBe(true);
  });

  test("acts on a focused row or the body", () => {
    expect(shouldIgnoreKbd("TR", false, false)).toBe(false);
    expect(shouldIgnoreKbd("BODY", false, false)).toBe(false);
    expect(shouldIgnoreKbd(undefined, false, false)).toBe(false);
  });
});

describe("findNavRow / rowHref", () => {
  const order: NavRow[] = [
    { id: "run-1", kind: "run" },
    { id: "batch-1", kind: "batch" },
  ];

  test("findNavRow returns the matching row or null", () => {
    expect(findNavRow(order, "batch-1")).toEqual({ id: "batch-1", kind: "batch" });
    expect(findNavRow(order, null)).toBeNull();
    expect(findNavRow(order, "missing")).toBeNull();
  });

  test("rowHref routes runs and batches to their pages", () => {
    expect(rowHref({ id: "run-1", kind: "run" })).toBe("/runs/run-1");
    expect(rowHref({ id: "batch-1", kind: "batch" })).toBe("/topic-batches/batch-1");
  });
});
