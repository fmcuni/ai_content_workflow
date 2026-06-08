import { describe, expect, it } from "vitest";

import { computeLineDiff, isUnchanged } from "./diff";

describe("computeLineDiff", () => {
  it("returns only context lines when both inputs are identical", () => {
    // Arrange
    const text = "line one\nline two\nline three";

    // Act
    const diff = computeLineDiff(text, text);

    // Assert
    expect(diff.every((l) => l.type === "ctx")).toBe(true);
    expect(diff.map((l) => l.text)).toEqual(["line one", "line two", "line three"]);
  });

  it("marks added lines present only in after", () => {
    // Arrange
    const before = "keep\n";
    const after = "keep\nnew line\n";

    // Act
    const diff = computeLineDiff(before, after);

    // Assert
    const added = diff.filter((l) => l.type === "add");
    expect(added).toEqual([{ type: "add", text: "new line" }]);
  });

  it("marks removed lines present only in before", () => {
    // Arrange
    const before = "keep\ndrop me\n";
    const after = "keep\n";

    // Act
    const diff = computeLineDiff(before, after);

    // Assert
    const removed = diff.filter((l) => l.type === "del");
    expect(removed).toEqual([{ type: "del", text: "drop me" }]);
  });

  it("represents a replacement as a removal plus an addition", () => {
    // Arrange
    const before = "old value\n";
    const after = "new value\n";

    // Act
    const diff = computeLineDiff(before, after);

    // Assert
    expect(diff).toEqual([
      { type: "del", text: "old value" },
      { type: "add", text: "new value" },
    ]);
  });

  it("does not emit a trailing empty line from a final newline", () => {
    // Arrange
    const text = "only line\n";

    // Act
    const diff = computeLineDiff(text, text);

    // Assert
    expect(diff).toEqual([{ type: "ctx", text: "only line" }]);
  });

  it("treats nullish inputs as empty strings", () => {
    // Act
    const diff = computeLineDiff(undefined as unknown as string, "added\n");

    // Assert
    expect(diff).toEqual([{ type: "add", text: "added" }]);
  });
});

describe("isUnchanged", () => {
  it("is true for identical strings and false otherwise", () => {
    expect(isUnchanged("a\nb", "a\nb")).toBe(true);
    expect(isUnchanged("a", "b")).toBe(false);
    expect(isUnchanged(undefined as unknown as string, "")).toBe(true);
  });
});
