import { describe, it, expect } from "vitest";

import { safeCollabColor, NEUTRAL_COLLAB_COLOR } from "./collab-color";

describe("safeCollabColor", () => {
  it("accepts valid hex literals (#rgb / #rgba / #rrggbb / #rrggbbaa)", () => {
    for (const hex of ["#fff", "#ffff", "#ef4444", "#ef4444ff", "#ABCDEF"]) {
      expect(safeCollabColor(hex)).toBe(hex);
    }
  });

  it("rejects non-hex / CSS-injection attempts and falls back to neutral", () => {
    for (const bad of [
      "red",
      "rgb(255,0,0)",
      "#ef4444; background: url(http://attacker/)",
      "#xyz",
      "#12",
      "",
    ]) {
      expect(safeCollabColor(bad)).toBe(NEUTRAL_COLLAB_COLOR);
    }
  });

  it("falls back to neutral for null / undefined", () => {
    expect(safeCollabColor(null)).toBe(NEUTRAL_COLLAB_COLOR);
    expect(safeCollabColor(undefined)).toBe(NEUTRAL_COLLAB_COLOR);
  });

  it("honours a custom fallback", () => {
    expect(safeCollabColor("not-a-color", "#000000")).toBe("#000000");
  });
});
