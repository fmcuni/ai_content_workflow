import { describe, expect, it } from "vitest";

import type { Persona, PublishTarget } from "@/lib/types";

import {
  cmsOptionLabel,
  cmsTag,
  decodeSlug,
  fmtCreator,
  fmtDate,
  fmtDateTime,
  resolveTarget,
  voiceName,
} from "./fmt";

// Minimal valid fixtures for the persona/target maps. Only the fields the
// helpers read matter; the rest satisfy the type.
function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    persona_id: "p1",
    slug: "bowtie-editor",
    name: "Bowtie Editor",
    voice_rules: [],
    banned_terms: [],
    required_phrasings: [],
    disclaimer_templates: {},
    tone_examples: {},
    glossary: [],
    publish_target_id: null,
    is_archived: false,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

function makeTarget(overrides: Partial<PublishTarget> = {}): PublishTarget {
  return {
    publish_target_id: "t1",
    name: "VHIS101 WP",
    kind: "wordpress",
    auth_ref: "VHIS101_WP",
    status: "active",
    is_archived: false,
    ...overrides,
  };
}

describe("fmtDate", () => {
  it("slices an ISO timestamp down to the date", () => {
    expect(fmtDate("2026-06-12T09:30:00Z")).toBe("2026-06-12");
  });

  it("returns the em-dash placeholder for null / empty", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate("")).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
  });
});

describe("fmtDateTime", () => {
  it("slices to minute precision and swaps the T for a space", () => {
    expect(fmtDateTime("2026-06-12T09:30:00Z")).toBe("2026-06-12 09:30");
  });

  it("returns the em-dash placeholder for null", () => {
    expect(fmtDateTime(null)).toBe("—");
  });
});

describe("fmtCreator", () => {
  it("strips the @domain from an email", () => {
    expect(fmtCreator("franco.ma@bowtie.com.sg")).toBe("franco.ma");
  });

  it("collapses system sentinels to 'system'", () => {
    expect(fmtCreator("system:generated")).toBe("system");
  });

  it("returns the em-dash placeholder for null/empty", () => {
    expect(fmtCreator(null)).toBe("—");
    expect(fmtCreator("   ")).toBe("—");
  });

  it("passes a bare token through unchanged", () => {
    expect(fmtCreator("dev")).toBe("dev");
  });
});

describe("decodeSlug", () => {
  it("prefers wp_slug and leads with a single slash", () => {
    expect(decodeSlug({ wp_slug: "my-post", article_url: "" })).toBe("/my-post");
  });

  it("trims leading slashes off an explicit slug", () => {
    expect(decodeSlug({ wp_slug: "/already-leading", article_url: "" })).toBe("/already-leading");
  });

  it("falls back to the last path segment of article_url", () => {
    expect(decodeSlug({ article_url: "https://gobowtie.com/blog/health-tips" })).toBe(
      "/health-tips",
    );
  });

  it("percent-decodes a CJK slug", () => {
    // "/兒童" percent-encoded.
    const encoded = "%E5%85%92%E7%AB%A5";
    expect(decodeSlug({ wp_slug: encoded, article_url: "" })).toBe("/兒童");
  });

  it("returns null when neither slug nor url is present", () => {
    expect(decodeSlug({ wp_slug: null, article_url: "" })).toBeNull();
    expect(decodeSlug({ article_url: "" })).toBeNull();
  });

  it("falls back to the raw slug when the %-escape is malformed", () => {
    expect(decodeSlug({ wp_slug: "bad%ZZescape", article_url: "" })).toBe("/bad%ZZescape");
  });
});

describe("cmsTag", () => {
  it("maps ghost to GT (case-insensitive)", () => {
    expect(cmsTag("ghost")).toBe("GT");
    expect(cmsTag("Ghost")).toBe("GT");
  });

  it("maps wordpress / undefined / unknown to WP", () => {
    expect(cmsTag("wordpress")).toBe("WP");
    expect(cmsTag(undefined)).toBe("WP");
    expect(cmsTag(null)).toBe("WP");
    expect(cmsTag("something-else")).toBe("WP");
  });
});

describe("resolveTarget", () => {
  it("resolves persona → publish_target_id → target", () => {
    const persona = makePersona({ slug: "vhis", publish_target_id: "t1" });
    const target = makeTarget({ publish_target_id: "t1", name: "VHIS101 WP", kind: "wordpress" });
    const personaBySlug = new Map([["vhis", persona]]);
    const targetById = new Map([["t1", target]]);

    expect(resolveTarget({ persona: "vhis" }, personaBySlug, targetById)).toEqual({
      name: "VHIS101 WP",
      tag: "WP",
    });
  });

  it("carries the Ghost tag through to the resolved target", () => {
    const persona = makePersona({ slug: "g", publish_target_id: "tg" });
    const target = makeTarget({ publish_target_id: "tg", name: "Ghost Blog", kind: "ghost" });
    const got = resolveTarget(
      { persona: "g" },
      new Map([["g", persona]]),
      new Map([["tg", target]]),
    );
    expect(got).toEqual({ name: "Ghost Blog", tag: "GT" });
  });

  it("returns the default when persona is null", () => {
    expect(resolveTarget({ persona: null }, new Map(), new Map())).toEqual({
      name: "Bowtie (default)",
      tag: "WP",
    });
  });

  it("returns the default when the target is missing from the map", () => {
    const persona = makePersona({ slug: "vhis", publish_target_id: "missing" });
    const got = resolveTarget({ persona: "vhis" }, new Map([["vhis", persona]]), new Map());
    expect(got).toEqual({ name: "Bowtie (default)", tag: "WP" });
  });
});

describe("voiceName", () => {
  it("returns the persona display name when present in the map", () => {
    const persona = makePersona({ slug: "vhis", name: "VHIS Voice" });
    expect(voiceName({ persona: "vhis" }, new Map([["vhis", persona]]))).toBe("VHIS Voice");
  });

  it("falls back to the raw slug when the persona is missing from the map", () => {
    expect(voiceName({ persona: "orphan-slug" }, new Map())).toBe("orphan-slug");
  });

  it("returns null when the run has no persona", () => {
    expect(voiceName({ persona: null }, new Map())).toBeNull();
  });
});

describe("cmsOptionLabel", () => {
  it("formats as `name · TAG#id`", () => {
    expect(cmsOptionLabel("Alice Chan", "WP", 1)).toBe("Alice Chan · WP#1");
    expect(cmsOptionLabel("News", "GT", 42)).toBe("News · GT#42");
  });
});
