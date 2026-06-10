import { describe, expect, it } from "vitest";

import {
  canonicalFaqItemHtml,
  isFaqItemAtom,
  matchDivClose,
  parseFaqItemHtml,
  pushFaqRegionTokens,
  refineFaqItemEdits,
} from "@/lib/faq-diff";
import type { DiffPart } from "@/lib/tracked-changes";

/** Build the served FAQ widget markup (positional chrome on the first item),
 *  matching the production renderer / TipTap getHTML output. */
function faqHtml(items: ReadonlyArray<{ q: string; a: string }>): string {
  const lists = items
    .map((it, i) => {
      const active = i === 0 ? " is--active" : "";
      const style = i === 0 ? ' style="display: block;"' : "";
      return (
        `<div class="e-faq__list${active}">` +
        `<div class="e-faq__head">${it.q}<span class="e-faq__icon icon-add"></span></div>` +
        `<div class="e-faq__body"${style}><p>${it.a}</p></div>` +
        `</div>`
      );
    })
    .join("");
  return `<div class="editor__item editor__faq"><div class="e-faq__wrap">${lists}</div></div>`;
}

describe("canonicalFaqItemHtml / parseFaqItemHtml", () => {
  it("round-trips a Q/A pair and strips positional chrome", () => {
    const html = canonicalFaqItemHtml("What is X?", "X is a thing.");
    expect(html).not.toContain("is--active");
    expect(html).not.toContain("display: block");
    expect(parseFaqItemHtml(html)).toEqual({ q: "What is X?", a: "X is a thing." });
  });

  it("parses a served (chrome-carrying) first item the same as a plain one", () => {
    const served =
      '<div class="e-faq__list is--active"><div class="e-faq__head">Q?<span class="e-faq__icon icon-add"></span></div>' +
      '<div class="e-faq__body" style="display: block;"><p>A.</p></div></div>';
    expect(parseFaqItemHtml(served)).toEqual({ q: "Q?", a: "A." });
  });
});

describe("isFaqItemAtom", () => {
  it("accepts a canonical item atom and rejects tags / prose / served chrome", () => {
    expect(isFaqItemAtom(canonicalFaqItemHtml("q", "a"))).toBe(true);
    expect(isFaqItemAtom("<p>hello</p>")).toBe(false);
    expect(isFaqItemAtom('<div class="e-faq__wrap">')).toBe(false);
    // served first item carries is--active → not the canonical prefix
    expect(isFaqItemAtom('<div class="e-faq__list is--active"><div class="e-faq__head">q</div></div>')).toBe(
      false,
    );
  });
});

describe("matchDivClose", () => {
  it("finds the matching close of a nested div by depth", () => {
    const html = "before<div><div></div><div></div></div>after";
    const open = html.indexOf("<div>");
    const end = matchDivClose(html, open);
    expect(html.slice(open, end)).toBe("<div><div></div><div></div></div>");
  });

  it("returns html.length when unbalanced (defensive)", () => {
    const html = "<div><div></div>";
    expect(matchDivClose(html, 0)).toBe(html.length);
  });
});

describe("pushFaqRegionTokens", () => {
  it("emits wrapper tags + one chrome-free atom per item", () => {
    const region = faqHtml([
      { q: "Q1?", a: "A1." },
      { q: "Q2?", a: "A2." },
    ]);
    const out: string[] = [];
    pushFaqRegionTokens(region, out);
    expect(out[0]).toBe('<div class="editor__item editor__faq">');
    expect(out[1]).toBe('<div class="e-faq__wrap">');
    expect(out[2]).toBe(canonicalFaqItemHtml("Q1?", "A1."));
    expect(out[3]).toBe(canonicalFaqItemHtml("Q2?", "A2."));
    expect(out.slice(4)).toEqual(["</div>", "</div>"]);
  });
});

describe("refineFaqItemEdits", () => {
  const subDiff = (c: string, w: string): DiffPart[] => {
    if (c === w) return [{ value: [c] }];
    return [
      { value: [], removed: true },
      { value: [c], removed: true },
      { value: [w], added: true },
    ];
  };

  it("expands an adjacent removed/added atom pair (an edit) via subDiff", () => {
    const before = canonicalFaqItemHtml("Same question?", "Old answer.");
    const after = canonicalFaqItemHtml("Same question?", "New answer.");
    const parts: DiffPart[] = [
      { value: [before], removed: true },
      { value: [after], added: true },
    ];
    const refined = refineFaqItemEdits(parts, subDiff);
    // subDiff was invoked (so it's an inline edit, not whole-item replace)
    expect(refined.some((p) => p.added && p.value[0] === after)).toBe(true);
    expect(refined.some((p) => p.removed && p.value[0] === before)).toBe(true);
  });

  it("keeps dissimilar removed/added atoms as whole-item remove + insert", () => {
    const removed = canonicalFaqItemHtml("About cats?", "Cats meow.");
    const added = canonicalFaqItemHtml("Tax filing deadline?", "April 2026.");
    const parts: DiffPart[] = [
      { value: [removed], removed: true },
      { value: [added], added: true },
    ];
    const refined = refineFaqItemEdits(parts, subDiff);
    expect(refined).toEqual([
      { value: [removed], removed: true },
      { value: [added], added: true },
    ]);
  });

  it("leaves non-FAQ parts untouched", () => {
    const parts: DiffPart[] = [
      { value: ["<p>", "hello", "</p>"] },
      { value: ["world"], added: true },
    ];
    expect(refineFaqItemEdits(parts, subDiff)).toEqual(parts);
  });
});
