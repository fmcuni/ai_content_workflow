import type { DiffPart } from "@/lib/tracked-changes";

/**
 * FAQ-widget-aware diffing primitives for the tracked-changes engine.
 *
 * The Bowtie FAQ accordion (`div.editor__faq`, the `FaqAccordion` TipTap atom)
 * serializes to nested `e-faq__list` / `e-faq__head` / `e-faq__body` divs. A
 * flat HTML-token diff aligns the SHARED structural tags across different items,
 * so removing an item dumps its deleted Q/A text into a surviving item's head —
 * garbled, un-reviewable output. And the positional chrome (`is--active` +
 * the first item's `display: block;`) shifts when item 1 is removed, surfacing
 * as spurious changes.
 *
 * Fix: tokenize each FAQ item as ONE chrome-free atom token (identity = `(q, a)`
 * only). A whole item add/remove is then a single clean diff part — no
 * cross-item text floating, no chrome noise. Editing a Q/A surfaces as a
 * removed-atom run beside an added-atom run, which {@link refineFaqItemEdits}
 * re-expands into inline word/CJK-level changes.
 *
 * A chrome-free item body round-trips to the canonical widget markup because the
 * `FaqAccordion` node re-derives `is--active`/`display: block;` on load, so the
 * stored committed/working bodies stay correct after accept/reject.
 *
 * PURE / no DOM — mirrors `tracked-changes.ts` so it runs in the same headless
 * round-trip tests.
 */

/**
 * Canonical, chrome-FREE serialization of one FAQ Q/A item, byte-stable so two
 * items with the same `(q, a)` compare equal regardless of position. Mirrors
 * the structure built by `faqItemsToDomSpec` (web/components/tiptap/faq-markup.ts)
 * minus the positional `is--active` class and `display: block;` body style.
 */
export function canonicalFaqItemHtml(q: string, a: string): string {
  return (
    '<div class="e-faq__list">' +
    '<div class="e-faq__head">' +
    q +
    '<span class="e-faq__icon icon-add"></span></div>' +
    '<div class="e-faq__body"><p>' +
    a +
    "</p></div>" +
    "</div>"
  );
}

const FAQ_ITEM_PREFIX = '<div class="e-faq__list">';

/** Whether a single token is a whole chrome-free FAQ item atom (one produced by
 *  {@link canonicalFaqItemHtml}). */
export function isFaqItemAtom(token: string): boolean {
  return (
    token.startsWith(FAQ_ITEM_PREFIX) &&
    token.includes('class="e-faq__head"') &&
    token.endsWith("</div>")
  );
}

const HEAD_RE = /class="e-faq__head">([\s\S]*?)<span/;
const BODY_P_RE = /<p>([\s\S]*?)<\/p>/;

/** Read the `(q, a)` out of one `e-faq__list` element's HTML. The question is
 *  the head text before the icon span; the answer is the body paragraph text.
 *  Both are plain text in the FAQ widget, so a regex read is sufficient. */
export function parseFaqItemHtml(itemHtml: string): { q: string; a: string } {
  const q = (HEAD_RE.exec(itemHtml) ?? [])[1] ?? "";
  const a = (BODY_P_RE.exec(itemHtml) ?? [])[1] ?? "";
  return { q, a };
}

const DIV_TAG_RE = /<\/?div\b[^>]*>/gi;

/**
 * Index of the character just AFTER the `</div>` that closes the `<div …>`
 * opening at `openIdx`, by div-depth counting. Robust to attribute order and
 * whitespace (unlike a regex on the whole string), and the FAQ widget nests only
 * divs, so counting divs alone finds every boundary. Returns `html.length` if
 * unbalanced (defensive — never throws).
 */
export function matchDivClose(html: string, openIdx: number): number {
  DIV_TAG_RE.lastIndex = openIdx;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = DIV_TAG_RE.exec(html)) !== null) {
    if (m[0][1] === "/") {
      depth -= 1;
      if (depth === 0) return DIV_TAG_RE.lastIndex;
    } else {
      depth += 1;
    }
  }
  return html.length;
}

const DIV_OPEN_RE = /^<div\b[^>]*>/;

/**
 * Push the tokens for ONE FAQ region (the substring spanning a whole
 * `editor__faq` wrapper) onto `out`:
 *   - the `editor__faq` open tag and the `e-faq__wrap` open tag as tag tokens,
 *   - each `e-faq__list` item as one chrome-free atom token,
 *   - the two wrapper close tags.
 *
 * Keeping the wrapper tags as tags preserves the collab-blame atom-depth walk
 * (`isFaqOpen` + balanced div open/close). Falls back to emitting the region
 * verbatim as a single token if the markup is unexpectedly malformed.
 */
export function pushFaqRegionTokens(region: string, out: string[]): void {
  const faqOpen = DIV_OPEN_RE.exec(region);
  if (!faqOpen) {
    out.push(region);
    return;
  }
  const wrapIdx = region.indexOf("<div", faqOpen[0].length);
  const wrapOpen = wrapIdx >= 0 ? DIV_OPEN_RE.exec(region.slice(wrapIdx)) : null;
  if (!wrapOpen) {
    out.push(region);
    return;
  }
  out.push(faqOpen[0]);
  out.push(wrapOpen[0]);
  let cursor = wrapIdx + wrapOpen[0].length;
  for (;;) {
    const start = region.indexOf('<div class="e-faq__list', cursor);
    if (start < 0) break;
    const end = matchDivClose(region, start);
    const { q, a } = parseFaqItemHtml(region.slice(start, end));
    out.push(canonicalFaqItemHtml(q, a));
    cursor = end;
  }
  out.push("</div>"); // e-faq__wrap close
  out.push("</div>"); // editor__faq close
}

/** Jaccard similarity over the Q+A word sets of two FAQ item atoms — used to
 *  pair an edited item's removed atom with its added counterpart. */
function faqItemSimilarity(committedAtom: string, workingAtom: string): number {
  const c = parseFaqItemHtml(committedAtom);
  const w = parseFaqItemHtml(workingAtom);
  const cTokens = new Set(`${c.q} ${c.a}`.split(/\s+/).filter(Boolean));
  const wTokens = new Set(`${w.q} ${w.a}`.split(/\s+/).filter(Boolean));
  let intersection = 0;
  cTokens.forEach((t) => {
    if (wTokens.has(t)) intersection += 1;
  });
  const union = new Set([...cTokens, ...wTokens]).size || 1;
  return intersection / union;
}

/** Minimum similarity to treat a removed/added atom pair as an EDIT (inline
 *  diff) rather than a genuine remove + insert (two whole-item hunks). */
const FAQ_EDIT_SIMILARITY_THRESHOLD = 0.4;

/**
 * Refine a diff so an EDITED FAQ item shows INLINE word-level changes instead of
 * a whole-item replace.
 *
 * An edit surfaces as a removed-atom run (`removed` part whose tokens are all FAQ
 * item atoms) immediately followed by an added-atom run. For each removed atom,
 * in committed order, the most-similar unused added atom above the threshold is
 * paired and replaced with a fine sub-diff (via the injected `subDiff`, which
 * reuses the engine's own plain tokenizer so granularity matches prose).
 * Unmatched removed atoms stay as whole-item removals; unmatched added atoms
 * become whole-item insertions.
 *
 * Pure: returns a new parts array, never mutating the input.
 */
export function refineFaqItemEdits(
  parts: readonly DiffPart[],
  subDiff: (committedItem: string, workingItem: string) => DiffPart[],
): DiffPart[] {
  const out: DiffPart[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const current = parts[i]!;
    const next = parts[i + 1];
    const isRemovedAtomRun =
      !!current.removed && current.value.length > 0 && current.value.every(isFaqItemAtom);
    const isAddedAtomRun =
      !!next && !!next.added && next.value.length > 0 && next.value.every(isFaqItemAtom);

    if (isRemovedAtomRun && isAddedAtomRun) {
      const removed = current.value;
      const added = next.value;
      const usedAdded = new Set<number>();
      for (const removedAtom of removed) {
        let bestIndex = -1;
        let bestScore = FAQ_EDIT_SIMILARITY_THRESHOLD;
        added.forEach((addedAtom, j) => {
          if (usedAdded.has(j)) return;
          const score = faqItemSimilarity(removedAtom, addedAtom);
          if (score >= bestScore) {
            bestScore = score;
            bestIndex = j;
          }
        });
        if (bestIndex >= 0) {
          usedAdded.add(bestIndex);
          for (const part of subDiff(removedAtom, added[bestIndex]!)) out.push(part);
        } else {
          out.push({ removed: true, value: [removedAtom] });
        }
      }
      added.forEach((addedAtom, j) => {
        if (!usedAdded.has(j)) out.push({ added: true, value: [addedAtom] });
      });
      i += 1; // consumed `next`
      continue;
    }
    out.push(current);
  }
  return out;
}
