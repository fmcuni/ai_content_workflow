import { describe, expect, it } from "vitest";

import type { RunEventLog } from "@/lib/types";
import { buildRunOverlay, graphModeForRun } from "./run-overlay";

function row(over: Partial<RunEventLog>): RunEventLog {
  return {
    log_id: "l",
    stream_id: "r",
    stream_kind: "run",
    seq: 0,
    event: "x.start",
    level: "info",
    step: null,
    iteration: null,
    duration_ms: null,
    payload: {},
    recorded_at: "2026-06-17T00:00:00Z",
    ...over,
  };
}

describe("graphModeForRun", () => {
  it("maps start_mode create → create, everything else → refresh", () => {
    expect(graphModeForRun({ start_mode: "create" })).toBe("create");
    expect(graphModeForRun({ start_mode: "refresh" })).toBe("refresh");
    expect(graphModeForRun({ start_mode: undefined })).toBe("refresh");
  });
});

describe("buildRunOverlay", () => {
  it("marks executed steps and counts .start passes per node", () => {
    const logs: RunEventLog[] = [
      row({ seq: 1, event: "strategy.gap_analysis.start", step: "gap_analysis" }),
      row({ seq: 2, event: "strategy.gap_analysis.done", step: "gap_analysis" }),
      row({ seq: 3, event: "production.writer.start", step: "writer" }),
      row({ seq: 4, event: "production.audit.start", step: "audit" }),
      row({ seq: 5, event: "production.writer.start", step: "writer" }), // refine pass 2
      row({ seq: 6, event: "production.writer.done", step: "writer" }),
    ];
    const overlay = buildRunOverlay(logs, { start_mode: "refresh" }, "refresh");

    expect(overlay.ranAtAll).toBe(true);
    expect(overlay.byNode.gap_analysis).toEqual({ ran: true, executions: 1 });
    expect(overlay.byNode.writer).toEqual({ ran: true, executions: 2 });
    expect(overlay.byNode.audit).toEqual({ ran: true, executions: 1 });
    // A node that never appears in the log is simply absent from byNode.
    expect(overlay.byNode.outline).toBeUndefined();
  });

  it("counts a step with only a .done event as ran with zero starts", () => {
    const overlay = buildRunOverlay(
      [row({ seq: 1, event: "production.render_html.done", step: "render_html" })],
      { start_mode: "refresh" },
      "refresh",
    );
    expect(overlay.byNode.render_html).toEqual({ ran: true, executions: 0 });
  });

  it("ignores rows with no step and reports ranAtAll false for an empty log", () => {
    const overlay = buildRunOverlay(
      [row({ seq: 1, event: "graph.error", step: null })],
      { start_mode: "refresh" },
      "refresh",
    );
    expect(overlay.ranAtAll).toBe(false);
    expect(overlay.byNode).toEqual({});
  });

  it("flags modeMatches against the displayed mode", () => {
    const logs = [row({ seq: 1, event: "outline.start", step: "outline" })];
    expect(buildRunOverlay(logs, { start_mode: "create" }, "create").modeMatches).toBe(true);
    expect(buildRunOverlay(logs, { start_mode: "create" }, "refresh").modeMatches).toBe(false);
    expect(buildRunOverlay(logs, { start_mode: "refresh" }, "topic_expansion").modeMatches).toBe(
      false,
    );
  });
});
