import { describe, expect, it } from "vitest";

import {
  buildInlineDiffHtml,
  commitAll,
  commitHunk,
  computeTrackedChanges,
  dismissAll,
  dismissHunk,
} from "@/lib/tracked-changes";

describe("computeTrackedChanges", () => {
  it("reports no hunks when committed === working", () => {
    const { hunks } = computeTrackedChanges("<p>same</p>", "<p>same</p>");
    expect(hunks).toEqual([]);
  });

  it("detects an insertion", () => {
    const { hunks } = computeTrackedChanges("<p>hello</p>", "<p>hello world</p>");
    expect(hunks.some((h) => h.type === "add" && h.value.includes("world"))).toBe(true);
  });

  it("detects a deletion", () => {
    const { hunks } = computeTrackedChanges("<p>hello world</p>", "<p>hello</p>");
    expect(hunks.some((h) => h.type === "remove" && h.value.includes("world"))).toBe(true);
  });

  it("detects a replacement as a remove + add pair", () => {
    const { hunks } = computeTrackedChanges("<p>red car</p>", "<p>blue car</p>");
    expect(hunks.some((h) => h.type === "remove")).toBe(true);
    expect(hunks.some((h) => h.type === "add")).toBe(true);
  });
});

describe("commitHunk / dismissHunk", () => {
  it("committing an insertion keeps it and clears that hunk", () => {
    const committed = "<p>hello</p>";
    const working = "<p>hello world</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const addHunk = hunks.find((h) => h.type === "add")!;
    const result = commitHunk(parts, addHunk.index);
    expect(result.working).toBe(working);
    // Baseline now equals working → re-diff is empty.
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("dismissing an insertion reverts the working body", () => {
    const committed = "<p>hello</p>";
    const working = "<p>hello world</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const addHunk = hunks.find((h) => h.type === "add")!;
    const result = dismissHunk(parts, addHunk.index);
    expect(result.committed).toBe(committed);
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
    // Working reverted to baseline (no "world").
    expect(result.working.includes("world")).toBe(false);
  });

  it("committing a deletion drops the text from the baseline", () => {
    const committed = "<p>hello world</p>";
    const working = "<p>hello</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const removeHunk = hunks.find((h) => h.type === "remove")!;
    const result = commitHunk(parts, removeHunk.index);
    expect(result.committed.includes("world")).toBe(false);
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("dismissing a deletion restores the text in the working body", () => {
    const committed = "<p>hello world</p>";
    const working = "<p>hello</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const removeHunk = hunks.find((h) => h.type === "remove")!;
    const result = dismissHunk(parts, removeHunk.index);
    expect(result.working.includes("world")).toBe(true);
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("resolving one hunk of several leaves the others pending", () => {
    const committed = "<p>alpha beta gamma</p>";
    const working = "<p>ALPHA beta GAMMA</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    expect(hunks.length).toBeGreaterThan(1);
    const result = commitHunk(parts, hunks[0]!.index);
    const after = computeTrackedChanges(result.committed, result.working);
    expect(after.hunks.length).toBeLessThan(hunks.length);
  });
});

describe("commitAll / dismissAll", () => {
  it("commitAll makes the baseline equal the working body", () => {
    const { parts } = computeTrackedChanges("<p>old text</p>", "<p>new text here</p>");
    const result = commitAll(parts);
    expect(result.committed).toBe(result.working);
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("dismissAll reverts the working body to the baseline", () => {
    const committed = "<p>old text</p>";
    const { parts } = computeTrackedChanges(committed, "<p>new text here</p>");
    const result = dismissAll(parts);
    expect(result.committed).toBe(committed);
    expect(result.working).toBe(committed);
  });

  it("does not split HTML tags — rejoined output stays well-formed", () => {
    const committed = `<p>a</p><p>b</p>`;
    const working = `<p>a</p><p>b</p><p>c</p>`;
    const { parts } = computeTrackedChanges(committed, working);
    const result = commitAll(parts);
    expect(result.committed).toBe(working);
    // Every <p> still has a matching </p>.
    expect((result.committed.match(/<p>/g) ?? []).length).toBe(
      (result.committed.match(/<\/p>/g) ?? []).length,
    );
  });
});

describe("buildInlineDiffHtml", () => {
  it("wraps insertions in <ins> and deletions in <del> with addressable indices", () => {
    const { parts } = computeTrackedChanges("<p>hello world</p>", "<p>hello there</p>");
    const html = buildInlineDiffHtml(parts);
    expect(html).toContain('<del data-tc="del"');
    expect(html).toContain('<ins data-tc="add"');
    // Each wrapper carries its parts-array index back to the diff.
    expect(html).toMatch(/data-tc-i="\d+"/);
    // The unchanged prefix survives verbatim.
    expect(html).toContain("hello");
  });

  it("emits no <ins>/<del> when there are no changes", () => {
    const { parts } = computeTrackedChanges("<p>same</p>", "<p>same</p>");
    const html = buildInlineDiffHtml(parts);
    expect(html).toBe("<p>same</p>");
    expect(html).not.toContain("data-tc");
  });

  it("the data-tc-i index resolves back to the correct commit/dismiss hunk", () => {
    const committed = "<p>hello</p>";
    const working = "<p>hello world</p>";
    const { parts } = computeTrackedChanges(committed, working);
    const html = buildInlineDiffHtml(parts);
    const i = Number(/data-tc-i="(\d+)"/.exec(html)![1]);
    // Accepting that exact index clears the only pending change.
    const result = commitHunk(parts, i);
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });
});

// Helper: assert no <ins>/<del> wrapper ever lands inside a tag (attribute soup).
// A correct render keeps every tag atomic, so the only "<" that immediately
// precedes "ins"/"del"/"/ins"/"/del" are the wrapper tags themselves — never the
// interior of another tag.
function tagsAreIntact(html: string): boolean {
  // No wrapper opens/closes inside an attribute value (between a quote pair).
  return !/="[^"]*<(?:ins|del|\/ins|\/del)/.test(html) && !/<[a-z][^>]*<(?:ins|del)\b/i.test(html);
}

describe("buildInlineDiffHtml — HTML structure integrity (the format-corruption fixes)", () => {
  it("an attribute-value edit never injects <ins>/<del> inside the tag", () => {
    const { parts } = computeTrackedChanges(
      '<p><a href="/old-url">link</a></p>',
      '<p><a href="/new-url">link</a></p>',
    );
    const html = buildInlineDiffHtml(parts);
    expect(tagsAreIntact(html)).toBe(true);
    // The working-side link is rendered intact with its new href.
    expect(html).toContain('<a href="/new-url">link</a>');
    expect(html).not.toContain('href="/old-url"');
    expect(html).not.toContain('href="/<');
  });

  it("a heading-level (tag-name) change renders a valid heading, not a split tag", () => {
    const { parts } = computeTrackedChanges("<h2>Title</h2>", "<h3>Title</h3>");
    const html = buildInlineDiffHtml(parts);
    expect(html).toBe("<h3>Title</h3>");
  });

  it("wrapping a word in a review-anchor span keeps the span well-formed", () => {
    const { parts } = computeTrackedChanges(
      "<p>hello world here</p>",
      '<p>hello <span data-review-id="r-1">world</span> here</p>',
    );
    const html = buildInlineDiffHtml(parts);
    expect(tagsAreIntact(html)).toBe(true);
    // The span open/close are never split across separate <ins> wrappers.
    expect(html).toContain('<span data-review-id="r-1">');
    expect(html).toContain("</span>");
    expect(html).not.toMatch(/<ins[^>]*><span/);
  });

  it("keeps CJK edits at character granularity", () => {
    const { parts } = computeTrackedChanges("<p>颜色是红色的</p>", "<p>颜色是蓝色的</p>");
    const html = buildInlineDiffHtml(parts);
    expect(html).toContain("<del");
    expect(html).toContain("红</del>");
    expect(html).toContain("蓝</ins>");
    expect(html).toContain("颜色是");
  });

  it("emits an inserted block's tags bare and only wraps its text", () => {
    const { parts } = computeTrackedChanges("<p>a</p><p>b</p>", "<p>a</p><p>b</p><p>c</p>");
    const html = buildInlineDiffHtml(parts);
    expect(html).toContain("<p><ins");
    expect(html).toContain("c</ins></p>");
    expect(tagsAreIntact(html)).toBe(true);
  });
});

describe("replacement hunks resolve as a pair (no old+new concatenation)", () => {
  it("accepting the inserted side of a word replacement drops the old word", () => {
    const committed = "<p>red car</p>";
    const working = "<p>blue car</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const addHunk = hunks.find((h) => h.type === "add")!;
    const result = commitHunk(parts, addHunk.index);
    expect(result.committed).toBe("<p>blue car</p>");
    expect(result.committed).not.toContain("redblue");
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });

  it("rejecting the deleted side of a word replacement restores the old word", () => {
    const committed = "<p>red car</p>";
    const working = "<p>blue car</p>";
    const { parts, hunks } = computeTrackedChanges(committed, working);
    const removeHunk = hunks.find((h) => h.type === "remove")!;
    const result = dismissHunk(parts, removeHunk.index);
    expect(result.working).toBe("<p>red car</p>");
    expect(result.working).not.toContain("redblue");
    expect(computeTrackedChanges(result.committed, result.working).hunks).toEqual([]);
  });
});

describe("insignificant formatting whitespace is not a phantom change", () => {
  it("inter-block newlines/indentation present in only one body produce no hunks", () => {
    const rendered = "<p>a</p>\n  <p>b</p>\n  <p>c</p>";
    const normalized = "<p>a</p><p>b</p><p>c</p>";
    expect(computeTrackedChanges(rendered, normalized).hunks).toEqual([]);
    expect(computeTrackedChanges(normalized, rendered).hunks).toEqual([]);
  });

  it("a whitespace reflow within text (collapsing double spaces) is not a change", () => {
    expect(computeTrackedChanges("<p>hello  world</p>", "<p>hello world</p>").hunks).toEqual([]);
  });

  it("differing indentation depths (both newline-led) produce no hunks", () => {
    expect(computeTrackedChanges("<p>a</p>\n<p>b</p>", "<p>a</p>\n\n    <p>b</p>").hunks).toEqual(
      [],
    );
  });

  it("a real text edit still surfaces even amid whitespace differences", () => {
    const { hunks } = computeTrackedChanges("<p>a</p>\n<p>old</p>", "<p>a</p><p>new</p>");
    expect(hunks.some((h) => h.type === "add" && h.value.includes("new"))).toBe(true);
    expect(hunks.some((h) => h.type === "remove" && h.value.includes("old"))).toBe(true);
  });
});

describe("computeTrackedChanges — annotation anchors are not changes", () => {
  const COMMENT = '<p>hello <span class="comment-anchor" data-comment-id="c1">world</span></p>';
  const REVIEW = '<p>hello <span class="review-anchor" data-review-id="r1">world</span></p>';
  const PLAIN = "<p>hello world</p>";

  it("highlighting text for AI edit adds no pending hunk", () => {
    expect(computeTrackedChanges(PLAIN, COMMENT).hunks).toEqual([]);
  });

  it("highlighting text for a review note adds no pending hunk", () => {
    expect(computeTrackedChanges(PLAIN, REVIEW).hunks).toEqual([]);
  });

  it("a real edit still counts when an anchor is also present", () => {
    const working =
      '<p>hello <span class="comment-anchor" data-comment-id="c1">world</span> again</p>';
    const { hunks } = computeTrackedChanges(PLAIN, working);
    expect(hunks.some((h) => h.type === "add" && h.value.includes("again"))).toBe(true);
  });

  it("accept/reject preserve the anchor span in the working body", () => {
    // Real edit (add 'again') alongside a comment anchor; accepting the edit
    // must not strip the anchor markup from the working body.
    const working =
      '<p>hello <span class="comment-anchor" data-comment-id="c1">world</span> again</p>';
    const { parts, hunks } = computeTrackedChanges(PLAIN, working);
    const addIdx = hunks.find((h) => h.type === "add")!.index;
    expect(commitHunk(parts, addIdx).working).toContain('data-comment-id="c1"');
    expect(dismissHunk(parts, addIdx).working).toContain('data-comment-id="c1"');
  });

  it("newly-inserted anchored text is a real change (not noise)", () => {
    const working = '<p>hello<span class="review-anchor" data-review-id="r1">fresh</span></p>';
    const { hunks } = computeTrackedChanges("<p>hello</p>", working);
    expect(hunks.some((h) => h.type === "add" && h.value.includes("fresh"))).toBe(true);
  });
});
