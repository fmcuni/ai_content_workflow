import { describe, expect, it, vi } from "vitest";

import { GeminiError, isTransientGeminiError, withGeminiRetry } from "./client";

const NO_BACKOFF = [0, 0];

describe("isTransientGeminiError", () => {
  it("treats SyntaxError (empty/truncated JSON body) as transient", () => {
    expect(isTransientGeminiError(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
  });

  it("treats network/5xx markers as transient", () => {
    expect(isTransientGeminiError(new Error("fetch failed"))).toBe(true);
    expect(isTransientGeminiError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransientGeminiError(new Error("connection terminated"))).toBe(true);
  });

  it("treats deterministic 4xx / schema errors as NON-transient", () => {
    expect(isTransientGeminiError(new Error("400 INVALID_ARGUMENT: bad schema"))).toBe(false);
    expect(isTransientGeminiError(new Error("permission denied"))).toBe(false);
    expect(isTransientGeminiError("not even an error")).toBe(false);
  });
});

describe("withGeminiRetry", () => {
  it("returns immediately on success (no retry)", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withGeminiRetry(fn, NO_BACKOFF)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure then succeeds", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new SyntaxError("Unexpected end of JSON input"))
      .mockResolvedValueOnce("recovered");
    expect(await withGeminiRetry(fn, NO_BACKOFF)).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows a deterministic error immediately without retrying", async () => {
    const fn = vi.fn(async () => {
      throw new Error("400 INVALID_ARGUMENT");
    });
    await expect(withGeminiRetry(fn, NO_BACKOFF)).rejects.toThrow("400 INVALID_ARGUMENT");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rewraps into GeminiError after exhausting attempts on persistent transient failure", async () => {
    const fn = vi.fn(async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    });
    await expect(withGeminiRetry(fn, NO_BACKOFF)).rejects.toBeInstanceOf(GeminiError);
    expect(fn).toHaveBeenCalledTimes(3); // GEMINI_MAX_ATTEMPTS
  });
});
