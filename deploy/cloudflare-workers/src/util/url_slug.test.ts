import { describe, expect, it } from "vitest";

import { resolvePostIdForSlug, slugFromUrl } from "./url_slug";

describe("slugFromUrl", () => {
  it("extracts the last segment of a WP blog path with trailing slash", () => {
    expect(slugFromUrl("https://example.com/blog/old-slug/")).toBe("old-slug");
  });

  it("extracts the last segment of a Ghost URL with trailing slash", () => {
    expect(slugFromUrl("https://x.ghost.io/old-slug/")).toBe("old-slug");
  });

  it("ignores query string", () => {
    expect(slugFromUrl("https://example.com/blog/old-slug?utm=1")).toBe("old-slug");
  });

  it("ignores hash fragment", () => {
    expect(slugFromUrl("https://example.com/blog/old-slug#section")).toBe("old-slug");
  });

  it("handles a bare path slug (no scheme)", () => {
    expect(slugFromUrl("old-slug")).toBe("old-slug");
  });

  it("handles a bare path with leading/trailing slash and query", () => {
    expect(slugFromUrl("/blog/old-slug/?x=1")).toBe("old-slug");
  });

  it("decodes percent-encoded segments", () => {
    expect(slugFromUrl("https://example.com/blog/%E4%BD%A0%E5%A5%BD")).toBe("你好");
  });

  it("returns null for null", () => {
    expect(slugFromUrl(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(slugFromUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(slugFromUrl("")).toBeNull();
  });

  it("returns null for a root-only URL", () => {
    expect(slugFromUrl("https://example.com/")).toBeNull();
  });
});

describe("resolvePostIdForSlug", () => {
  it("keeps the existing id when the slug is unchanged (WP number id)", () => {
    expect(resolvePostIdForSlug(4175, "https://wp.example.com/blog/old-slug/", "old-slug")).toBe(
      4175,
    );
  });

  it("forces a create (null) when an already-published WP slug changed", () => {
    expect(
      resolvePostIdForSlug(4175, "https://wp.example.com/blog/old-slug/", "new-slug"),
    ).toBeNull();
  });

  it("forces a create (null) when an already-published Ghost slug changed", () => {
    expect(resolvePostIdForSlug("uuid-1", "https://x.ghost.io/old-slug/", "new-slug")).toBeNull();
  });

  it("keeps the Ghost id when the slug is unchanged", () => {
    expect(resolvePostIdForSlug("uuid-1", "https://x.ghost.io/old-slug/", "old-slug")).toBe(
      "uuid-1",
    );
  });

  it("does NOT force a create on first push (no existing post id)", () => {
    expect(resolvePostIdForSlug(null, null, "new-slug")).toBeNull();
    expect(resolvePostIdForSlug<number>(null, "https://wp.example.com/blog/old-slug/", "new-slug")).toBeNull();
  });

  it("keeps the existing id when the new slug is empty/whitespace", () => {
    expect(resolvePostIdForSlug(4175, "https://wp.example.com/blog/old-slug/", "")).toBe(4175);
    expect(resolvePostIdForSlug(4175, "https://wp.example.com/blog/old-slug/", "   ")).toBe(4175);
    expect(resolvePostIdForSlug(4175, "https://wp.example.com/blog/old-slug/", null)).toBe(4175);
  });

  it("keeps the existing id when the existing URL has no slug", () => {
    expect(resolvePostIdForSlug(4175, "https://wp.example.com/", "new-slug")).toBe(4175);
    expect(resolvePostIdForSlug(4175, null, "new-slug")).toBe(4175);
  });

  it("trims the new slug before comparing (no false create)", () => {
    expect(resolvePostIdForSlug(4175, "https://wp.example.com/blog/old-slug/", "  old-slug  ")).toBe(
      4175,
    );
  });

  it("does NOT force a create for a percent-encoded CJK slug that matches the URL", () => {
    // run.wp_slug is stored percent-encoded; the URL slug decodes to 紫蘇油.
    // Before the fix, encoded-vs-decoded mismatched → spurious create (紫蘇油-2).
    expect(
      resolvePostIdForSlug(
        86556,
        "https://www.bowtie.com.hk/blog/zh/營養貼士/紫蘇油/",
        "%e7%b4%ab%e8%98%87%e6%b2%b9",
      ),
    ).toBe(86556);
  });

  it("still forces a create when a CJK slug genuinely changed", () => {
    expect(
      resolvePostIdForSlug(
        86556,
        "https://www.bowtie.com.hk/blog/zh/營養貼士/紫蘇油/",
        "%e6%a9%84%e6%ac%96%e6%b2%b9", // 橄欖油 — a different slug
      ),
    ).toBeNull();
  });
});
