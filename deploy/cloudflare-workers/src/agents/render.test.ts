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

  it("strips a block-form defterm whose name has spaces (Malaysia voices)", () => {
    // Regression for runs e509ceb3 / 0bc89ae6: Malay multi-word names like
    // "Surat Rujukan" / "Klinik Kesihatan" broke the old `name=(\S+?)` (it
    // stopped at the first space), so the block survived and tripped the residue
    // guard, erroring the whole run.
    const markup = [
      "# Panduan Rujukan",
      "%%meta desc=d%%",
      "",
      "Pesakit perlu mengambil nombor giliran.",
      "",
      "%%defterm name=Surat Rujukan%%",
      "Surat daripada doktor kepada pakar.",
      "%%end%%",
      "",
      "%%defterm name=Klinik Kesihatan%%",
      "Klinik kerajaan untuk rawatan asas.",
      "%%end%%",
    ].join("\n");

    const out = renderHtml(markup);

    expect(out.htmlBody).not.toContain("%%defterm");
    expect(out.htmlBody).not.toContain("%%end%%");
    expect(out.schemaJsonld).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "DefinedTermSet",
        hasDefinedTerm: [
          {
            "@type": "DefinedTerm",
            name: "Surat Rujukan",
            description: "Surat daripada doktor kepada pakar.",
          },
          {
            "@type": "DefinedTerm",
            name: "Klinik Kesihatan",
            description: "Klinik kerajaan untuk rawatan asas.",
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

  // Stored-XSS regression suite (bowtie-ins#14): raw HTML that slips past the
  // blocklist tripwire must render as inert escaped text, and FAQ text fields
  // must be escaped before template interpolation.
  describe("XSS hardening", () => {
    const wrap = (body: string) => `# Title\n%%meta desc=d%%\n\n${body}\n`;

    it("escapes raw inline HTML in the body instead of passing it through", () => {
      const out = renderHtml(wrap('<img src=x onerror=alert(1)> and <svg onload=alert(1)>'));
      expect(out.htmlBody).not.toMatch(/<img|<svg/i);
      expect(out.htmlBody).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(out.htmlBody).toContain("&lt;svg onload=alert(1)&gt;");
    });

    it("neutralises a raw <a href=javascript:> anchor in the body", () => {
      const out = renderHtml(wrap('<a href="javascript:alert(1)">click</a>'));
      expect(out.htmlBody).not.toContain('href="javascript:');
      expect(out.htmlBody).toContain("&lt;a href=");
    });

    it("refuses a javascript: URL written as a markdown link", () => {
      const out = renderHtml(wrap("[click](javascript:alert(1))"));
      expect(out.htmlBody).not.toContain('href="javascript:');
    });

    it("escapes FAQ question/answer text before pasting into the widget HTML", () => {
      const markup = [
        "# Title",
        "%%meta desc=d%%",
        "",
        "Intro.",
        "",
        "## 常見問題",
        "%%acf_faq type=q%%",
        '<svg onload=alert(1)>Q?',
        "%%acf_faq type=a%%",
        '<img src=x onerror=alert(1)> A "quoted" answer',
        "%%end%%",
      ].join("\n");
      const out = renderHtml(markup);
      expect(out.htmlBody).not.toMatch(/<img|<svg/i);
      expect(out.htmlBody).toContain(
        '<div class="e-faq__head">&lt;svg onload=alert(1)&gt;Q?<span',
      );
      expect(out.htmlBody).toContain(
        "<p>&lt;img src=x onerror=alert(1)&gt; A &quot;quoted&quot; answer</p>",
      );
      // JSON-LD keeps the raw text — escaping is an HTML concern only.
      expect(out.faqSchemaJsonld).toMatchObject({
        mainEntity: [{ name: "<svg onload=alert(1)>Q?" }],
      });
    });

    it("escapes a writer-controlled FAQ heading in the injected <h2>", () => {
      const markup = [
        "# Title",
        "%%meta desc=d%%",
        "",
        "## FAQ <svg onload=alert(1)>",
        "%%acf_faq type=q%%",
        "Q?",
        "%%acf_faq type=a%%",
        "A.",
        "%%end%%",
      ].join("\n");
      const out = renderHtml(markup);
      expect(out.htmlBody).toContain("<h2>FAQ &lt;svg onload=alert(1)&gt;</h2>");
      expect(out.htmlBody).not.toMatch(/<svg/i);
    });

    it("still hard-fails the blocklist tripwire on <script>", () => {
      expect(() => renderHtml(wrap("<script>alert(1)</script>"))).toThrow("sanitization");
    });

    it("escapes a bare ampersand and single quote exactly once (no double-escape)", () => {
      const markup = [
        "# Title",
        "%%meta desc=d%%",
        "",
        "## FAQ & more",
        "%%acf_faq type=q%%",
        "Q&A or 'quotes'?",
        "%%acf_faq type=a%%",
        "R&D & more",
        "%%end%%",
      ].join("\n");
      const out = renderHtml(markup);
      expect(out.htmlBody).toContain(
        '<div class="e-faq__head">Q&amp;A or &#x27;quotes&#x27;?<span',
      );
      expect(out.htmlBody).toContain("<p>R&amp;D &amp; more</p>");
      expect(out.htmlBody).toContain("<h2>FAQ &amp; more</h2>");
      expect(out.htmlBody).not.toContain("&amp;amp;");
    });
  });
});
