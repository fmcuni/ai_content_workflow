import MarkdownIt from "markdown-it";

/**
 * Output of the HTML render node. Mirrors the Python `RenderResult` dataclass
 * (content_tool/agents/render_html.py) field-for-field so the produced HTML and
 * structured-data graph match what WordPress already ingests.
 */
export interface RenderOutput {
  seoTitle: string;
  metaDescription: string;
  htmlBody: string;
  faqSchemaJsonld: object | null;
  schemaJsonld: object[] | null;
  excerptSuggestion: string;
  slugSuggestion: string;
}

const EXCERPT_MAX_CHARS = 160;

// %%meta desc=...%% — MULTILINE, matched once.
const META_RE = /^%%meta desc=(.*?)%%[ \t]*$/m;
// Shortcodes replaced in the rendered HTML.
const ADV_RE = /%%adv_panel id=(\d+)%%/g;
const WIDGET_RE = /%%page_widget id=(\d+)%%/g;
// Disallowed raw tags — refuse to render rather than ship them to WordPress.
const RAW_HTML_RE = /<\s*(script|style|iframe|object|embed)\b/i;

// %%acf_faq type=q%%\nQ\n%%acf_faq type=a%%\nA\n%%end%%
// `[ \t]*` (not `\s*`) tolerates leading indentation without gobbling blank lines.
const FAQ_BLOCK_RE =
  /%%acf_faq type=q%%[ \t]*\n([\s\S]*?)\n[ \t]*%%acf_faq type=a%%[ \t]*\n([\s\S]*?)\n[ \t]*%%end%%/g;
// %%defterm name=<term>%%\n<description>\n%%end%%
// `name` is a single no-space token per the writer-prompt contract.
const DEFTERM_BLOCK_RE =
  /%%defterm name=(\S+?)%%[ \t]*\n?[ \t]*([\s\S]*?)[ \t]*\n?[ \t]*%%end%%/g;
// Catches any residual marker fragment after well-formed blocks were stripped.
const DEFTERM_RESIDUE_RE = /%%defterm\b|%%end%%/;
// "## 常見問題" line and the "## 資訊來源" section split point.
const FAQ_HEADING_RE = /##\s*常見問題\s*\n/;
const SOURCES_SPLIT_RE = /\n##\s*資訊來源\s*\n/;
// First <p>...</p> in the body, for the excerpt suggestion (DOTALL).
const FIRST_PARAGRAPH_RE = /<p>([\s\S]*?)<\/p>/;

type QaPair = readonly [string, string];

function newMarkdownIt(): MarkdownIt {
  // markdown-it-py used `MarkdownIt("commonmark").enable("table")`: commonmark
  // preset plus the GFM table rule, no other plugins.
  return new MarkdownIt("commonmark").enable(["table"]);
}

function buildFaqHtml(items: readonly QaPair[]): string {
  if (items.length === 0) {
    return "";
  }
  const parts: string[] = [
    '<div class="editor__item editor__faq">',
    '  <div class="e-faq__wrap">',
  ];
  items.forEach(([q, a], i) => {
    const active = i === 0 ? " is--active" : "";
    const bodyStyle = i === 0 ? ' style="display: block;"' : "";
    const head =
      `      <div class="e-faq__head">${q}` +
      '<span class="e-faq__icon icon-add"></span></div>';
    parts.push(
      `    <div class="e-faq__list${active}">`,
      head,
      `      <div class="e-faq__body"${bodyStyle}>`,
      `        <p>${a}</p>`,
      "      </div>",
      "    </div>",
    );
  });
  parts.push("  </div>", "</div>");
  return parts.join("\n");
}

function buildFaqJsonld(items: readonly QaPair[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
}

function buildDeftermJsonld(items: readonly QaPair[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    hasDefinedTerm: items.map(([name, desc]) => ({
      "@type": "DefinedTerm",
      name,
      description: desc,
    })),
  };
}

function checkNoRawHtml(markdownBody: string): void {
  if (RAW_HTML_RE.test(markdownBody)) {
    throw new Error("html sanitization failed: writer emitted disallowed raw tag");
  }
}

// Python str.splitlines(): split on \r\n, \r, or \n.
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function extractFaqItems(rest: string): QaPair[] {
  const items: QaPair[] = [];
  for (const m of rest.matchAll(FAQ_BLOCK_RE)) {
    items.push([(m[1] ?? "").trim(), (m[2] ?? "").trim()]);
  }
  return items;
}

interface DeftermExtraction {
  readonly body: string;
  readonly items: readonly QaPair[];
}

function extractDefterms(rest: string): DeftermExtraction {
  const items: QaPair[] = [];
  const seen = new Set<string>();
  const body = rest.replace(DEFTERM_BLOCK_RE, (whole, rawName: string, rawDesc: string) => {
    const name = rawName.trim();
    const desc = rawDesc.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      items.push([name, desc]);
    }
    // Block form (newline in the full match) → strip entirely; the term already
    // appears in the surrounding prose. Inline form → keep the bare term name.
    return whole.includes("\n") ? "" : name;
  });
  return { body, items };
}

/**
 * Pure markup → RenderOutput transform. Mirrors `render_html` in
 * content_tool/agents/render_html.py exactly so the WordPress-bound HTML and
 * out-of-band schema.org graph stay byte-compatible. No DB writes here.
 */
export function renderHtml(markupRaw: string): RenderOutput {
  const lines = splitLines(markupRaw);
  // H1 = first line starting with '# '.
  if (lines.length === 0 || !(lines[0] ?? "").startsWith("# ")) {
    throw new Error("first markdown line must be '# H1'");
  }
  const seoTitle = (lines[0] ?? "").slice(2).trim();

  let rest = lines.slice(1).join("\n");

  const metaMatch = META_RE.exec(rest);
  if (metaMatch === null) {
    throw new Error("missing %%meta desc=...%% line");
  }
  const metaDescription = (metaMatch[1] ?? "").trim();
  rest = rest.replace(META_RE, "").replace(/^\s+/, "");

  // Sanitization gate (before transforming anything writer-controlled).
  checkNoRawHtml(rest);

  // FAQ items, then strip the FAQ shortcodes and the "## 常見問題" heading.
  const faqItems = extractFaqItems(rest);
  rest = rest.replace(FAQ_BLOCK_RE, "");
  rest = rest.replace(FAQ_HEADING_RE, "");

  // Split off the "## 資訊來源" section so it can be re-ordered after the FAQ.
  let sourcesMd = "";
  const sourcesMatch = SOURCES_SPLIT_RE.exec(rest);
  if (sourcesMatch !== null) {
    sourcesMd = rest.slice(sourcesMatch.index).replace(/^\n+/, "");
    rest = rest.slice(0, sourcesMatch.index);
  }

  // DefinedTerm items (dedup by name, first wins) + strip the shortcodes.
  const { body: deftermStripped, items: deftermItems } = extractDefterms(rest);
  rest = deftermStripped;

  // Belt-and-braces: refuse to render if a half-formed defterm marker survived.
  const residue = DEFTERM_RESIDUE_RE.exec(rest);
  if (residue !== null) {
    const start = Math.max(0, residue.index - 20);
    const snippet = rest.slice(start, residue.index + residue[0].length + 20);
    throw new Error(
      `render: unhandled defterm marker survived stripping near: ${JSON.stringify(snippet)}`,
    );
  }

  // Markdown → HTML (FAQ + sources injected separately below).
  const md = newMarkdownIt();
  let bodyHtml = md.render(rest);

  // Replace shortcodes after MD rendering (they survive as raw text inside <p>).
  bodyHtml = bodyHtml.replace(ADV_RE, (_m, id: string) => `[adv_panel id="${id}"]`);
  bodyHtml = bodyHtml.replace(WIDGET_RE, (_m, id: string) => `[page_widget id="${id}"]`);

  const faqHtml = buildFaqHtml(faqItems);
  const faqJsonld = faqItems.length > 0 ? buildFaqJsonld(faqItems) : null;
  const deftermJsonld = deftermItems.length > 0 ? buildDeftermJsonld(deftermItems) : null;

  // Structured-data graph pieces, collected for OUT-OF-BAND delivery only.
  // No inline <script type="application/ld+json"> in the body.
  const schemaPieces: object[] = [faqJsonld, deftermJsonld].filter(
    (obj): obj is object => obj !== null,
  );
  const schemaJsonld = schemaPieces.length > 0 ? schemaPieces : null;

  let final = bodyHtml;
  if (faqHtml) {
    final += "\n<h2>常見問題</h2>\n" + faqHtml + "\n";
  }
  if (sourcesMd) {
    final += "\n" + md.render(sourcesMd);
  }

  // Excerpt: first <p>... text, ≤160 chars.
  const pMatch = FIRST_PARAGRAPH_RE.exec(bodyHtml);
  const excerptSuggestion = pMatch !== null ? (pMatch[1] ?? "").slice(0, EXCERPT_MAX_CHARS) : "";

  return {
    seoTitle,
    metaDescription,
    htmlBody: final,
    faqSchemaJsonld: faqJsonld,
    schemaJsonld,
    excerptSuggestion,
    slugSuggestion: "",
  };
}
