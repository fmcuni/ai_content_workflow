import { describe, expect, it } from "vitest";

import {
  buildInlineDiffHtml,
  commitAll,
  commitHunk,
  computeTrackedChanges,
  dismissAll,
} from "@/lib/tracked-changes";

/** Served FAQ widget markup — positional chrome (`is--active` + `display: block;`)
 *  on the first item only, matching the production renderer / TipTap getHTML. */
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

const HEADING = "<h2>常見問題</h2>";
const TWO = [
  { q: "What is VHIS?", a: "It is a scheme." },
  { q: "Who qualifies?", a: "Residents qualify." },
];

/** A change is fully resolved iff re-diffing the result yields no pending hunks. */
function resolvesClean(committed: string, working: string): boolean {
  return computeTrackedChanges(committed, working).hunks.length === 0;
}

describe("FAQ widget tracked changes", () => {
  it("reports no hunks when the FAQ is unchanged", () => {
    const body = HEADING + faqHtml(TWO);
    expect(computeTrackedChanges(body, body).hunks).toHaveLength(0);
  });

  it("shows an answer edit as a single inline insertion in the right body", () => {
    const before = HEADING + faqHtml(TWO);
    const after =
      HEADING + faqHtml([{ q: "What is VHIS?", a: "It is a tax scheme." }, TWO[1]!]);
    const { parts, hunks } = computeTrackedChanges(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.type).toBe("add");
    const html = buildInlineDiffHtml(parts);
    expect(html).toContain("It is a <ins");
    expect(html).toContain("tax ");
    // the second (untouched) item is not disturbed
    expect(html).toContain('<div class="e-faq__head">Who qualifies?<span');
  });

  it("shows a question edit inline (del + ins) without touching the answer", () => {
    const before = HEADING + faqHtml(TWO);
    const after = HEADING + faqHtml([TWO[0]!, { q: "Who is eligible?", a: "Residents qualify." }]);
    const { parts, hunks } = computeTrackedChanges(before, after);
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    const html = buildInlineDiffHtml(parts);
    expect(html).toContain("<del");
    expect(html).toContain("<ins");
    expect(html).toContain("eligible");
  });

  it("removing the FIRST item is one clean hunk — no text leaks into the survivor", () => {
    const before = HEADING + faqHtml(TWO); // chrome on item 1
    const after = HEADING + faqHtml([TWO[1]!]); // chrome shifts to item 2
    const { parts, hunks } = computeTrackedChanges(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.type).toBe("remove");
    const html = buildInlineDiffHtml(parts);
    // The surviving item's head must be exactly its own question — the removed
    // item's Q/A must NOT have floated into it (the original corruption).
    expect(html).toContain('<div class="e-faq__head">Who qualifies?<span');
    expect(html).not.toContain("Who qualifies?</del>");
    // No spurious chrome diff (is--active / display: block were stripped).
    expect(html).not.toContain("is--active");
    expect(html).not.toContain("display: block");
  });

  it("removing the SECOND item is one clean remove hunk", () => {
    const before = HEADING + faqHtml(TWO);
    const after = HEADING + faqHtml([TWO[0]!]);
    const { hunks } = computeTrackedChanges(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.type).toBe("remove");
  });

  it("adding an item is one clean insert hunk", () => {
    const before = HEADING + faqHtml(TWO);
    const after = HEADING + faqHtml([...TWO, { q: "When?", a: "April 2026." }]);
    const { parts, hunks } = computeTrackedChanges(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.type).toBe("add");
    expect(buildInlineDiffHtml(parts)).toContain("When?");
  });

  it("a prose edit beside an untouched FAQ surfaces only the prose change", () => {
    const before = HEADING + "<p>Intro.</p>" + faqHtml(TWO);
    const after = HEADING + "<p>Intro changed.</p>" + faqHtml(TWO);
    const { hunks } = computeTrackedChanges(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.value).toContain("changed");
  });

  describe("accept / reject round-trips resolve cleanly", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["answer edit", faqHtml(TWO), faqHtml([{ q: "What is VHIS?", a: "A tax scheme." }, TWO[1]!])],
      ["remove first", faqHtml(TWO), faqHtml([TWO[1]!])],
      ["remove second", faqHtml(TWO), faqHtml([TWO[0]!])],
      ["add item", faqHtml(TWO), faqHtml([...TWO, { q: "When?", a: "Soon." }])],
    ];

    for (const [name, before, after] of cases) {
      it(`${name}: accept-all applies the working body`, () => {
        const { parts } = computeTrackedChanges(before, after);
        const accepted = commitAll(parts);
        expect(accepted.committed).toBe(accepted.working);
        expect(resolvesClean(accepted.committed, accepted.working)).toBe(true);
        // accepted body holds the post-edit content
        expect(resolvesClean(accepted.committed, after)).toBe(true);
      });

      it(`${name}: reject-all reverts to the baseline`, () => {
        const { parts } = computeTrackedChanges(before, after);
        const rejected = dismissAll(parts);
        expect(rejected.committed).toBe(rejected.working);
        expect(resolvesClean(rejected.committed, before)).toBe(true);
      });

      it(`${name}: accepting hunks one at a time converges to the working body`, () => {
        // Mimic a reviewer clicking Accept on each pending change in turn.
        let committed = before;
        const working = after;
        for (let guard = 0; guard < 20; guard += 1) {
          const { parts, hunks } = computeTrackedChanges(committed, working);
          if (hunks.length === 0) break;
          committed = commitHunk(parts, hunks[0]!.index).committed;
        }
        expect(resolvesClean(committed, working)).toBe(true);
      });
    }
  });
});
