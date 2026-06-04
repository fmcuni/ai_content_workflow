import { describe, expect, it } from "vitest";
import { canonicalizeSlug } from "./slug";

// The encoded form MUST match content_tool/wordpress/slug.py byte-for-byte so
// the two backends store identical slugs (parity).
const ENCODED = "%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85";

describe("canonicalizeSlug", () => {
  it("encodes decoded CJK to the canonical percent-encoded form", () => {
    expect(canonicalizeSlug("手足口病")).toBe(ENCODED);
  });

  it("is idempotent for an already-encoded slug", () => {
    expect(canonicalizeSlug(ENCODED)).toBe(ENCODED);
  });

  it("leaves an ASCII slug's safe characters unescaped", () => {
    expect(canonicalizeSlug("my-article-slug")).toBe("my-article-slug");
  });

  it("trims and treats blank input as null", () => {
    expect(canonicalizeSlug("   ")).toBeNull();
    expect(canonicalizeSlug(null)).toBeNull();
    expect(canonicalizeSlug(undefined)).toBeNull();
  });

  it("treats a malformed percent-sequence as already-decoded", () => {
    // decodeURIComponent("100%") throws → treat as decoded, re-encode the %.
    expect(canonicalizeSlug("100%")).toBe("100%25");
  });
});
