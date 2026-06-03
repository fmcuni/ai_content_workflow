import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";

import { apexDomain, resolveUrl } from "./url_resolver";

// Minimal postgres.js stand-in: records how many INSERTs into the cache table
// were issued and treats every SELECT (the cache lookup) as a miss.
function recordingSql(): { sql: Sql; state: { inserts: number } } {
  const state = { inserts: 0 };
  const tag = (strings: TemplateStringsArray): Promise<unknown[]> => {
    if (strings.join("?").includes("INSERT INTO content_tool.url_resolution_cache")) {
      state.inserts += 1;
    }
    return Promise.resolve([]);
  };
  return { sql: tag as unknown as Sql, state };
}

describe("apexDomain", () => {
  it("keeps three labels for a .org.hk compound suffix", () => {
    // Arrange / Act
    const apex = apexDomain("https://www.ia.org.hk/en/page");

    // Assert
    expect(apex).toBe("ia.org.hk");
  });

  it("keeps three labels for a .gov.hk compound suffix with subdomain", () => {
    expect(apexDomain("http://www.hkma.gov.hk")).toBe("hkma.gov.hk");
  });

  it("keeps two labels for a single-level suffix (.int)", () => {
    expect(apexDomain("https://who.int/data")).toBe("who.int");
  });

  it("keeps two labels for a common .com host", () => {
    expect(apexDomain("https://www.reddit.com/r/hongkong")).toBe("reddit.com");
  });

  it("returns a bare host unchanged (lowercased, no suffix logic needed)", () => {
    expect(apexDomain("localhost")).toBe("localhost");
  });

  it("returns null when no host can be parsed", () => {
    expect(apexDomain("")).toBeNull();
  });
});

describe("resolveUrl caching", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches a successful resolution", async () => {
    // Arrange
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ url: "https://www.bowtie.com.hk/blog/zh/x" }) as Response),
    );
    const { sql, state } = recordingSql();

    // Act
    const resolved = await resolveUrl(sql, "https://vertexaisearch.cloud.google.com/ok");

    // Assert
    expect(resolved.domain).toBe("bowtie.com.hk");
    expect(state.inserts).toBe(1);
  });

  it("does not cache a transient failure (e.g. Too many subrequests)", async () => {
    // Arrange — a fetch that throws the Workers subrequest-cap error.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Too many subrequests by single Worker invocation.");
      }),
    );
    const { sql, state } = recordingSql();

    // Act
    const resolved = await resolveUrl(sql, "https://vertexaisearch.cloud.google.com/boom");

    // Assert — error surfaced, but nothing written to the cache (no 7-day poison).
    expect(resolved.finalUrl).toBeNull();
    expect(resolved.error).toContain("Too many subrequests");
    expect(state.inserts).toBe(0);
  });
});
