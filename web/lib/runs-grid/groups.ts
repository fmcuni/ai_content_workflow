// Pure status → status-group mapping for the Runs Ledger board. The board is a
// *second lens* over the same runs + topic batches the Desk renders: instead of
// the Desk's three workflow lanes (desk/motion/filed) it groups every record by
// where it stands. Four ordered groups, newest-first within each. Run statuses
// and batch statuses both fold into the same four groups.
//
// No React here — kept side-effect-free so the mapping + ordering is
// unit-testable and reused by the group sections, the collapse toggle and the
// "needs you" badge counts.

import type { BatchStatus, RunStatus } from "@/lib/types";

// The four board groups, in display order. A group's tone drives only its small
// status bar — status colour stays the single colour-coded signal on the board.
export type GroupKey = "review" | "generating" | "approved" | "failed";

export type GroupTone = "accent" | "info" | "ok" | "danger";

export interface GroupDef {
  key: GroupKey;
  label: string;
  tone: GroupTone;
  /** Small-caps note shown on the group header (only the review group has one). */
  hint?: string;
}

// Ordered top-to-bottom exactly as the demo lays them out.
export const GROUPS: readonly GroupDef[] = [
  { key: "review", label: "Needs your review", tone: "accent", hint: "waiting on you" },
  { key: "generating", label: "Generating", tone: "info" },
  { key: "approved", label: "Approved & published", tone: "ok" },
  { key: "failed", label: "Failed & closed", tone: "danger" },
];

// Groups collapsed by the "Collapse done" rail toggle — the terminal groups.
export const DONE_GROUPS: readonly GroupKey[] = ["approved", "failed"];

const RUN_GROUP: Record<RunStatus, GroupKey> = {
  hitl_1: "review",
  hitl_2: "review",
  changes_requested: "review",
  pending: "generating",
  fetching: "generating",
  strategy: "generating",
  production: "generating",
  publishing: "generating",
  revising: "generating",
  persisted: "approved",
  published: "approved",
  failed: "failed",
  rejected: "failed",
  cancelled: "failed",
};

const BATCH_GROUP: Record<BatchStatus, GroupKey> = {
  ready_for_review: "review",
  partially_promoted: "review",
  pending: "generating",
  generating: "generating",
  analysing: "generating",
  done: "approved",
  failed: "failed",
};

/** Group a run belongs to, by status. */
export function runGroup(status: RunStatus): GroupKey {
  return RUN_GROUP[status];
}

/** Group a topic batch belongs to, by status. */
export function batchGroup(status: BatchStatus): GroupKey {
  return BATCH_GROUP[status];
}

/** Group for either record kind — the board iterates a mixed list. */
export function groupOf(kind: "run" | "batch", status: string): GroupKey {
  return kind === "batch"
    ? BATCH_GROUP[status as BatchStatus]
    : RUN_GROUP[status as RunStatus];
}

// Minimal shape the ordering needs — anything with a created_at-style timestamp.
interface Datable {
  createdAt: string;
}

/** Newest-first comparator used within every group. */
export function byNewest(a: Datable, b: Datable): number {
  return b.createdAt.localeCompare(a.createdAt);
}
