import { describe, expect, it } from "vitest";

import { estimateCents, runTokensAndCents, sumRunCents } from "./costs";

// gemini-3.5-flash rates (USD per 1M): input 0.3, output 2.5, thinking 2.5.
// cents = trunc((tin/1e6*0.3 + tout/1e6*2.5 + tthk/1e6*2.5) * 100)

describe("estimateCents", () => {
  it("truncates toward zero like Python int(usd*100)", () => {
    // Arrange: chosen so usd*100 has a fractional part that must be dropped.
    // 1_000_000 in => 0.3 usd => 30 cents exactly.
    // Act / Assert
    expect(estimateCents("gemini-3.5-flash", 1_000_000, 0, 0)).toBe(30);
  });

  it("returns 0 for an unknown model", () => {
    expect(estimateCents("does-not-exist", 9_999_999, 9_999_999, 9_999_999)).toBe(0);
  });

  it("truncates small sub-cent token counts to 0", () => {
    // 3837 in + 2953 out + 4501 thinking ≈ 0.0196 usd => 1.96 cents => 1.
    expect(estimateCents("gemini-3.5-flash", 3837, 2953, 4501)).toBe(1);
  });
});

describe("runTokensAndCents — string SUM coercion (regression)", () => {
  it("ADDS string-valued draft SUM columns instead of concatenating them", () => {
    // Arrange: GA columns arrive as numbers (integer over the wire); draft
    // columns arrive as STRINGS from SUM() under fetch_types:false. The old
    // `n()` path did `3837 + "2953"` => "38372953" (string concat) and blew up.
    const row = {
      run_id: "r1",
      ga_tokens_in: 3837,
      ga_tokens_out: 2953,
      ga_thinking_tokens: 4501,
      draft_tokens_in: "1000",
      draft_tokens_out: "2000",
      draft_thinking_tokens: "3000",
    };

    // Act
    const { totals } = runTokensAndCents(row);

    // Assert: arithmetic addition, NOT concatenation.
    expect(totals).toEqual({
      tokens_in: 4837,
      tokens_out: 4953,
      thinking_tokens: 7501,
    });
  });

  it("treats null token columns as 0 (Python `x or 0`)", () => {
    const row = {
      run_id: "r1",
      ga_tokens_in: null,
      ga_tokens_out: null,
      ga_thinking_tokens: null,
      draft_tokens_in: null,
      draft_tokens_out: null,
      draft_thinking_tokens: null,
    };

    const { totals, cents } = runTokensAndCents(row);

    expect(totals).toEqual({ tokens_in: 0, tokens_out: 0, thinking_tokens: 0 });
    expect(cents).toBe(0);
  });

  it("handles numeric draft sums too (no fetch_types dependence)", () => {
    const row = {
      run_id: "r1",
      ga_tokens_in: 100,
      ga_tokens_out: 0,
      ga_thinking_tokens: 0,
      draft_tokens_in: 50,
      draft_tokens_out: 0,
      draft_thinking_tokens: 0,
    };

    const { totals } = runTokensAndCents(row);

    expect(totals.tokens_in).toBe(150);
  });
});

describe("sumRunCents — per-run truncation then sum", () => {
  it("truncates EACH run independently before summing (matches Python loop)", () => {
    // Two runs that each individually truncate to 1 cent (≈1.96 each). Summing
    // truncated-per-run gives 1 + 1 = 2, NOT trunc of the combined total.
    const rows = [
      {
        run_id: "a",
        ga_tokens_in: 3837,
        ga_tokens_out: 2953,
        ga_thinking_tokens: 4501,
        draft_tokens_in: 0,
        draft_tokens_out: 0,
        draft_thinking_tokens: 0,
      },
      {
        run_id: "b",
        ga_tokens_in: 3837,
        ga_tokens_out: 2953,
        ga_thinking_tokens: 4501,
        draft_tokens_in: 0,
        draft_tokens_out: 0,
        draft_thinking_tokens: 0,
      },
    ];

    expect(sumRunCents(rows)).toBe(2);
  });

  it("does NOT inflate when draft sums arrive as strings (the reported bug)", () => {
    // A single run whose draft SUM columns are strings. The old code produced a
    // grossly inflated cents value via string concatenation; the fix keeps it
    // at the true ~1 cent.
    const rows = [
      {
        run_id: "a",
        ga_tokens_in: 3837,
        ga_tokens_out: 2953,
        ga_thinking_tokens: 4501,
        draft_tokens_in: "0",
        draft_tokens_out: "0",
        draft_thinking_tokens: "0",
      },
    ];

    expect(sumRunCents(rows)).toBe(1);
  });

  it("returns 0 for no rows", () => {
    expect(sumRunCents([])).toBe(0);
  });
});
