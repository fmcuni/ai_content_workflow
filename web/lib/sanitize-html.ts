import DOMPurify, { type Config } from "dompurify";

/**
 * XSS sanitizer for attacker-influenceable article HTML before it is diffed and
 * rendered via `dangerouslySetInnerHTML`.
 *
 * The diff inputs (committed baseline + working body) originate from WordPress
 * article HTML, arbitrary fetched-page HTML, and LLM output — all of which an
 * attacker can influence. The tracked-changes surface renders the diff in the
 * authenticated origin where the Supabase auth token is JS-readable, so an
 * unsanitized `<script>`/`onerror` payload is a session-theft vector.
 *
 * We sanitize the RAW inputs at the boundary (before tokenizing/diffing) so the
 * trusted `<ins>`/`<del>` markup the diff algorithm injects afterward is never
 * stripped.
 *
 * Runtime split (deliberate — keeps the web Worker bundle under the 3 MiB limit):
 *  - In the browser (and jsdom tests) we use the native DOMPurify, which parses
 *    via the real DOM and is robust against mXSS. This is the path that actually
 *    matters: the diff data is client-fetched (TanStack Query) and the dangerous
 *    `dangerouslySetInnerHTML` lives in a "use client" component, so injection
 *    only ever happens once a DOM is present.
 *  - In the Cloudflare Workers SSR runtime there is no DOM, so DOMPurify cannot
 *    run. We fall back to a conservative string strip that removes the high-risk
 *    vectors (`<script>`/`<style>`, `on*` handlers, `javascript:`/`vbscript:`
 *    URIs). `isomorphic-dompurify` would cover this server-side, but it pulls in
 *    jsdom (~20 MB) and blows the Worker size limit, so we avoid it.
 *
 * Legitimate markup must survive on both paths: the FAQ accordion widget
 * (`div.editor__faq` / `e-faq__list`), comment spans carrying `data-comment-id`,
 * and other `data-*` review anchors. DOMPurify keeps `class`/`data-*` by default
 * (`ALLOW_DATA_ATTR: true` pins it); the string fallback only removes the
 * dangerous constructs above and preserves all other markup verbatim.
 */
const SANITIZE_CONFIG: Config = {
  // <script>/<style> are dropped explicitly so a future allowlist edit can't
  // quietly re-admit them.
  FORBID_TAGS: ["script", "style"],
  // Keep data-* (data-comment-id, data-tc, FAQ anchors) — load-bearing for
  // comment spans and the tracked-changes engine.
  ALLOW_DATA_ATTR: true,
  // Force a plain string return so the value can flow into the diff/tokenizer
  // (never a TrustedHTML object).
  RETURN_TRUSTED_TYPE: false,
};

/**
 * Conservative DOM-free sanitizer for the SSR/Workers runtime. Removes only the
 * dangerous constructs and leaves every other byte of markup intact, so it never
 * corrupts article structure or the diff/FAQ/comment surfaces. Pure.
 */
function stripDangerousHtml(html: string): string {
  return (
    html
      // <script>/<style> blocks, including unclosed ones.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(script|style)\b[^>]*>/gi, "")
      // Inline event-handler attributes: on*="...", on*='...', on*=bare.
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
      .replace(/\son[a-z]+\s*=\s*[^\s">]+/gi, "")
      // Neutralize javascript:/vbscript: URIs in href/src.
      .replace(/\b(href|src)\s*=\s*"\s*(?:javascript|vbscript):[^"]*"/gi, '$1="#"')
      .replace(/\b(href|src)\s*=\s*'\s*(?:javascript|vbscript):[^']*'/gi, "$1='#'")
  );
}

/**
 * Return a sanitized copy of `html` with all script/style tags and event-handler
 * (`on*`) attributes removed, preserving the markup the diff/FAQ/comment surfaces
 * depend on. Pure: returns a new string, never mutates the input.
 */
export function sanitizeArticleHtml(html: string): string {
  const hasDom =
    typeof window !== "undefined" && typeof window.document !== "undefined";
  if (hasDom) {
    return DOMPurify.sanitize(html, SANITIZE_CONFIG) as string;
  }
  return stripDangerousHtml(html);
}
