import DOMPurify, { type Config } from "isomorphic-dompurify";

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
 * stripped. DOMPurify removes `<script>` and every `on*` event-handler attribute
 * by default; we additionally force `FORBID_TAGS: ['script']` to be explicit.
 *
 * The diff relies on legitimate markup surviving: the FAQ accordion widget
 * (`div.editor__faq` / `e-faq__list` etc.), comment spans carrying
 * `data-comment-id`, and other `data-*` review-anchor attributes. DOMPurify keeps
 * `class` and `data-*` attributes by default, but we pin `ALLOW_DATA_ATTR: true`
 * so a future config change can't silently strip the review/FAQ anchors.
 */
const SANITIZE_CONFIG: Config = {
  // <script> is dropped by default; declare it so the intent is explicit and
  // a future allowlist edit can't quietly re-admit it.
  FORBID_TAGS: ["script"],
  // Keep data-* (data-comment-id, data-tc, FAQ anchors) — these are load-bearing
  // for comment spans and the tracked-changes engine.
  ALLOW_DATA_ATTR: true,
  // Force a plain string return so the value can flow into the diff/tokenizer
  // (never a TrustedHTML object).
  RETURN_TRUSTED_TYPE: false,
};

/**
 * Return a sanitized copy of `html` with all script tags and event-handler
 * (`on*`) attributes removed, preserving the markup the diff/FAQ/comment surfaces
 * depend on. Pure: returns a new string, never mutates the input.
 */
export function sanitizeArticleHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}
