import { describe, expect, it } from "vitest";

import { runDeterministicChecks } from "./audit_checks";
import { renderHtml } from "./render";

// B1 — sources/FAQ heading driven by VoiceLocale (the live bug fix), TS mirror
// of tests/unit/test_voice_locale_headings.py. The HK-ZH default path MUST stay
// byte-identical; a voice with an English locale must render English headings
// and PASS audit.

const ZH_MD = [
  "# 大腸癌篩查指南",
  "%%meta desc=了解大腸癌篩查。%%",
  "",
  "大腸癌是香港常見的癌症之一。",
  "",
  "%%adv_panel id=1%%",
  "",
  "%%page_widget id=2%%",
  "",
  "## 常見問題",
  "%%acf_faq type=q%%",
  "篩查資格是什麼？",
  "%%acf_faq type=a%%",
  "50 至 75 歲香港居民。",
  "%%end%%",
  "",
  "## 資訊來源",
  "1. [www.ia.org.hk](https://www.ia.org.hk/x)",
  "",
].join("\n");

const EN_MD = [
  "# Colorectal Cancer Screening Guide",
  "%%meta desc=Learn about colorectal cancer screening.%%",
  "",
  "Colorectal cancer is common in Malaysia.",
  "",
  "%%adv_panel id=1%%",
  "",
  "%%page_widget id=2%%",
  "",
  "## Frequently Asked Questions",
  "%%acf_faq type=q%%",
  "Who is eligible?",
  "%%acf_faq type=a%%",
  "Residents aged 50 to 75.",
  "%%end%%",
  "",
  "## Sources",
  "1. [www.moh.gov.my](https://www.moh.gov.my/x)",
  "",
].join("\n");

const FAQPAGE: object[] = [{ "@context": "https://schema.org", "@type": "FAQPage" }];

const ZH_AUDIT_HTML =
  '<p>Intro.</p>\n[adv_panel id="1"]\n[page_widget id="2"]\n' +
  '<div class="editor__item editor__faq"></div>\n<h2>資訊來源</h2>';
const EN_AUDIT_HTML =
  '<p>Intro.</p>\n[adv_panel id="1"]\n[page_widget id="2"]\n' +
  '<div class="editor__item editor__faq"></div>\n<h2>Sources</h2>';

function ids(findings: { id: string }[]): string[] {
  return findings.map((f) => f.id);
}

describe("renderHtml — default (HK-ZH) path is byte-identical", () => {
  it("renders the Traditional FAQ + sources headings with no opts", () => {
    const out = renderHtml(ZH_MD);
    expect(out.htmlBody).toContain("<h2>常見問題</h2>");
    expect(out.htmlBody).toContain("資訊來源");
    expect(out.htmlBody).not.toContain("Sources");
  });

  it("falls back to 常見問題 when the model wrote no FAQ heading", () => {
    const md = ZH_MD.replace("## 常見問題\n", "");
    const out = renderHtml(md);
    expect(out.htmlBody).toContain("<h2>常見問題</h2>");
  });

  it("passing only faqHeading still recognises both Chinese sources scripts", () => {
    const simplified = ZH_MD.replace("資訊來源", "资讯来源");
    const out = renderHtml(simplified, { faqHeading: "常見問題" });
    // sourcesHeading defaulted to null → Simplified heading still split + kept.
    expect(out.htmlBody).toContain("资讯来源");
  });
});

describe("renderHtml — English voice locale", () => {
  it("uses the configured FAQ fallback + English sources split", () => {
    const md = EN_MD.replace("## Frequently Asked Questions\n", "");
    const out = renderHtml(md, {
      faqHeading: "Frequently Asked Questions",
      sourcesHeading: "Sources",
    });
    expect(out.htmlBody).toContain("<h2>Frequently Asked Questions</h2>");
    expect(out.htmlBody).toContain("<h2>Sources</h2>");
    expect(out.htmlBody).toContain("www.moh.gov.my");
    expect(out.htmlBody).not.toContain("資訊來源");
    expect(out.htmlBody).not.toContain("常見問題");
  });

  it("re-orders the configured sources section after the FAQ widget", () => {
    const out = renderHtml(EN_MD, {
      faqHeading: "Frequently Asked Questions",
      sourcesHeading: "Sources",
    });
    const body = out.htmlBody;
    expect(body.indexOf('class="editor__item editor__faq"')).toBeLessThan(
      body.indexOf("<h2>Sources</h2>"),
    );
  });
});

describe("runDeterministicChecks — sources <h2> gate", () => {
  it("default (no sourcesHeading) accepts both Chinese scripts", () => {
    expect(
      ids(
        runDeterministicChecks({
          htmlBody: ZH_AUDIT_HTML,
          citationsDeniedDisplayed: false,
          schemaJsonld: FAQPAGE,
        }),
      ),
    ).not.toContain("det-fmt-sources");

    const simplified = ZH_AUDIT_HTML.replace("<h2>資訊來源</h2>", "<h2>资讯来源</h2>");
    expect(
      ids(
        runDeterministicChecks({
          htmlBody: simplified,
          citationsDeniedDisplayed: false,
          schemaJsonld: FAQPAGE,
        }),
      ),
    ).not.toContain("det-fmt-sources");
  });

  it("English voice passes with its configured heading", () => {
    const findings = runDeterministicChecks({
      htmlBody: EN_AUDIT_HTML,
      citationsDeniedDisplayed: false,
      schemaJsonld: FAQPAGE,
      sourcesHeading: "Sources",
    });
    expect(findings).toEqual([]);
  });

  it("flags a Chinese heading when an English heading is configured", () => {
    const findings = runDeterministicChecks({
      htmlBody: ZH_AUDIT_HTML,
      citationsDeniedDisplayed: false,
      schemaJsonld: FAQPAGE,
      sourcesHeading: "Sources",
    });
    expect(ids(findings)).toContain("det-fmt-sources");
  });
});
