import { describe, expect, it } from "vitest";

import type { RunEventLog, SseEvent } from "@/lib/types";
import {
  filterRowsByLevel,
  formatLogDuration,
  formatLogTime,
  highestSeq,
  mergeLogRows,
} from "@/lib/debug-log";

function persisted(over: Partial<RunEventLog> = {}): RunEventLog {
  return {
    log_id: over.log_id ?? `log-${over.seq ?? 1}`,
    stream_id: over.stream_id ?? "run-1",
    stream_kind: over.stream_kind ?? "run",
    seq: over.seq ?? 1,
    event: over.event ?? "node.start",
    level: over.level ?? "info",
    step: over.step ?? null,
    iteration: over.iteration ?? null,
    duration_ms: over.duration_ms ?? null,
    payload: over.payload ?? {},
    recorded_at: over.recorded_at ?? "2026-06-03T10:00:00.000Z",
  };
}

function live(over: Partial<SseEvent> = {}): SseEvent {
  return {
    event: over.event ?? "node.start",
    run_id: over.run_id ?? "run-1",
    iteration: over.iteration,
    timestamp: over.timestamp ?? "2026-06-03T10:00:00.000Z",
    payload: over.payload ?? {},
  };
}

describe("highestSeq", () => {
  it("returns 0 for an empty list", () => {
    expect(highestSeq([])).toBe(0);
  });

  it("returns the largest seq regardless of ordering", () => {
    expect(highestSeq([persisted({ seq: 3 }), persisted({ seq: 1 }), persisted({ seq: 7 })])).toBe(
      7,
    );
  });
});

describe("mergeLogRows", () => {
  it("returns persisted rows ordered by seq ASC", () => {
    const rows = mergeLogRows(
      [persisted({ seq: 3, event: "c" }), persisted({ seq: 1, event: "a" }), persisted({ seq: 2, event: "b" })],
      [],
    );
    expect(rows.map((r) => r.event)).toEqual(["a", "b", "c"]);
    expect(rows.every((r) => r.source === "persisted")).toBe(true);
  });

  it("appends live events newer than the max persisted recorded_at", () => {
    const rows = mergeLogRows(
      [persisted({ seq: 1, recorded_at: "2026-06-03T10:00:00.000Z", event: "persisted-1" })],
      [live({ timestamp: "2026-06-03T10:00:05.000Z", event: "live-fresh" })],
    );
    expect(rows.map((r) => r.event)).toEqual(["persisted-1", "live-fresh"]);
    expect(rows[1].source).toBe("live");
  });

  it("drops live events already represented in persisted rows (same event+timestamp)", () => {
    const ts = "2026-06-03T10:00:00.000Z";
    const rows = mergeLogRows(
      [persisted({ seq: 1, event: "dup", recorded_at: ts })],
      [live({ event: "dup", timestamp: ts })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("persisted");
  });

  it("drops live events older than or equal to the persisted high-water mark", () => {
    const rows = mergeLogRows(
      [persisted({ seq: 1, recorded_at: "2026-06-03T10:00:10.000Z" })],
      [live({ event: "stale", timestamp: "2026-06-03T10:00:01.000Z" })],
    );
    expect(rows.some((r) => r.event === "stale")).toBe(false);
  });

  it("keeps all live events when there are no persisted rows yet", () => {
    const rows = mergeLogRows(
      [],
      [
        live({ event: "l1", timestamp: "2026-06-03T10:00:00.000Z" }),
        live({ event: "l2", timestamp: "2026-06-03T10:00:01.000Z" }),
      ],
    );
    expect(rows.map((r) => r.event)).toEqual(["l1", "l2"]);
    expect(rows.every((r) => r.source === "live")).toBe(true);
  });

  it("dedupes repeated live events by event+timestamp", () => {
    const ts = "2026-06-03T10:00:00.000Z";
    const rows = mergeLogRows([], [live({ event: "x", timestamp: ts }), live({ event: "x", timestamp: ts })]);
    expect(rows).toHaveLength(1);
  });

  it("orders out-of-order live events chronologically by timestamp", () => {
    const rows = mergeLogRows(
      [],
      [
        live({ event: "late", timestamp: "2026-06-03T10:00:03.000Z" }),
        live({ event: "early", timestamp: "2026-06-03T10:00:01.000Z" }),
        live({ event: "mid", timestamp: "2026-06-03T10:00:02.000Z" }),
      ],
    );
    expect(rows.map((r) => r.event)).toEqual(["early", "mid", "late"]);
  });
});

describe("filterRowsByLevel", () => {
  const rows = mergeLogRows(
    [
      persisted({ seq: 1, level: "info", event: "i" }),
      persisted({ seq: 2, level: "thinking", event: "t" }),
      persisted({ seq: 3, level: "gate", event: "g" }),
      persisted({ seq: 4, level: "error", event: "e" }),
    ],
    [],
  );

  it("'all' returns every row", () => {
    expect(filterRowsByLevel(rows, "all")).toHaveLength(4);
  });

  it("'milestones' returns info + gate only", () => {
    expect(filterRowsByLevel(rows, "milestones").map((r) => r.event).sort()).toEqual(["g", "i"]);
  });

  it("'thinking' returns thinking only", () => {
    expect(filterRowsByLevel(rows, "thinking").map((r) => r.event)).toEqual(["t"]);
  });

  it("'errors' returns errors only", () => {
    expect(filterRowsByLevel(rows, "errors").map((r) => r.event)).toEqual(["e"]);
  });
});

describe("formatLogTime", () => {
  it("formats HH:MM:SS.mmm", () => {
    // Construct a known local time to avoid timezone flakiness on the date part.
    const d = new Date(2026, 5, 3, 14, 5, 9, 123);
    expect(formatLogTime(d.toISOString())).toBe("14:05:09.123");
  });
});

describe("formatLogDuration", () => {
  it("returns null for null/undefined", () => {
    expect(formatLogDuration(null)).toBeNull();
  });

  it("formats sub-second durations in ms", () => {
    expect(formatLogDuration(640)).toBe("640ms");
  });

  it("formats second-scale durations with one decimal", () => {
    expect(formatLogDuration(1600)).toBe("1.6s");
  });

  it("formats large durations in seconds", () => {
    expect(formatLogDuration(12000)).toBe("12.0s");
  });
});
