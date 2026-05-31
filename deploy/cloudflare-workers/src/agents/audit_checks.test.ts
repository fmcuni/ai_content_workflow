import { describe, expect, it } from "vitest";

import { runDeterministicChecks } from "./audit_checks";
import type { AuditFinding } from "./schemas";

// A fully-conformant draft: contains every required marker, no denied citation
// displayed, and a FAQPage schema piece backing the FAQ widget. This must
// produce ZERO deterministic findings.
const PASSING_HTML =
  '<p>Intro paragraph.</p>\n[adv_panel id="12"]\n[page_widget id="34"]\n' +
  '<div class="editor__item editor__faq"><div class="e-faq__wrap"></div></div>\n' +
  "<h2>資訊來源</h2>\n<ul><li>source</li></ul>";

const FAQPAGE_SCHEMA: object[] = [{ "@context": "https://schema.org", "@type": "FAQPage" }];

function ids(findings: AuditFinding[]): string[] {
  return findings.map((f) => f.id);
}

describe("runDeterministicChecks", () => {
  it("returns no findings for a fully-conformant draft", () => {
    const findings = runDeterministicChecks({
      htmlBody: PASSING_HTML,
      citationsDeniedDisplayed: false,
      schemaJsonld: FAQPAGE_SCHEMA,
    });

    expect(findings).toEqual([]);
  });

  it("fires det-fmt-adv when the adv_panel shortcode is missing", () => {
    const html = PASSING_HTML.replace('[adv_panel id="12"]\n', "");

    const findings = runDeterministicChecks({
      htmlBody: html,
      citationsDeniedDisplayed: false,
      schemaJsonld: FAQPAGE_SCHEMA,
    });

    expect(ids(findings)).toEqual(["det-fmt-adv"]);
    const f = findings[0];
    expect(f).toMatchObject({
      id: "det-fmt-adv",
      category: "format",
      severity: "high",
      location: "body",
      issue: "缺少 [adv_panel id=...] shortcode",
      suggested_fix: "在首段後加入 adv_panel shortcode",
      must_fix: true,
    });
  });

  it("fires det-fmt-widget when the page_widget shortcode is missing", () => {
    const html = PASSING_HTML.replace('[page_widget id="34"]\n', "");

    const findings = runDeterministicChecks({
      htmlBody: html,
      citationsDeniedDisplayed: false,
      schemaJsonld: FAQPAGE_SCHEMA,
    });

    expect(ids(findings)).toEqual(["det-fmt-widget"]);
    expect(findings[0]).toMatchObject({
      category: "format",
      severity: "high",
      location: "body",
      issue: "缺少 [page_widget id=...] shortcode",
      suggested_fix: "在常見問題前加入 page_widget shortcode",
      must_fix: true,
    });
  });

  it("fires det-fmt-sources when the 資訊來源 section is missing", () => {
    const html = PASSING_HTML.replace("<h2>資訊來源</h2>\n", "");

    const findings = runDeterministicChecks({
      htmlBody: html,
      citationsDeniedDisplayed: false,
      schemaJsonld: FAQPAGE_SCHEMA,
    });

    expect(ids(findings)).toEqual(["det-fmt-sources"]);
    expect(findings[0]).toMatchObject({
      category: "format",
      severity: "high",
      location: "tail",
      issue: "缺少 <h2>資訊來源</h2> section",
      suggested_fix: "確保 resolve_citations 已產生資訊來源 section",
      must_fix: true,
    });
  });

  it("fires det-fmt-faq (and det-fmt-jsonld is gated off) when the FAQ widget is missing", () => {
    const html = PASSING_HTML.replace(
      '<div class="editor__item editor__faq"><div class="e-faq__wrap"></div></div>\n',
      "",
    );

    const findings = runDeterministicChecks({
      htmlBody: html,
      citationsDeniedDisplayed: false,
      schemaJsonld: null,
    });

    // No FAQ widget → det-fmt-faq fires, det-fmt-jsonld does NOT (gated on widget).
    expect(ids(findings)).toEqual(["det-fmt-faq"]);
    expect(findings[0]).toMatchObject({
      category: "format",
      severity: "high",
      location: "tail",
      issue: "缺少 Bowtie FAQ widget div",
      suggested_fix: "render_html 必須輸出 editor__faq 結構",
      must_fix: true,
    });
  });

  it("fires det-fmt-jsonld when the FAQ widget exists but schema has no FAQPage", () => {
    const findings = runDeterministicChecks({
      htmlBody: PASSING_HTML,
      citationsDeniedDisplayed: false,
      schemaJsonld: [{ "@type": "DefinedTermSet" }],
    });

    expect(ids(findings)).toEqual(["det-fmt-jsonld"]);
    expect(findings[0]).toMatchObject({
      category: "format",
      severity: "high",
      location: "head",
      issue: "FAQ widget 存在但 schema_jsonld 缺少 FAQPage",
      suggested_fix:
        "render_html 必須輸出 FAQPage 至 schema_jsonld (經 post meta 交付, 不再注入 body)",
      must_fix: true,
    });
  });

  it("fires det-fmt-jsonld when the FAQ widget exists but schemaJsonld is null", () => {
    const findings = runDeterministicChecks({
      htmlBody: PASSING_HTML,
      citationsDeniedDisplayed: false,
      schemaJsonld: null,
    });

    expect(ids(findings)).toEqual(["det-fmt-jsonld"]);
  });

  it("fires det-cite-denied when a policy-denied citation was displayed", () => {
    const findings = runDeterministicChecks({
      htmlBody: PASSING_HTML,
      citationsDeniedDisplayed: true,
      schemaJsonld: FAQPAGE_SCHEMA,
    });

    expect(ids(findings)).toEqual(["det-cite-denied"]);
    expect(findings[0]).toMatchObject({
      category: "citation",
      severity: "high",
      location: "資訊來源",
      issue: "顯示了被 policy 拒絕的來源",
      suggested_fix: "改用 GOV / EDU 等高可信來源",
      must_fix: true,
    });
  });

  it("appends findings in source order when every check trips", () => {
    const findings = runDeterministicChecks({
      htmlBody: "<p>empty draft</p>",
      citationsDeniedDisplayed: true,
      schemaJsonld: null,
    });

    // No FAQ widget, so det-fmt-jsonld is gated off; order matches the Python
    // append sequence for the remaining checks.
    expect(ids(findings)).toEqual([
      "det-fmt-adv",
      "det-fmt-widget",
      "det-fmt-sources",
      "det-fmt-faq",
      "det-cite-denied",
    ]);
  });
});
