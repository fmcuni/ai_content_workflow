import { describe, expect, it } from "vitest";

import { runBulk, summarizeBulk, type BulkOutcome } from "./bulk";

/** A manually-resolvable promise for instrumenting in-flight concurrency. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runBulk", () => {
  it("returns an empty outcome for empty ids", async () => {
    const outcome = await runBulk([], async () => undefined);
    expect(outcome.results).toEqual([]);
    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failed).toEqual([]);
  });

  it("never rejects: a throwing worker becomes a failed item with its message", async () => {
    const outcome = await runBulk(["a", "b"], async (id) => {
      if (id === "b") throw new Error("boom");
    });
    expect(outcome.results).toEqual([
      { id: "a", ok: true },
      { id: "b", ok: false, error: "boom" },
    ]);
    expect(outcome.succeeded).toEqual(["a"]);
    expect(outcome.failed).toEqual(["b"]);
  });

  it("stringifies non-Error throws", async () => {
    const outcome = await runBulk(["x"], async () => {
      throw "plain-string-failure";
    });
    expect(outcome.results[0]).toEqual({ id: "x", ok: false, error: "plain-string-failure" });
  });

  it("preserves input order in results even when later ids finish first", async () => {
    // First id resolves slowest; results must still be ordered by input index.
    const outcome = await runBulk(
      ["first", "second", "third"],
      async (id) => {
        await new Promise((r) => setTimeout(r, id === "first" ? 20 : 1));
      },
      4,
    );
    expect(outcome.results.map((r) => r.id)).toEqual(["first", "second", "third"]);
    expect(outcome.succeeded).toEqual(["first", "second", "third"]);
  });

  it("partitions succeeded / failed correctly on partial failure", async () => {
    const ids = ["a", "b", "c", "d"];
    const outcome = await runBulk(ids, async (id) => {
      if (id === "b" || id === "d") throw new Error(`fail-${id}`);
    });
    expect(outcome.succeeded).toEqual(["a", "c"]);
    expect(outcome.failed).toEqual(["b", "d"]);
  });

  it("never runs more than `concurrency` workers in flight", async () => {
    const concurrency = 3;
    const ids = Array.from({ length: 10 }, (_, i) => `id-${i}`);

    let inFlight = 0;
    let maxInFlight = 0;
    // One deferred per id so we control exactly when each worker resolves.
    const gates = new Map(ids.map((id) => [id, deferred()]));

    const promise = runBulk(
      ids,
      async (id) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gates.get(id)!.promise;
        inFlight -= 1;
      },
      concurrency,
    );

    // Drain the gates a few at a time, yielding so the pool can refill lanes.
    for (const id of ids) {
      gates.get(id)!.resolve();
      await Promise.resolve();
    }

    const outcome = await promise;
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    expect(outcome.succeeded).toHaveLength(ids.length);
  });

  it("caps lanes at the id count when concurrency exceeds it", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const outcome = await runBulk(
      ["a", "b"],
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
      10,
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(outcome.succeeded).toEqual(["a", "b"]);
  });
});

describe("summarizeBulk", () => {
  const outcome = (succeeded: string[], failed: string[]): BulkOutcome => ({
    results: [
      ...succeeded.map((id) => ({ id, ok: true as const })),
      ...failed.map((id) => ({ id, ok: false as const, error: "e" })),
    ],
    succeeded,
    failed,
  });

  it("all-ok → `N verb`", () => {
    expect(summarizeBulk(outcome(["a", "b", "c"], []), "updated")).toBe("3 updated");
  });

  it("all-fail → `N failed — retry`", () => {
    expect(summarizeBulk(outcome([], ["a", "b"]), "published")).toBe("2 failed — retry");
  });

  it("mixed → `OK verb, BAD failed — retry`", () => {
    expect(summarizeBulk(outcome(["a", "b"], ["c"]), "restarted")).toBe(
      "2 restarted, 1 failed — retry",
    );
  });
});
