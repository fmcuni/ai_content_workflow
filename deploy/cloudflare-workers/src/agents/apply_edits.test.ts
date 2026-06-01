import { describe, expect, it } from "vitest";

import { buildUserPrompt, parseApplyEditsOutput } from "./apply_edits";

describe("buildUserPrompt", () => {
  it("includes the HTML, anchored comments, and the overall note", () => {
    // Arrange / Act
    const prompt = buildUserPrompt({
      htmlBody: "<p>原文段落</p>",
      comments: [{ anchor_text: "原文段落", body: "請寫得更簡潔" }],
      notes: "整體要更貼地",
    });

    // Assert
    expect(prompt).toContain("<p>原文段落</p>");
    expect(prompt).toContain("「原文段落」");
    expect(prompt).toContain("請寫得更簡潔");
    expect(prompt).toContain("整體要更貼地");
  });

  it("omits the comments section when no comment has a body", () => {
    const prompt = buildUserPrompt({
      htmlBody: "<p>x</p>",
      comments: [{ anchor_text: "x", body: "  " }],
      notes: "整體調整",
    });
    expect(prompt).not.toContain("comments）");
    expect(prompt).toContain("整體調整");
  });

  it("omits the overall note section when notes are blank", () => {
    const prompt = buildUserPrompt({
      htmlBody: "<p>x</p>",
      comments: [{ anchor_text: "x", body: "改" }],
      notes: null,
    });
    expect(prompt).not.toContain("overall note");
    expect(prompt).toContain("改");
  });
});

describe("parseApplyEditsOutput", () => {
  it("returns the html_body string", () => {
    expect(parseApplyEditsOutput({ html_body: "<p>revised</p>", diagnose: "x" })).toBe(
      "<p>revised</p>",
    );
  });

  it("throws when html_body is missing or not a string", () => {
    expect(() => parseApplyEditsOutput({ diagnose: "x" })).toThrow("missing html_body");
    expect(() => parseApplyEditsOutput({ html_body: 42 })).toThrow("missing html_body");
  });
});
