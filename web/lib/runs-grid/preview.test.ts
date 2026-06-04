import { describe, expect, it } from "vitest";

import { auditSummary, costLine, extractH2s, formatCostCents } from "@/lib/runs-grid/preview";
import type { Audit, RunCost } from "@/lib/types";

function audit(overrides: Partial<Audit> = {}): Audit {
  return {
    overall_pass: true,
    severity_high: 0,
    severity_medium: 0,
    severity_low: 0,
    llm_findings: { findings: [] },
    deterministic_findings: { findings: [] },
    ...overrides,
  };
}

describe("extractH2s", () => {
  it("returns [] for empty/nullish bodies", () => {
    expect(extractH2s("")).toEqual([]);
    expect(extractH2s(null)).toEqual([]);
    expect(extractH2s(undefined)).toEqual([]);
  });

  it("pulls H2 text in document order, de-tagging and decoding entities", () => {
    const html = "<h1>T</h1><p>x</p><h2>症狀與成因</h2><h2>保障 &amp; <strong>保險</strong></h2>";
    expect(extractH2s(html)).toEqual(["症狀與成因", "保障 & 保險"]);
  });

  it("trims whitespace and skips empty headings", () => {
    const html = "<h2>  常見問題  </h2><h2></h2><h2>   </h2>";
    expect(extractH2s(html)).toEqual(["常見問題"]);
  });

  it("matches H2s with attributes and is case-insensitive", () => {
    const html = '<H2 id="a" class="b">最新數據</H2>';
    expect(extractH2s(html)).toEqual(["最新數據"]);
  });

  it("decodes numeric entities", () => {
    expect(extractH2s("<h2>A&#38;B</h2>")).toEqual(["A&B"]);
  });

  it("caps at N and collapses the overflow into a +N more chip", () => {
    const html = Array.from({ length: 8 }, (_, i) => `<h2>H${i}</h2>`).join("");
    expect(extractH2s(html, 6)).toEqual(["H0", "H1", "H2", "H3", "H4", "H5", "+2 more"]);
  });

  it("does not add a more-chip when exactly at the cap", () => {
    const html = Array.from({ length: 6 }, (_, i) => `<h2>H${i}</h2>`).join("");
    expect(extractH2s(html, 6)).toHaveLength(6);
  });
});

describe("auditSummary", () => {
  it("maps a present audit to verdict + severity counts", () => {
    expect(
      auditSummary(audit({ overall_pass: false, severity_high: 2, severity_medium: 1, severity_low: 3 })),
    ).toEqual({ pass: false, high: 2, medium: 1, low: 3 });
  });

  it("treats a missing audit as a non-pass with zero findings", () => {
    expect(auditSummary(null)).toEqual({ pass: false, high: 0, medium: 0, low: 0 });
    expect(auditSummary(undefined)).toEqual({ pass: false, high: 0, medium: 0, low: 0 });
  });
});

describe("formatCostCents", () => {
  it("formats integer cents as HK$ with two decimals", () => {
    expect(formatCostCents(186)).toBe("HK$ 1.86");
    expect(formatCostCents(0)).toBe("HK$ 0.00");
  });

  it("returns — when no cost is known", () => {
    expect(formatCostCents(null)).toBe("—");
    expect(formatCostCents(undefined)).toBe("—");
  });
});

describe("costLine", () => {
  it("joins cost and iteration count", () => {
    const cost: RunCost = { tokens_in: 1, tokens_out: 2, thinking_tokens: 0, est_usd_cents: 244 };
    expect(costLine(cost, 2)).toBe("HK$ 2.44 · 2 it");
  });

  it("renders — for cost when usage is unknown", () => {
    expect(costLine(null, 0)).toBe("— · 0 it");
  });
});
