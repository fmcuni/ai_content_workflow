import { describe, expect, it } from "vitest";

import { buildUserPrompt } from "./audit";

const BASE = {
  htmlBody: "<p>body</p>",
  gapUpdatePlan: { must_add: [] },
  citationIntents: [{ claim: "c1" }],
  citationsSummary: [{ domain: "ia.org.hk" }],
  deterministicFindings: [],
};

describe("buildUserPrompt (audit)", () => {
  it("appends the edit_note section when an operator brief is present", () => {
    const prompt = buildUserPrompt({ ...BASE, editNote: "重點介紹醫然保\nhttps://example.com" });
    expect(prompt.endsWith("\n\n# edit_note (operator brief)\n重點介紹醫然保\nhttps://example.com")).toBe(
      true,
    );
    // The existing sections stay untouched ahead of it.
    expect(prompt.startsWith("# final_html\n<p>body</p>\n\n")).toBe(true);
    expect(prompt).toContain("# deterministic_findings\n[]");
  });

  it("omits the edit_note section when the brief is null or empty", () => {
    for (const editNote of [null, undefined, ""]) {
      const prompt = buildUserPrompt({ ...BASE, editNote });
      expect(prompt).not.toContain("# edit_note");
      expect(prompt.endsWith("# deterministic_findings\n[]")).toBe(true);
    }
  });
});
