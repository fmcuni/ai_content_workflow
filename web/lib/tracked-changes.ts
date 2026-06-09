import { diffArrays } from "diff";

/**
 * In-house tracked-changes engine for HUMAN edits (no paid Pro extension).
 *
 * A "committed" baseline and the live "working" body are diffed and each
 * insertion / deletion is a `Hunk` the reviewer can commit (accept into the
 * baseline) or dismiss (revert the working body).
 *
 * Both bodies are raw HTML. The naive approach — diffing the HTML as plain text
 * and wrapping each diff part in `<ins>`/`<del>` — corrupts markup: a word-level
 * boundary lands INSIDE a tag or attribute (e.g. `href="<del>old</del>…"`), or
 * splits a tag name, producing un-renderable, un-clickable garbage. So we diff an
 * HTML-AWARE TOKEN STREAM instead:
 *   - every tag (`<…>`) is one ATOMIC token — a diff part never starts or ends
 *     inside a tag, so `<ins>`/`<del>` can never be injected into markup;
 *   - text between tags is split into word / single-CJK-character tokens, so the
 *     diff granularity matches a human's mental "what changed" (CJK matters for
 *     the zh-* voices);
 *   - insignificant formatting whitespace between tags (indentation / newlines
 *     from server-rendered HTML, which TipTap strips on load) is dropped so it
 *     never surfaces as a phantom change once editing begins.
 *
 * All transforms are PURE and IMMUTABLE: they rebuild both strings by joining
 * whole diff parts, never splitting one — so the rejoined HTML stays valid.
 *
 * AI edits are out of scope — they advance the baseline directly and never
 * surface here as pending changes.
 */

/** A diff segment over the HTML token stream (mirrors jsdiff's ArrayChange). */
export interface DiffPart {
  /** The tokens of this segment, in order. */
  value: string[];
  /** Present in working only. */
  added?: boolean;
  /** Present in committed only. */
  removed?: boolean;
}

/**
 * Per-author attribution for a hunk (realtime collab only). Populated by the
 * separate, OPTIONAL blame step in `lib/run-editor/collab-blame.ts` — never by
 * `computeTrackedChanges`, which stays authorship-agnostic. `undefined` whenever
 * collab is off or the author can't be resolved, so the non-collab diff is
 * byte-identical.
 */
export interface HunkAuthor {
  /** Display name of the hunk's dominant author (inserter for `add`, deleter for `remove`). */
  name: string;
  /** That author's server-issued cursor colour (hex) or the neutral fallback. */
  color: string;
}

export interface Hunk {
  /** Index of this part within the diff `parts` array. */
  index: number;
  /** `add` = present in working only; `remove` = present in committed only. */
  type: "add" | "remove";
  /** The hunk's text (tokens joined) — used as a comment anchor. */
  value: string;
  /** Who wrote/removed this text — set only by the collab blame step (optional). */
  author?: HunkAuthor;
}

export interface TrackedChanges {
  parts: DiffPart[];
  hunks: Hunk[];
}

const TAG_RE = /^<[^>]*>$/;
/** A token that is a whole HTML tag (atomic — never wrapped or split). */
const isTag = (token: string): boolean => TAG_RE.test(token);
/** A token that is only whitespace. */
const isWhitespace = (token: string): boolean => /^\s+$/.test(token);

/**
 * A token that is an editor annotation-anchor tag: an opening comment/review
 * anchor span (`<span … data-comment-id|data-review-id …>`) or its `</span>`
 * close. These wrap a selection so the editor can attach a thread; they are NOT
 * article content. The baseline never carries them, so they only ever surface
 * as ADDED tokens in the diff. */
const ANCHOR_OPEN_RE = /^<span\b[^>]*\bdata-(?:comment|review)-id=/;
const isAnchorTag = (token: string): boolean =>
  ANCHOR_OPEN_RE.test(token) || token === "</span>";

/**
 * An ADDED diff part that carries no real content — only annotation-anchor tags
 * and whitespace. Adding a highlight injects exactly such a part, and it must
 * NOT count as a pending tracked change. A part that also contains inserted
 * TEXT (newly-written anchored text) is a real change and is excluded here. */
const isAnchorNoise = (p: DiffPart): boolean =>
  !!p.added &&
  p.value.some(isAnchorTag) &&
  p.value.every((t) => isAnchorTag(t) || isWhitespace(t));

/**
 * Split a text run into diff tokens: each CJK / Kana / Hangul codepoint is its
 * own token (character-level granularity for scriptio-continua languages), Latin
 * runs stay whole words, whitespace runs stay whole, and every other codepoint is
 * a single token. The `u` flag keeps astral codepoints (emoji) intact. The
 * concatenation of the tokens is exactly the input (lossless).
 */
const TEXT_TOKEN_RE =
  /[㐀-鿿豈-﫿぀-ヿ가-힯ｦ-ﾟ]|[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu;

function tokenizeText(text: string): string[] {
  return text.match(TEXT_TOKEN_RE) ?? [];
}

/**
 * Tokenize an HTML string into an atomic-tag / word / single-CJK-char stream.
 * `tokenizeHtml(s).join("")` reproduces `s` EXCEPT for insignificant formatting
 * whitespace between tags (a whitespace run containing a newline/tab, flanked by
 * tags), which is intentionally dropped so server-render indentation does not
 * read as a pending change against TipTap's normalized output. Significant inline
 * whitespace (a plain space between inline tags) is preserved.
 */
function tokenizeHtml(html: string): string[] {
  const segments = html.split(/(<[^>]*>)/);
  const tokens: string[] = [];
  segments.forEach((segment, i) => {
    if (!segment) return;
    if (isTag(segment)) {
      tokens.push(segment);
      return;
    }
    if (isWhitespace(segment) && /[\n\r\t]/.test(segment)) {
      const prevIsTag = i > 0 && isTag(segments[i - 1]!);
      const nextIsTag = i < segments.length - 1 && isTag(segments[i + 1]!);
      if (prevIsTag || nextIsTag) return; // drop insignificant formatting whitespace
    }
    tokens.push(...tokenizeText(segment));
  });
  return tokens;
}

/** Diff the committed baseline against the working body into indexed hunks.
 * Tags are atomic and whitespace-only tokens compare equal to each other so a
 * reflow (`\n` ⇄ spaces) is never a change. */
export function computeTrackedChanges(committed: string, working: string): TrackedChanges {
  const parts = diffArrays(tokenizeHtml(committed), tokenizeHtml(working), {
    comparator: (a, b) => a === b || (isWhitespace(a) && isWhitespace(b)),
  }) as DiffPart[];
  const hunks: Hunk[] = [];
  parts.forEach((p, index) => {
    // Annotation-anchor-only additions (highlighting text for AI edit / Review)
    // are not content changes — keep them in `parts` (so accept/reject and the
    // working body preserve the anchors) but never count them as a pending hunk.
    if (p.added && !isAnchorNoise(p)) {
      hunks.push({ index, type: "add", value: p.value.join("") });
    } else if (p.removed) {
      hunks.push({ index, type: "remove", value: p.value.join("") });
    }
  });
  return { parts, hunks };
}

const joinPart = (p: DiffPart): string => p.value.join("");

/** The committed side = unchanged + removed parts (what the baseline holds). */
function buildCommitted(parts: readonly DiffPart[]): string {
  return parts.map((p) => (p.added ? "" : joinPart(p))).join("");
}

/** The working side = unchanged + added parts (what the editor holds). */
function buildWorking(parts: readonly DiffPart[]): string {
  return parts.map((p) => (p.removed ? "" : joinPart(p))).join("");
}

export interface CommitResult {
  committed: string;
  working: string;
}

/**
 * A replacement (the reviewer changed a word) surfaces as an adjacent
 * remove→add pair. Resolving only one half would leave both the old and the new
 * text on that side (e.g. `redblue`), so accept/reject must move the WHOLE pair
 * together. Return the index of `index`'s adjacent opposite-type sibling, if any.
 */
function pairedIndex(parts: readonly DiffPart[], index: number): number | null {
  const p = parts[index];
  if (!p) return null;
  if (p.added) {
    if (parts[index - 1]?.removed) return index - 1;
    if (parts[index + 1]?.removed) return index + 1;
  } else if (p.removed) {
    if (parts[index + 1]?.added) return index + 1;
    if (parts[index - 1]?.added) return index - 1;
  }
  return null;
}

function targetSet(parts: readonly DiffPart[], index: number): Set<number> {
  const mate = pairedIndex(parts, index);
  return new Set(mate === null ? [index] : [index, mate]);
}

/**
 * Accept the hunk at `index` into the baseline (and its replacement mate, if
 * any). The working body is unchanged; the new baseline matches working at that
 * part (gains an insertion, drops a deletion), so a re-diff has one fewer hunk.
 */
export function commitHunk(parts: readonly DiffPart[], index: number): CommitResult {
  const targets = targetSet(parts, index);
  const committed = parts
    .map((p, i) => {
      if (targets.has(i)) return p.added ? joinPart(p) : ""; // accept: keep new, drop old
      return p.added ? "" : joinPart(p); // committed side for every other part
    })
    .join("");
  return { committed, working: buildWorking(parts) };
}

/**
 * Reject the hunk at `index` (and its replacement mate, if any). The baseline is
 * unchanged; the working body reverts to the baseline at that part (drops an
 * insertion, restores a deletion).
 */
export function dismissHunk(parts: readonly DiffPart[], index: number): CommitResult {
  const targets = targetSet(parts, index);
  const working = parts
    .map((p, i) => {
      if (targets.has(i)) return p.removed ? joinPart(p) : ""; // reject: restore old, drop new
      return p.removed ? "" : joinPart(p); // working side for every other part
    })
    .join("");
  return { committed: buildCommitted(parts), working };
}

const insOpen = (i: number): string =>
  `<ins data-tc="add" data-tc-i="${i}" tabindex="0" role="button" aria-haspopup="true" aria-label="Inserted text — activate to accept or reject">`;
const delOpen = (i: number): string =>
  `<del data-tc="del" data-tc-i="${i}" tabindex="0" role="button" aria-haspopup="true" aria-label="Deleted text — activate to accept or reject">`;

/**
 * Render the diff as inline tracked-changes markup for the visual editor. The
 * output is always the WORKING document's tag structure with text-level edits
 * highlighted: unchanged tokens pass through; inserted TEXT is wrapped in `<ins>`
 * and deleted TEXT in `<del>`; inserted TAGS are emitted bare (they belong to the
 * working structure) and deleted TAGS are dropped (the working structure has no
 * place for them). Because a tag is never wrapped and a wrapper never lands
 * inside a tag, the markup stays valid for any edit — including attribute, link,
 * heading-level, and review-anchor changes that the old plain-text diff corrupted.
 *
 * Consecutive text tokens within one part share a single wrapper (so CJK text is
 * not one `<ins>` per character). Each wrapper carries:
 *   - `data-tc` — `add` | `del` (drives styling)
 *   - `data-tc-i` — its index into `parts`, so a click resolves back to
 *     `commitHunk(parts, i)` / `dismissHunk(parts, i)`
 *   - `tabindex` / `role` / `aria-*` — keyboard-focusable, screen-reader labelled.
 * PURE: no DOM, no mutation — just string assembly from the diff parts.
 */
export function buildInlineDiffHtml(parts: readonly DiffPart[]): string {
  let out = "";
  parts.forEach((p, i) => {
    if (!p.added && !p.removed) {
      out += joinPart(p);
      return;
    }
    const open = p.added ? insOpen(i) : delOpen(i);
    const close = p.added ? "</ins>" : "</del>";
    let buffer = "";
    const flush = (): void => {
      if (buffer) {
        out += open + buffer + close;
        buffer = "";
      }
    };
    for (const token of p.value) {
      if (isTag(token)) {
        flush();
        if (p.added) out += token; // added tag belongs to the working structure
        // a removed tag is dropped — the working structure has no place for it
      } else {
        buffer += token;
      }
    }
    flush();
  });
  return out;
}

/** Accept every pending change — the baseline becomes the working body. */
export function commitAll(parts: readonly DiffPart[]): CommitResult {
  const working = buildWorking(parts);
  return { committed: working, working };
}

/** Reject every pending change — the working body reverts to the baseline. */
export function dismissAll(parts: readonly DiffPart[]): CommitResult {
  const committed = buildCommitted(parts);
  return { committed, working: committed };
}
