/**
 * Unit tests for src/refresh/deterministic_checks.ts
 *
 * No DB required. `fetch` is stubbed for the link-check tests.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DeterministicResult,
  checkDatedPhrasing,
  checkMissingFaqJsonld,
  checkHtmlDrift,
  checkBrokenLinks,
  deterministicAuditPublishedHtml,
  type Finding,
} from "./deterministic_checks";

// ---------------------------------------------------------------------------
// dated-phrasing
// ---------------------------------------------------------------------------

describe("checkDatedPhrasing", () => {
  it("flags 'as of <old year>' below the threshold year", () => {
    const html = "<p>As of 2022, the rate was 5%.</p>";
    const findings = checkDatedPhrasing(html, new Date("2026-05-22T00:00:00Z"));
    const asOf = findings.filter((f) => f.id === "det-dated-phrasing");
    expect(asOf.length).toBe(1);
    expect(asOf[0]!.severity).toBe("low");
    expect(asOf[0]!.message.toLowerCase()).toContain("as of 2022");
  });

  it("does not flag a year within the lookback window (threshold_year stays OK)", () => {
    // lookback=1, now=2026 → threshold_year=2025; 2025 is NOT < 2025, so OK.
    const html = "<p>Updated 2025 figures.</p>";
    const findings = checkDatedPhrasing(html, new Date("2026-05-22T00:00:00Z"));
    const old = findings.filter(
      (f) => typeof f.context?.year === "number" && (f.context.year as number) < 2025,
    );
    expect(old).toEqual([]);
  });

  it("flags a bare old-year reference NOT preceded by 'as of'", () => {
    const html = "<p>Back in 2019 things were different.</p>";
    const findings = checkDatedPhrasing(html, new Date("2026-05-22T00:00:00Z"));
    const oldYear = findings.filter((f) => f.id === "det-old-year");
    expect(oldYear.length).toBe(1);
    expect(oldYear[0]!.context?.year).toBe(2019);
  });
});

// ---------------------------------------------------------------------------
// missing FAQ JSON-LD
// ---------------------------------------------------------------------------

describe("checkMissingFaqJsonld", () => {
  it("flags high when FAQ widget present but FAQPage JSON-LD missing", () => {
    const html = `<div>[acf_widget id="faq"]</div>`;
    const findings = checkMissingFaqJsonld(html);
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe("high");
  });

  it("does not flag when FAQPage JSON-LD is present", () => {
    const html = `<div>[acf_widget id="faq"]</div><script type="application/ld+json">{"@type":"FAQPage"}</script>`;
    expect(checkMissingFaqJsonld(html)).toEqual([]);
  });

  it("does not flag when there is no FAQ widget", () => {
    expect(checkMissingFaqJsonld("<p>no widget here</p>")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// structural drift (heading skip)
// ---------------------------------------------------------------------------

describe("checkHtmlDrift", () => {
  it("flags a medium finding for an h2 → h4 skip", () => {
    const html = "<h2>Section</h2><p>x</p><h4>Sub</h4>";
    const findings = checkHtmlDrift(html);
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.context).toEqual({ prev: 2, cur: 4 });
  });

  it("does not flag a well-formed h2 → h3 hierarchy", () => {
    const html = "<h2>Section</h2><h3>Sub</h3>";
    expect(checkHtmlDrift(html)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DeterministicResult pass-threshold
// ---------------------------------------------------------------------------

describe("DeterministicResult.passed", () => {
  function finding(severity: Finding["severity"]): Finding {
    return { id: "x", severity, message: "m", context: null };
  }

  it("passes with zero high and one medium (medium threshold = 1)", () => {
    const r = new DeterministicResult();
    r.add(finding("medium"));
    expect(r.passed).toBe(true);
  });

  it("fails with two medium findings (exceeds medium threshold)", () => {
    const r = new DeterministicResult();
    r.add(finding("medium"));
    r.add(finding("medium"));
    expect(r.passed).toBe(false);
  });

  it("fails with any high finding", () => {
    const r = new DeterministicResult();
    r.add(finding("high"));
    expect(r.passed).toBe(false);
  });

  it("toObject reports correct counts and passed flag", () => {
    const r = new DeterministicResult();
    r.add(finding("low"));
    r.add(finding("medium"));
    const obj = r.toObject();
    expect(obj.severity_high).toBe(0);
    expect(obj.severity_medium).toBe(1);
    expect(obj.severity_low).toBe(1);
    expect(obj.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// broken-link detection (fetch mocked)
// ---------------------------------------------------------------------------

describe("checkBrokenLinks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no findings when all links are OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const html = `<a href="https://example.com/a">a</a>`;
    expect(await checkBrokenLinks(html)).toEqual([]);
  });

  it("flags a medium broken-link finding for a >=400 status (after GET retry)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const html = `<a href="https://example.com/missing">x</a>`;
    const findings = await checkBrokenLinks(html);
    expect(findings.length).toBe(1);
    expect(findings[0]!.id).toBe("det-link-broken");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.context?.status).toBe(404);
  });

  it("skips ignored domains and relative/non-http links", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const html = `
      <a href="https://facebook.com/page">fb</a>
      <a href="/relative/path">rel</a>
      <a href="https://x.com/handle">x</a>
    `;
    expect(await checkBrokenLinks(html)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags a finding when fetch throws (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const html = `<a href="https://example.com/x">x</a>`;
    const findings = await checkBrokenLinks(html);
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.context?.error).toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// full audit composition
// ---------------------------------------------------------------------------

describe("deterministicAuditPublishedHtml", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accumulates findings across all checks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const html = "<h2>Title</h2><h4>Skip</h4><p>As of 2019 this was true.</p>";
    const result = await deterministicAuditPublishedHtml(html);
    // one medium (heading skip) + one low (dated phrasing)
    expect(result.severityMedium).toBe(1);
    expect(result.severityLow).toBeGreaterThanOrEqual(1);
    expect(result.severityHigh).toBe(0);
    // medium == 1 ⇒ passes the threshold
    expect(result.passed).toBe(true);
  });
});
