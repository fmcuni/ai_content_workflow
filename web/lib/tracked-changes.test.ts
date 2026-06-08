import { describe, expect, it } from "vitest";

import {
  commitAll,
  commitHunk,
  computeTrackedChanges,
  dismissAll,
  dismissHunk,
} from "@/lib/tracked-changes";

describe("computeTrackedChanges", () => {
  it("reports no hunks when committed === working", () => {
    const { hunks } = computeTrackedChanges("<p>same</p>", "<p>same</p>");
    expect(hunks).toEqual([]);
  });

  it("detects an insertion", () => {
    const { hunks } = computeTrackedChanges("<p>hello</p>", "<p>hello world</p>");
    expect(hunks.some((h) => h.type === "add" && h.value.includes("world"))).toBe(true);
  });

  it("detects a deletion", () => {
    const { hunks } = computeTrackedChanges("<p>hello world</p>", "<p>hello</p>");
    expect(hunks.some((h) => h.type === "remove" && h.value.includes("world"))).toBe(true);
  });

  it("detects a replacement as a remove + add pair", () => {
    const { hunks } = computeTrackedChanges("<p>red car</p>", "<p>blue car</p>");
    expect(hunks.some((h) => h.type === "remove")).toBe(true);
    expect(hunks.some((h) => h.type === "add")).toBe(true);
  });
});

describe("commitHunk / dismissHunk", () => {
  it("committing an insertion keeps it and clears that hunk", () => {
    const committed = "<p>hello</p>";
    const working = "<p>hello world</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const addHunk = hunks.find((h) => h.type === "add")!;
    const result = commitHunk(parts, addHunk.index);
    expect(result.working).toBe(working);
    // Baseline now equals working → re-diff is empty.
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("dismissing an insertion reverts the working body", () => {
    const committed = "<p>hello</p>";
    const working = "<p>hello world</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const addHunk = hunks.find((h) => h.type === "add")!;
    const result = dismissHunk(parts, addHunk.index);
    expect(result.committed).toBe(committed);
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
    // Working reverted to baseline (no "world").
    expect(result.working.includes("world")).toBe(false);
  });

  it("committing a deletion drops the text from the baseline", () => {
    const committed = "<p>hello world</p>";
    const working = "<p>hello</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const removeHunk = hunks.find((h) => h.type === "remove")!;
    const result = commitHunk(parts, removeHunk.index);
    expect(result.committed.includes("world")).toBe(false);
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("dismissing a deletion restores the text in the working body", () => {
    const committed = "<p>hello world</p>";
    const working = "<p>hello</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const removeHunk = hunks.find((h) => h.type === "remove")!;
    const result = dismissHunk(parts, removeHunk.index);
    expect(result.working.includes("world")).toBe(true);
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("resolving one hunk of several leaves the others pending", () => {
    const committed = "<p>alpha beta gamma</p>";
    const working = "<p>ALPHA beta GAMMA</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    expect(hunks.length).toBeGreaterThan(1);
    const result = commitHunk(parts, hunks[0]!.index);
    const after = computeTrackedChanges(result.committed, result.working);
    expect(after.hunks.length).toBeLessThan(hunks.length);
  });
});

describe("commitAll / dismissAll", () => {
  it("commitAll makes the baseline equal the working body", () => {
    const { parts } = computeTrackedChanges("<p>old text</p>", "<p>new text here</p>");
    const result = commitAll(parts);
    expect(result.committed).toBe(result.working);
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("dismissAll reverts the working body to the baseline", () => {
    const committed = "<p>old text</p>";
    const { parts } = computeTrackedChanges(committed, "<p>new text here</p>");
    const result = dismissAll(parts);
    expect(result.committed).toBe(committed);
    expect(result.working).toBe(committed);
  });

  it("does not split HTML tags — rejoined output stays well-formed", () => {
    const committed = `<p>a</p><p>b</p>`;
    const working = `<p>a</p><p>b</p><p>c</p>`;
    const { parts } = computeTrackedChanges(committed, working);
    const result = commitAll(parts);
    expect(result.committed).toBe(working);
    // Every <p> still has a matching </p>.
    expect((result.committed.match(/<p>/g) ?? []).length).toBe(
      (result.committed.match(/<\/p>/g) ?? []).length,
    );
  });
});
