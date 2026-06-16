import type { GraphMode, RunEventLog, RunSummary } from "@/lib/types";

// Per-node execution summary derived from one run's event log. Deliberately
// telemetry-free (no tokens, no latency — those live in /runs and /costs): just
// "did this node run, and how many passes". The pass count comes from `.start`
// events, so the writer's refine-loop iterations surface as ×N on the card.
export interface NodeRunStatus {
  ran: boolean;
  // Number of `.start` events for this step. 1 = single pass; ≥2 = re-entered
  // (the writer/audit refine loop). 0 when the step only logged a `.done`.
  executions: number;
}

export interface RunOverlay {
  // The anchored run's pipeline matches the mode tab currently on the canvas.
  // When false the displayed nodes don't correspond to this run's execution, so
  // callers suppress per-node chips and show a "different mode" notice instead.
  modeMatches: boolean;
  // Any step executed at all — distinguishes "did not run" nodes from a run that
  // simply has no logs yet.
  ranAtAll: boolean;
  byNode: Record<string, NodeRunStatus>;
}

/**
 * Map a run to the studio graph mode whose nodes it traversed. Runs only ever
 * start in `refresh` or `create` (`topic_expansion` is a batch-level flow with
 * no RunSummary), so a missing/legacy `start_mode` is treated as `refresh`.
 */
export function graphModeForRun(run: Pick<RunSummary, "start_mode">): GraphMode {
  return run.start_mode === "create" ? "create" : "refresh";
}

/**
 * Pure transform: a run's event-log rows + the run + the displayed mode → a
 * per-node execution overlay. `step` already equals the node id (the backend
 * derives it from event names like `production.writer.done` → "writer"), so no
 * mapping table is needed. Counting `.start` events per step yields the pass
 * count (each writer refine pass emits one `writer.start`).
 */
export function buildRunOverlay(
  logs: readonly RunEventLog[],
  run: Pick<RunSummary, "start_mode">,
  displayMode: GraphMode,
): RunOverlay {
  const byNode: Record<string, NodeRunStatus> = {};
  for (const row of logs) {
    if (!row.step) continue;
    const prev = byNode[row.step] ?? { ran: true, executions: 0 };
    const isStart = row.event.endsWith(".start");
    byNode[row.step] = {
      ran: true,
      executions: prev.executions + (isStart ? 1 : 0),
    };
  }
  return {
    modeMatches: graphModeForRun(run) === displayMode,
    ranAtAll: Object.keys(byNode).length > 0,
    byNode,
  };
}
