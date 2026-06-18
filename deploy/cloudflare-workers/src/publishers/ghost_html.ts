// Ghost (Pro) HTML-body adapter.
//
// Ghost stores Lexical, not HTML. On input (POST/PUT ?source=html) it runs an
// HTML→Lexical converter that flattens class-bearing <div> wrappers into bare
// <p> and drops every class. That destroys our FAQ accordion
// (`<div class="editor__item editor__faq">` … `e-faq__*`) — it would publish as
// plain paragraphs with no accordion structure, styling, or toggle behaviour.
//
// Fencing non-native markup in an explicit Ghost HTML card
// (`<!--kg-card-begin: html-->` … `<!--kg-card-end: html-->`) makes Ghost
// preserve it byte-for-byte. Verified live against healthycheckhk.ghost.io
// (Ghost v6.45): unwrapped → classes stripped; wrapped → all classes survive.
//
// Native tags (h2/h3/p/ul/ol/blockquote/a/strong/em) and <table>/<figure> are
// left untouched — Ghost converts or auto-cards them correctly on its own.

const KG_BEGIN = "<!--kg-card-begin: html-->";
const KG_END = "<!--kg-card-end: html-->";

// The FAQ accordion block our renderer emits (render.ts::buildFaqHtml): opens
// with the editor__faq wrapper and closes at a column-0 </div>. Inner closes are
// indented ("  </div>", "    </div>"), so a `\n</div>` (newline + unindented
// close) matches ONLY the outer wrapper. An optionally-present surrounding fence
// is consumed and re-emitted, so wrapping is idempotent.
const FAQ_BLOCK_RE =
  /(?:<!--kg-card-begin: html-->\s*)?<div class="editor__item editor__faq">[\s\S]*?\n<\/div>(?:\s*<!--kg-card-end: html-->)?/g;

/**
 * Wrap our non-native HTML blocks (currently the FAQ accordion) in Ghost HTML
 * cards so they survive Ghost's HTML→Lexical conversion verbatim. Idempotent:
 * an already-fenced block is normalised, not double-wrapped. Pure — no I/O.
 */
export function wrapNonNativeHtmlForGhost(html: string): string {
  return html.replace(FAQ_BLOCK_RE, (match) => {
    const inner = match
      .replace(new RegExp(`^${KG_BEGIN}\\s*`), "")
      .replace(new RegExp(`\\s*${KG_END}$`), "");
    return `${KG_BEGIN}\n${inner}\n${KG_END}`;
  });
}
