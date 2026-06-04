import { describe, expect, it } from "vitest";

import { decodeSlug, encodeSlug } from "@/lib/runs-grid/slug";

// The canonical encoded form MUST match the backend canonicalize_slug
// (content_tool/wordpress/slug.py + Workers slug.ts) byte-for-byte.
const ENCODED = "%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85";
const DECODED = "手足口病";

describe("encodeSlug", () => {
  it("encodes decoded CJK to the canonical percent-encoded form", () => {
    expect(encodeSlug(DECODED)).toBe(ENCODED);
  });

  it("is idempotent for an already-encoded slug", () => {
    expect(encodeSlug(ENCODED)).toBe(ENCODED);
  });

  it("leaves an ASCII slug's safe characters unescaped", () => {
    expect(encodeSlug("my-article-slug")).toBe("my-article-slug");
  });

  it("trims surrounding whitespace before encoding", () => {
    expect(encodeSlug("  手足口病  ")).toBe(ENCODED);
  });

  it("returns empty string for blank / nullish input", () => {
    expect(encodeSlug("")).toBe("");
    expect(encodeSlug("   ")).toBe("");
    expect(encodeSlug(null)).toBe("");
    expect(encodeSlug(undefined)).toBe("");
  });
});

describe("decodeSlug", () => {
  it("decodes a stored encoded slug for display", () => {
    expect(decodeSlug(ENCODED)).toBe(DECODED);
  });

  it("falls back to the raw value on invalid percent-encoding", () => {
    expect(decodeSlug("100%")).toBe("100%");
  });

  it("returns empty string for nullish input", () => {
    expect(decodeSlug(null)).toBe("");
    expect(decodeSlug(undefined)).toBe("");
  });
});

describe("slug round-trip", () => {
  it("decodeSlug(encodeSlug(x)) reproduces the human-readable slug", () => {
    for (const x of [DECODED, "my-slug", "café-münchen", ENCODED]) {
      expect(decodeSlug(encodeSlug(x))).toBe(decodeSlug(encodeSlug(decodeSlug(encodeSlug(x)))));
    }
    // Concretely: typing decoded CJK, then re-decoding the stored form, is identity.
    expect(decodeSlug(encodeSlug(DECODED))).toBe(DECODED);
  });
});
