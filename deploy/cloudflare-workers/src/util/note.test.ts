import { describe, expect, it } from "vitest";

import { MAX_NOTE_LENGTH, validateNote } from "./note";

describe("validateNote", () => {
  it("accepts absent / null notes (optional field)", () => {
    expect(validateNote(undefined)).toBeNull();
    expect(validateNote(null)).toBeNull();
  });

  it("accepts a string within the length cap", () => {
    expect(validateNote("fixed a typo")).toBeNull();
    expect(validateNote("a".repeat(MAX_NOTE_LENGTH))).toBeNull();
  });

  it("rejects a non-string note", () => {
    expect(validateNote(42)).toBe("note must be a string");
    expect(validateNote({})).toBe("note must be a string");
  });

  it("rejects a note over the length cap (mirrors Python max_length=500)", () => {
    expect(validateNote("a".repeat(MAX_NOTE_LENGTH + 1))).toBe(
      `note must be at most ${MAX_NOTE_LENGTH} characters`,
    );
  });
});
