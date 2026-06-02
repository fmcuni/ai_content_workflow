import { describe, expect, it } from "vitest";

import {
  capPayload,
  clampLimit,
  DEFAULT_LOG_LIMIT,
  deriveLevel,
  deriveStep,
  mapLogRow,
  MAX_LOG_LIMIT,
  parseEventToRow,
  parseLogQuery,
  shouldPersist,
  type EventEnvelope,
  type RawLogRow,
  type StartMsByStep,
} from "./event-log";

// ---------------------------------------------------------------------------
// deriveStep — second-to-last segment for VERB events, else last segment.
// VERBS = start, done, error, thinking, completed, interrupted.
// ---------------------------------------------------------------------------
describe("deriveStep", () => {
  it("returns the node name (second-to-last) for a verb-suffixed event", () => {
    expect(deriveStep("strategy.outline.done")).toBe("outline");
    expect(deriveStep("production.writer.start")).toBe("writer");
    expect(deriveStep("agent.writer.thinking")).toBe("writer");
  });

  it("returns null for a bare verb with no preceding segment", () => {
    expect(deriveStep("done")).toBeNull();
    expect(deriveStep("error")).toBeNull();
  });

  it("returns the last segment for a non-verb event", () => {
    expect(deriveStep("hitl.interrupted")).toBe("hitl");
    expect(deriveStep("graph.completed")).toBe("graph");
  });

  it("treats a single non-verb segment as the step", () => {
    expect(deriveStep("status")).toBe("status");
  });

  it("uses second-to-last for graph.error (error is a verb)", () => {
    expect(deriveStep("graph.error")).toBe("graph");
  });
});

// ---------------------------------------------------------------------------
// deriveLevel — thinking > error > gate > info.
// ---------------------------------------------------------------------------
describe("deriveLevel", () => {
  it("maps *.thinking to thinking", () => {
    expect(deriveLevel("agent.writer.thinking")).toBe("thinking");
  });

  it("maps *.error and graph.error to error", () => {
    expect(deriveLevel("production.audit.error")).toBe("error");
    expect(deriveLevel("graph.error")).toBe("error");
  });

  it("maps hitl.interrupted and *.gate to gate", () => {
    expect(deriveLevel("hitl.interrupted")).toBe("gate");
    expect(deriveLevel("hitl_2.gate")).toBe("gate");
  });

  it("defaults to info", () => {
    expect(deriveLevel("strategy.outline.done")).toBe("info");
    expect(deriveLevel("graph.completed")).toBe("info");
  });

  it("prefers thinking over error when both could apply", () => {
    // endsWith .thinking wins (checked first).
    expect(deriveLevel("x.thinking")).toBe("thinking");
  });
});

// ---------------------------------------------------------------------------
// capPayload — three regimes: small (unchanged), per-field cap, whole-payload cap.
// ---------------------------------------------------------------------------
describe("capPayload", () => {
  it("returns the payload unchanged when under MAX_BYTES", () => {
    const payload = { a: 1, b: "hello" };
    expect(capPayload(payload)).toEqual(payload);
  });

  it("caps an oversized string field once the whole payload exceeds MAX_BYTES", () => {
    // Whole payload must first exceed MAX_BYTES (16384) for capping to engage;
    // a single field over MAX_FIELD (2048) is then stubbed.
    const big = "x".repeat(20_000); // > MAX_BYTES, and > MAX_FIELD
    const payload = { keep: "small", big };
    const capped = capPayload(payload) as Record<string, unknown>;

    expect(capped["keep"]).toBe("small");
    expect(capped["big"]).toEqual({ _truncated: true, _bytes: 20_000 });
  });

  it("returns a small single-field payload unchanged even if a field > MAX_FIELD", () => {
    // 5000-byte field, but whole payload (~5KB) is under MAX_BYTES → unchanged.
    const big = "x".repeat(5000);
    const payload = { big };
    expect(capPayload(payload)).toEqual(payload);
  });

  it("falls back to a whole-payload summary when per-field capping is insufficient", () => {
    // Many small (<= MAX_FIELD) string fields that together exceed MAX_BYTES.
    // Per-field capping cannot shrink them (each is under MAX_FIELD), so the
    // whole-payload summary path is taken.
    const payload: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      payload[`k${i}`] = "y".repeat(1000); // each 1000 bytes < 2048
    }
    const totalBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    const capped = capPayload(payload) as Record<string, unknown>;

    expect(capped["_truncated"]).toBe(true);
    expect(capped["_bytes"]).toBe(totalBytes);
    expect(capped["_keys"]).toEqual(Object.keys(payload).sort());
  });
});

// ---------------------------------------------------------------------------
// shouldPersist — PERSIST_THINKING gating.
// ---------------------------------------------------------------------------
describe("shouldPersist", () => {
  it("persists non-thinking events regardless of toggle", () => {
    expect(shouldPersist("strategy.outline.done", false)).toBe(true);
    expect(shouldPersist("strategy.outline.done", true)).toBe(true);
  });

  it("persists thinking events only when toggle is on", () => {
    expect(shouldPersist("agent.writer.thinking", true)).toBe(true);
    expect(shouldPersist("agent.writer.thinking", false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseEventToRow — full row derivation incl. duration matching.
// ---------------------------------------------------------------------------
describe("parseEventToRow", () => {
  const STREAM = "11111111-1111-1111-1111-111111111111";

  it("derives all row fields from a typical done event", () => {
    const env: EventEnvelope = {
      event: "strategy.outline.done",
      run_id: STREAM,
      timestamp: "2026-06-03T10:00:01.000Z",
      iteration: 2,
      payload: { ok: true },
    };
    const row = parseEventToRow(STREAM, "run", env, 5, {});

    expect(row.stream_id).toBe(STREAM);
    expect(row.stream_kind).toBe("run");
    expect(row.seq).toBe(5);
    expect(row.event).toBe("strategy.outline.done");
    expect(row.level).toBe("info");
    expect(row.step).toBe("outline");
    expect(row.iteration).toBe(2);
    expect(row.recorded_at).toBe("2026-06-03T10:00:01.000Z");
    expect(row.payload).toEqual({ ok: true });
  });

  it("iteration defaults to null when absent", () => {
    const env: EventEnvelope = {
      event: "graph.completed",
      timestamp: "2026-06-03T10:00:00.000Z",
      payload: {},
    };
    const row = parseEventToRow(STREAM, "run", env, 0, {});
    expect(row.iteration).toBeNull();
  });

  it("computes duration_ms for a .done from the most recent matching .start", () => {
    const startMs: StartMsByStep = {};

    const startEnv: EventEnvelope = {
      event: "production.writer.start",
      timestamp: "2026-06-03T10:00:00.000Z",
      payload: {},
    };
    const startRow = parseEventToRow(STREAM, "run", startEnv, 0, startMs);
    expect(startRow.duration_ms).toBeNull();
    // The start time is recorded keyed by step for later done-matching.
    expect(startMs["writer"]).toBe(Date.parse("2026-06-03T10:00:00.000Z"));

    const doneEnv: EventEnvelope = {
      event: "production.writer.done",
      timestamp: "2026-06-03T10:00:02.500Z",
      payload: {},
    };
    const doneRow = parseEventToRow(STREAM, "run", doneEnv, 1, startMs);
    expect(doneRow.duration_ms).toBe(2500);
  });

  it("leaves duration_ms null for a .done with no preceding .start", () => {
    const doneEnv: EventEnvelope = {
      event: "production.audit.done",
      timestamp: "2026-06-03T10:00:02.000Z",
      payload: {},
    };
    const row = parseEventToRow(STREAM, "run", doneEnv, 3, {});
    expect(row.duration_ms).toBeNull();
  });

  it("matches duration by step, not across different steps", () => {
    const startMs: StartMsByStep = {};
    parseEventToRow(
      STREAM,
      "run",
      { event: "production.writer.start", timestamp: "2026-06-03T10:00:00.000Z", payload: {} },
      0,
      startMs,
    );
    // A done for a DIFFERENT step has no matching start.
    const row = parseEventToRow(
      STREAM,
      "run",
      { event: "production.audit.done", timestamp: "2026-06-03T10:00:05.000Z", payload: {} },
      1,
      startMs,
    );
    expect(row.duration_ms).toBeNull();
  });

  it("caps an oversized payload string field", () => {
    const big = "z".repeat(20_000);
    const env: EventEnvelope = {
      event: "production.writer.done",
      timestamp: "2026-06-03T10:00:00.000Z",
      payload: { big },
    };
    const row = parseEventToRow(STREAM, "run", env, 0, {});
    expect(row.payload).toEqual({ big: { _truncated: true, _bytes: 20_000 } });
  });

  it("assigns monotonic seq from the caller across a sequence", () => {
    const startMs: StartMsByStep = {};
    const events: EventEnvelope[] = [
      { event: "strategy.outline.start", timestamp: "2026-06-03T10:00:00.000Z", payload: {} },
      { event: "strategy.outline.done", timestamp: "2026-06-03T10:00:01.000Z", payload: {} },
      { event: "graph.completed", timestamp: "2026-06-03T10:00:02.000Z", payload: {} },
    ];
    const rows = events.map((e, i) => parseEventToRow(STREAM, "run", e, i, startMs));
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(rows[1]!.duration_ms).toBe(1000);
  });

  it("handles batch stream_kind envelopes (batch_id, no run_id)", () => {
    const env: EventEnvelope = {
      event: "topic_gen.done",
      batch_id: STREAM,
      timestamp: "2026-06-03T10:00:00.000Z",
      payload: { count: 5 },
    };
    const row = parseEventToRow(STREAM, "batch", env, 0, {});
    expect(row.stream_kind).toBe("batch");
    expect(row.step).toBe("topic_gen");
    expect(row.payload).toEqual({ count: 5 });
  });
});

// ---------------------------------------------------------------------------
// clampLimit + parseLogQuery — read-API query parsing.
// ---------------------------------------------------------------------------
describe("clampLimit", () => {
  it("defaults when unset or non-positive", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LOG_LIMIT);
    expect(clampLimit(0)).toBe(DEFAULT_LOG_LIMIT);
    expect(clampLimit(-5)).toBe(DEFAULT_LOG_LIMIT);
  });

  it("caps at MAX_LOG_LIMIT", () => {
    expect(clampLimit(999_999)).toBe(MAX_LOG_LIMIT);
  });

  it("passes through a valid in-range limit (truncated to int)", () => {
    expect(clampLimit(150)).toBe(150);
    expect(clampLimit(150.9)).toBe(150);
  });
});

describe("parseLogQuery", () => {
  it("parses since_seq, limit, and level", () => {
    const params = new URLSearchParams("since_seq=42&limit=100&level=thinking");
    expect(parseLogQuery(params)).toEqual({ sinceSeq: 42, limit: 100, level: "thinking" });
  });

  it("returns an empty query when nothing is provided", () => {
    expect(parseLogQuery(new URLSearchParams(""))).toEqual({});
  });

  it("ignores blank and non-numeric values", () => {
    const params = new URLSearchParams("since_seq=&limit=abc&level=");
    expect(parseLogQuery(params)).toEqual({});
  });

  it("accepts every valid level", () => {
    for (const level of ["info", "thinking", "gate", "error"]) {
      const params = new URLSearchParams(`level=${level}`);
      expect(parseLogQuery(params)).toEqual({ level });
    }
  });

  it("rejects an invalid level so garbage never reaches the SQL filter", () => {
    expect(parseLogQuery(new URLSearchParams("level=bogus"))).toEqual({});
    // SQL-injection-shaped garbage is dropped, not forwarded.
    expect(parseLogQuery(new URLSearchParams("level=info' OR '1'='1"))).toEqual({});
    // Case must match exactly (DB stores lowercase).
    expect(parseLogQuery(new URLSearchParams("level=INFO"))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// mapLogRow — pure DB-row → response-row coercion.
// With fetch_types:false, postgres.js returns numerics as strings; the mapper
// coerces seq / iteration / duration_ms back to number | null.
// ---------------------------------------------------------------------------
describe("mapLogRow", () => {
  const base: RawLogRow = {
    log_id: "22222222-2222-2222-2222-222222222222",
    stream_id: "11111111-1111-1111-1111-111111111111",
    stream_kind: "run",
    seq: "7",
    event: "production.writer.done",
    level: "info",
    step: "writer",
    iteration: "2",
    duration_ms: "2500",
    payload: { ok: true },
    recorded_at: "2026-06-03T10:00:00.000Z",
  };

  it("coerces seq, iteration, and duration_ms from string to number", () => {
    const row = mapLogRow(base);
    expect(row.seq).toBe(7);
    expect(row.iteration).toBe(2);
    expect(row.duration_ms).toBe(2500);
    // The numeric fields are real numbers, not strings.
    expect(typeof row.seq).toBe("number");
    expect(typeof row.iteration).toBe("number");
    expect(typeof row.duration_ms).toBe("number");
  });

  it("preserves null iteration / duration_ms", () => {
    const row = mapLogRow({ ...base, iteration: null, duration_ms: null });
    expect(row.iteration).toBeNull();
    expect(row.duration_ms).toBeNull();
  });

  it("accepts numeric inputs unchanged (driver may already coerce)", () => {
    const row = mapLogRow({ ...base, seq: 9, iteration: 3, duration_ms: 1000 });
    expect(row.seq).toBe(9);
    expect(row.iteration).toBe(3);
    expect(row.duration_ms).toBe(1000);
  });

  it("passes through non-numeric columns and payload untouched", () => {
    const row = mapLogRow(base);
    expect(row.log_id).toBe(base.log_id);
    expect(row.stream_id).toBe(base.stream_id);
    expect(row.stream_kind).toBe("run");
    expect(row.event).toBe("production.writer.done");
    expect(row.level).toBe("info");
    expect(row.step).toBe("writer");
    expect(row.payload).toEqual({ ok: true });
    expect(row.recorded_at).toBe("2026-06-03T10:00:00.000Z");
  });
});
