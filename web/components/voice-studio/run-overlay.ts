import type { GraphMode, RunEventLog, RunSummary } from "@/lib/types";

// Per-node execution summary derived from one run's event log. Deliberately
// telemetry-free (no tokens, no latency — those live in /runs and /costs): just
// "did this node run, and how many passes". The pass count comes from `.start`
// events, so the writer's refine-loop iterations surface as ×N on the card.
//
// A node only appears in the overlay's `byNode` map if it ran; the layout maps
// absence (for an in-mode node) to the `did-not-run` variant, and "no overlay"
// (mode mismatch / no run) to `undefined`. Encoding the three card states as a
// discriminated union keeps them mutually exclusive — no boolean+count combo
// can express an impossible state like "did not run, 3 executions".
export type NodeRunStatus =
  | {
      kind: "ran";
      // Number of `.start` events for this step. 1 = single pass; ≥2 = re-entered
      // (the writer/audit refine loop). 0 only if the step logged a lone `.done`.
      executions: number;
    }
  | { kind: "did-not-run" };

// Nodes present in `byNode` always ran; narrow to that variant for the map.
type RanStatus = Extract<NodeRunStatus, { kind: "ran" }>;

export interface RunOverlay {
  // The anchored run's pipeline matches the mode tab currently on the canvas.
  // When false the displayed nodes don't correspond to this run's execution, so
  // callers suppress per-node chips and show a "different mode" notice instead.
  modeMatches: boolean;
  // Any step executed at all — distinguishes "did not run" nodes from a run that
  // simply has no logs yet.
  ranAtAll: boolean;
  byNode: Record<string, RanStatus>;
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
  const byNode: Record<string, RanStatus> = {};
  for (const row of logs) {
    // Lifecycle/non-node events have no derived step — intentionally skipped,
    // not a swallowed error (deriveStep returns null for run-level events).
    if (!row.step) continue;
    const prev = byNode[row.step];
    const isStart = row.event.endsWith(".start");
    byNode[row.step] = {
      kind: "ran",
      executions: (prev?.executions ?? 0) + (isStart ? 1 : 0),
    };
  }
  return {
    modeMatches: graphModeForRun(run) === displayMode,
    ranAtAll: Object.keys(byNode).length > 0,
    byNode,
  };
}
