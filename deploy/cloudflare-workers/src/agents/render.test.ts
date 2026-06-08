import { describe, expect, it } from "vitest";

import { renderHtml } from "./render";

describe("renderHtml", () => {
  it("extracts H1 as seo_title and %%meta desc%% as meta_description", () => {
    // Arrange
    const markup = "# My Title\n%%meta desc=A short description%%\n\nFirst paragraph.";

    // Act
    const out = renderHtml(markup);

    // Assert
    expect(out.seoTitle).toBe("My Title");
    expect(out.metaDescription).toBe("A short description");
    expect(out.htmlBody).toContain("<p>First paragraph.</p>");
    expect(out.excerptSuggestion).toBe("First paragraph.");
    expect(out.slugSuggestion).toBe("");
  });

  it("throws when the first line is not an H1", () => {
    expect(() => renderHtml("No heading here\n%%meta desc=x%%")).toThrow(
      "first markdown line must be '# H1'",
    );
  });

  it("throws when the meta description is missing", () => {
    expect(() => renderHtml("# Title\n\nBody only")).toThrow("missing %%meta desc=...%%");
  });

  it("builds the FAQ widget HTML and FAQPage JSON-LD from one FAQ block", () => {
    // Arrange
    const markup = [
      "# Title",
      "%%meta desc=d%%",
      "",
      "Intro paragraph.",
      "",
      "## 常見問題",
      "%%acf_faq type=q%%",
      "What is X?",
      "%%acf_faq type=a%%",
      "X is a thing.",
      "%%end%%",
    ].join("\n");

    // Act
    const out = renderHtml(markup);

    // Assert — widget structure matches the Python builder exactly.
    expect(out.htmlBody).toContain("<h2>常見問題</h2>");
    expect(out.htmlBody).toContain('<div class="editor__item editor__faq">');
    expect(out.htmlBody).toContain('  <div class="e-faq__wrap">');
    expect(out.htmlBody).toContain('    <div class="e-faq__list is--active">');
    expect(out.htmlBody).toContain(
      '      <div class="e-faq__head">What is X?<span class="e-faq__icon icon-add"></span></div>',
    );
    expect(out.htmlBody).toContain('      <div class="e-faq__body" style="display: block;">');
    expect(out.htmlBody).toContain("        <p>X is a thing.</p>");
    // Raw FAQ markers must be stripped from the body.
    expect(out.htmlBody).not.toContain("%%acf_faq");
    expect(out.htmlBody).not.toContain("常見問題\n%%");

    // FAQPage JSON-LD, out-of-band only (no inline script tag).
    expect(out.faqSchemaJsonld).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "What is X?",
          acceptedAnswer: { "@type": "Answer", text: "X is a thing." },
        },
      ],
    });
    expect(out.schemaJsonld).toEqual([out.faqSchemaJsonld]);
    expect(out.htmlBody).not.toContain("application/ld+json");
  });

  it("marks only the first FAQ item active", () => {
    // Arrange
    const markup = [
      "# T",
      "%%meta desc=d%%",
      "",
      "%%acf_faq type=q%%",
      "Q1",
      "%%acf_faq type=a%%",
      "A1",
      "%%end%%",
      "%%acf_faq type=q%%",
      "Q2",
      "%%acf_faq type=a%%",
      "A2",
      "%%end%%",
    ].join("\n");

    // Act
    const out = renderHtml(markup);

    // Assert
    expect(out.htmlBody).toContain('<div class="e-faq__list is--active">');
    expect(out.htmlBody).toContain('<div class="e-faq__list">');
    expect(out.htmlBody).toContain('<div class="e-faq__body" style="display: block;">');
    expect(out.htmlBody).toContain('<div class="e-faq__body">');
  });

  it("extracts a defterm into DefinedTermSet, strips the block, and leaves no residue", () => {
    // Arrange — block form (newlines) is stripped entirely from the body.
    const markup = [
      "# T",
      "%%meta desc=d%%",
      "",
      "Some intro about insurance.",
      "",
      "%%defterm name=自願醫保%%",
      "A voluntary health insurance scheme.",
      "%%end%%",
    ].join("\n");

    // Act
    const out = renderHtml(markup);

    // Assert
    expect(out.htmlBody).not.toContain("%%defterm");
    expect(out.htmlBody).not.toContain("%%end%%");
    expect(out.schemaJsonld).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "DefinedTermSet",
        hasDefinedTerm: [
          {
            "@type": "DefinedTerm",
            name: "自願醫保",
            description: "A voluntary health insurance scheme.",
          },
        ],
      },
    ]);
    expect(out.faqSchemaJsonld).toBeNull();
  });

  it("keeps the bare term name for an inline defterm and dedups by name", () => {
    // Arrange — inline form (no newline) is replaced with the bare term name.
    const markup = [
      "# T",
      "%%meta desc=d%%",
      "",
      "「%%defterm name=VHIS%%自願醫保計劃%%end%%」是一個計劃。",
      "",
      "%%defterm name=VHIS%%",
      "Duplicate definition — first wins.",
      "%%end%%",
    ].join("\n");

    // Act
    const out = renderHtml(markup);

    // Assert — inline occurrence collapses to the term name.
    expect(out.htmlBody).toContain("「VHIS」是一個計劃");
    // Dedup: only one DefinedTerm, first description wins.
    expect(out.schemaJsonld).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "DefinedTermSet",
        hasDefinedTerm: [
          {
            "@type": "DefinedTerm",
            name: "VHIS",
            description: "自願醫保計劃",
          },
        ],
      },
    ]);
  });

  it("throws when a half-formed defterm marker survives stripping", () => {
    const markup = "# T\n%%meta desc=d%%\n\nBroken %%defterm name=X%% with no close.";
    expect(() => renderHtml(markup)).toThrow(/unhandled defterm marker survived stripping/);
  });

  it("replaces adv_panel and page_widget shortcodes with WP bracket syntax", () => {
    // Arrange
    const markup = "# T\n%%meta desc=d%%\n\n%%adv_panel id=123%%\n\n%%page_widget id=456%%";

    // Act
    const out = renderHtml(markup);

    // Assert
    expect(out.htmlBody).toContain('[adv_panel id="123"]');
    expect(out.htmlBody).toContain('[page_widget id="456"]');
    expect(out.htmlBody).not.toContain("%%adv_panel");
    expect(out.htmlBody).not.toContain("%%page_widget");
  });

  it("rejects markup containing a raw <script> tag", () => {
    const markup = "# T\n%%meta desc=d%%\n\n<script>alert(1)</script>";
    expect(() => renderHtml(markup)).toThrow("html sanitization failed");
  });

  it.each(["style", "iframe", "object", "embed"])(
    "rejects markup containing a raw <%s> tag (case-insensitive)",
    (tag) => {
      const markup = `# T\n%%meta desc=d%%\n\n<${tag.toUpperCase()} foo>`;
      expect(() => renderHtml(markup)).toThrow("html sanitization failed");
    },
  );

  it("renders the 資訊來源 section after the FAQ widget", () => {
    // Arrange
    const markup = [
      "# T",
      "%%meta desc=d%%",
      "",
      "Body text.",
      "",
      "%%acf_faq type=q%%",
      "Q1",
      "%%acf_faq type=a%%",
      "A1",
      "%%end%%",
      "",
      "## 資訊來源",
      "",
      "- [Source](https://example.com)",
    ].join("\n");

    // Act
    const out = renderHtml(markup);

    // Assert — sources appear after the FAQ widget in the body.
    const faqIdx = out.htmlBody.indexOf("editor__faq");
    const sourcesIdx = out.htmlBody.indexOf("資訊來源");
    expect(faqIdx).toBeGreaterThan(-1);
    expect(sourcesIdx).toBeGreaterThan(faqIdx);
    expect(out.htmlBody).toContain('<a href="https://example.com">Source</a>');
  });

  it("carries through a Simplified FAQ heading instead of duplicating it", () => {
    // Arrange — a zh-MY voice writes its own Simplified heading + Simplified
    // sources section (emitted by resolve_citations).
    const markup = [
      "# 标题",
      "%%meta desc=d%%",
      "",
      "正文。",
      "",
      "## 常见问题",
      "%%acf_faq type=q%%",
      "什么是 X？",
      "%%acf_faq type=a%%",
      "X 是一种东西。",
      "%%end%%",
      "",
      "## 资讯来源",
      "1. [Source](https://example.com)",
    ].join("\n");

    // Act
    const out = renderHtml(markup);

    // Assert — the model's Simplified heading is re-injected, not a hard-coded
    // Traditional one (no duplicate), and sources render in Simplified.
    expect(out.htmlBody).toContain("<h2>常见问题</h2>");
    expect(out.htmlBody).not.toContain("常見問題");
    expect(out.htmlBody).toContain("<h2>资讯来源</h2>");
    expect(out.htmlBody).not.toContain("資訊來源");
    const faqIdx = out.htmlBody.indexOf("editor__faq");
    const sourcesIdx = out.htmlBody.indexOf("资讯来源");
    expect(sourcesIdx).toBeGreaterThan(faqIdx);
  });

  it("renders a markdown table (commonmark + table rule enabled)", () => {
    // Arrange
    const markup = ["# T", "%%meta desc=d%%", "", "| a | b |", "|---|---|", "| 1 | 2 |"].join(
      "\n",
    );

    // Act
    const out = renderHtml(markup);

    // Assert
    expect(out.htmlBody).toContain("<table>");
    expect(out.htmlBody).toContain("<th>a</th>");
  });
});
