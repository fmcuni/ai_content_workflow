import { describe, expect, it } from "vitest";

import {
  decodeSlug,
  hostPath,
  isLivePublish,
  publishLabel,
  runTypeChip,
} from "@/lib/runs-grid/display";
import type { RunSummary } from "@/lib/types";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "r1",
    status: "persisted",
    topic: "Topic",
    article_url: "",
    mode: "auto",
    created_at: "2026-06-01T00:00:00Z",
    chosen_route: null,
    iteration_count: 0,
    ...overrides,
  };
}

describe("decodeSlug", () => {
  it("decodes percent-encoded CJK", () => {
    expect(decodeSlug("%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85")).toBe("手足口病");
  });
  it("passes through already-decoded and empty values", () => {
    expect(decodeSlug("critical-illness-2026")).toBe("critical-illness-2026");
    expect(decodeSlug(null)).toBe("");
    expect(decodeSlug(undefined)).toBe("");
  });
  it("falls back to the raw value on malformed encoding", () => {
    expect(decodeSlug("%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("publishLabel / isLivePublish", () => {
  it("labels the three statuses, defaulting null to Draft", () => {
    expect(publishLabel("draft")).toBe("Draft");
    expect(publishLabel("future")).toBe("Scheduled");
    expect(publishLabel("publish")).toBe("Live");
    expect(publishLabel(null)).toBe("Draft");
  });
  it("flags only publish as live", () => {
    expect(isLivePublish("publish")).toBe(true);
    expect(isLivePublish("draft")).toBe(false);
    expect(isLivePublish(null)).toBe(false);
  });
});

describe("runTypeChip", () => {
  it("marks create runs as New article", () => {
    expect(runTypeChip(run({ start_mode: "create" }))).toEqual({ glyph: "✦", label: "New article" });
  });
  it("splits rewrites by chosen route, falling back to plain Rewrite", () => {
    expect(runTypeChip(run({ chosen_route: "full_rewrite" })).label).toBe("Rewrite · Full");
    expect(runTypeChip(run({ chosen_route: "small_refresh" })).label).toBe("Rewrite · Small");
    expect(runTypeChip(run({ chosen_route: null })).label).toBe("Rewrite");
  });
});

describe("hostPath", () => {
  it("strips scheme + trailing slash from a full URL", () => {
    expect(hostPath("https://bowtie.com.hk/blog/hand-foot-mouth/")).toBe("bowtie.com.hk/blog/hand-foot-mouth");
  });
  it("handles a bare host/path string", () => {
    expect(hostPath("bowtie.com.hk/blog/x")).toBe("bowtie.com.hk/blog/x");
  });
});
