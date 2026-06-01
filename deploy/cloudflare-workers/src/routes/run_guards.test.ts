import { describe, expect, it } from "vitest";

import { restartGuard } from "./run_guards";

describe("restartGuard", () => {
  it("returns not_found when the run row is missing", () => {
    expect(restartGuard(undefined)).toEqual({ error: "not_found" });
  });

  it("returns not_failed for a still-running run", () => {
    expect(restartGuard({ status: "production" })).toEqual({ error: "not_failed" });
  });

  it("returns not_failed for an already-published run", () => {
    expect(restartGuard({ status: "published" })).toEqual({ error: "not_failed" });
  });

  it("allows restart of a failed run", () => {
    expect(restartGuard({ status: "failed" })).toEqual({ ok: true });
  });
});
