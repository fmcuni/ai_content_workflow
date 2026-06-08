import { describe, expect, it } from "vitest";

import { CITATIONS_STEP_CONFIG } from "./step_config";

// Cloudflare's default step timeout is 10 minutes (600_000 ms). The bug behind
// prod run a6e897e1 was resolve_citations inheriting that default and burning a
// full 10 minutes per attempt. These guards keep the step bounded well under it.
const DEFAULT_STEP_TIMEOUT_MS = 600_000;

describe("CITATIONS_STEP_CONFIG", () => {
  it("caps each attempt well under the 10-minute default step timeout", () => {
    // Arrange
    const [valueStr, unit] = CITATIONS_STEP_CONFIG.timeout.split(" ");
    const seconds = Number(valueStr);

    // Assert
    expect(unit).toBe("seconds");
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds * 1000).toBeLessThan(DEFAULT_STEP_TIMEOUT_MS);
  });

  it("retries a bounded number of times with exponential backoff", () => {
    expect(CITATIONS_STEP_CONFIG.retries.backoff).toBe("exponential");
    expect(CITATIONS_STEP_CONFIG.retries.limit).toBeGreaterThan(0);
    expect(CITATIONS_STEP_CONFIG.retries.limit).toBeLessThanOrEqual(10);
  });
});
