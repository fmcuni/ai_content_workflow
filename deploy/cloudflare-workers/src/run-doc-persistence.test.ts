import { describe, expect, it } from "vitest";
import { parseRunIdFromUrl } from "./run-doc-persistence";

describe("parseRunIdFromUrl", () => {
  it("extracts the run id from a /runs/:id/doc upgrade URL", () => {
    // Arrange
    const url = "https://example.com/runs/8dee14db-0000-0000-0000-000000000000/doc";

    // Act
    const runId = parseRunIdFromUrl(url);

    // Assert
    expect(runId).toBe("8dee14db-0000-0000-0000-000000000000");
  });

  it("ignores query strings and still returns the run id", () => {
    const runId = parseRunIdFromUrl("https://example.com/runs/run-1/doc?foo=bar");
    expect(runId).toBe("run-1");
  });

  it("URL-decodes a percent-encoded run id segment", () => {
    const runId = parseRunIdFromUrl("https://example.com/runs/a%2Db/doc");
    expect(runId).toBe("a-b");
  });

  it("returns null when the path does not match the /runs/:id/doc shape", () => {
    expect(parseRunIdFromUrl("https://example.com/runs/abc")).toBeNull();
    expect(parseRunIdFromUrl("https://example.com/runs/abc/doc/extra")).toBeNull();
    expect(parseRunIdFromUrl("https://example.com/other/abc/doc")).toBeNull();
  });

  it("returns null for a non-parseable URL rather than throwing", () => {
    expect(parseRunIdFromUrl("not a url")).toBeNull();
    expect(parseRunIdFromUrl("")).toBeNull();
  });
});
