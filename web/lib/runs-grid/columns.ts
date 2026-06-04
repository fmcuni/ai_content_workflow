// Per-tab / per-visibility column definitions for the Runs Ledger board.
//
// Runs render across a fixed set of right-hand columns grouped under two
// small-caps kickers — BRIEF and WORDPRESS DESTINATION — to the right of the
// frozen identity column. Topic batches do NOT map to these columns: they draw
// a full-width tinted band, so the only thing they need from here is the total
// column count to span. The validated demo uses one constant run-column set for
// every run-bearing tab (the topic-batches tab shows only bands), with the
// WordPress group toggled as a unit by the rail.
//
// Pure + side-effect-free so the column sets and colspans are unit-testable.

import type { TabKey } from "@/lib/desk-items";

// Which kicker group a column sits under.
export type ColGroup = "brief" | "wordpress";

// A field rendered as plain text in Phase 1 (display-only; inline editors land
// in Phase 3). `key` is stable and used for React keys + test assertions.
export interface RunColumn {
  key: string;
  label: string;
  group: ColGroup;
  /** Right-align numeric/date columns to keep tabular-nums aligned. */
  numeric?: boolean;
}

export const COLUMN_GROUP_LABEL: Record<ColGroup, string> = {
  brief: "Brief",
  wordpress: "WordPress destination",
};

// Task brief: voice + the two ACF ids that ride along to re-runs/republish.
export const BRIEF_COLUMNS: readonly RunColumn[] = [
  { key: "voice", label: "Voice", group: "brief" },
  { key: "adv", label: "Adv ID", group: "brief", numeric: true },
  { key: "widget", label: "Widget ID", group: "brief", numeric: true },
];

// WordPress destination: where + how the draft publishes.
export const WORDPRESS_COLUMNS: readonly RunColumn[] = [
  { key: "author", label: "Author", group: "wordpress" },
  { key: "category", label: "Category", group: "wordpress" },
  { key: "slug", label: "Slug (decoded)", group: "wordpress" },
  { key: "publish", label: "Publish", group: "wordpress" },
  { key: "postDate", label: "Post date", group: "wordpress" },
];

export const RUN_COLUMNS: readonly RunColumn[] = [...BRIEF_COLUMNS, ...WORDPRESS_COLUMNS];

/**
 * The run columns visible right now. The WordPress group hides as a unit via the
 * rail toggle; BRIEF is always shown. `tab` is accepted for forward-compat — the
 * demo-validated design keeps one run-column set across every run-bearing tab.
 */
export function columnsForTab(_tab: TabKey, showWordpress: boolean): RunColumn[] {
  return showWordpress ? [...RUN_COLUMNS] : [...BRIEF_COLUMNS];
}

export interface ColumnGroupSpan {
  group: ColGroup;
  label: string;
  span: number;
}

/** Colspans for the top (kicker) header row, given WordPress visibility. */
export function columnGroupSpans(showWordpress: boolean): ColumnGroupSpan[] {
  const groups: ColumnGroupSpan[] = [
    { group: "brief", label: COLUMN_GROUP_LABEL.brief, span: BRIEF_COLUMNS.length },
  ];
  if (showWordpress) {
    groups.push({
      group: "wordpress",
      label: COLUMN_GROUP_LABEL.wordpress,
      span: WORDPRESS_COLUMNS.length,
    });
  }
  return groups;
}

// Fixed columns that bracket the data columns: the frozen selection checkbox and
// identity columns on the left, and the Action column on the right. Mirrors the
// demo's colCount = 2 (sel + topic) + 3 (brief) + (wp?5:0) + 1 (action).
const FIXED_COLUMNS = 3;

/**
 * Total number of `<td>`s in a run row — and the colspan a full-width topic-batch
 * band (or group header / empty state) must stretch across.
 */
export function totalColumnCount(showWordpress: boolean): number {
  return FIXED_COLUMNS + columnsForTab("all", showWordpress).length;
}
