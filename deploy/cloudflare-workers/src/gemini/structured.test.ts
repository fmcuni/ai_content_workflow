import { describe, expect, it } from "vitest";

import { GeminiError, parseStructuredResponse } from "./client";

// Mirrors tests/unit/test_gemini_truncation.py. parseStructuredResponse parses
// first (no false positives), then on failure / empty body under an abnormal
// finishReason raises a clear, agent-attributed, non-transient GeminiError
// instead of a cryptic "not valid JSON" error.

const TRUNCATED = '{"diagnose": "ok", "markup": "# H1\\n\\nsome '; // cut off mid-string

describe("parseStructuredResponse", () => {
  it("returns parsed object on valid JSON with finishReason STOP", () => {
    expect(parseStructuredResponse("writer", '{"ok": true}', "STOP")).toEqual({ ok: true });
  });

  it("returns parsed object when finishReason is null (success default)", () => {
    expect(parseStructuredResponse("writer", '{"ok": true}', null)).toEqual({ ok: true });
  });

  it("MAX_TOKENS truncation → clear, agent-attributed GeminiError", () => {
    let thrown: unknown;
    try {
      parseStructuredResponse("writer", TRUNCATED, "MAX_TOKENS");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GeminiError);
    const msg = (thrown as Error).message;
    expect(msg).toContain("writer");
    expect(msg).toContain("MAX_TOKENS");
    expect(msg.toLowerCase()).toMatch(/truncated|incomplete/);
  });

  it("SAFETY block (empty body) → clear, agent-attributed GeminiError", () => {
    let thrown: unknown;
    try {
      parseStructuredResponse("audit", "", "SAFETY");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GeminiError);
    const msg = (thrown as Error).message;
    expect(msg).toContain("audit");
    expect(msg).toContain("SAFETY");
  });

  it("invalid JSON with normal STOP → GeminiError attributed to the agent", () => {
    expect(() => parseStructuredResponse("outline", "not json at all", "STOP")).toThrow(
      GeminiError,
    );
    expect(() => parseStructuredResponse("outline", "not json at all", "STOP")).toThrow(
      /outline/,
    );
  });

  it("invalid JSON with null finishReason → GeminiError attributed to the agent", () => {
    expect(() => parseStructuredResponse("gap_analysis", "garbage", null)).toThrow(/gap_analysis/);
  });

  it("valid JSON with MAX_TOKENS does not false-raise (parse-first)", () => {
    expect(parseStructuredResponse("writer", '{"ok": true}', "MAX_TOKENS")).toEqual({ ok: true });
  });
});
