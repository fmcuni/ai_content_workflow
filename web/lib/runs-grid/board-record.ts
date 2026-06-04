import type { GroupKey } from "@/lib/runs-grid/groups";
import type { RunSummary, TopicBatch } from "@/lib/types";

// A single row on the board, runs and batches unified by the fields the grouping
// + ordering need. The discriminant carries the underlying record for rendering.
export type BoardRecord =
  | { kind: "run"; id: string; createdAt: string; group: GroupKey; voice: string; run: RunSummary }
  | { kind: "batch"; id: string; createdAt: string; group: GroupKey; voice: string; batch: TopicBatch };
