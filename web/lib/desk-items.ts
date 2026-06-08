// Pure mapping from runs + topic batches to the unified "desk item" the Front
// Page renders. No React here — kept side-effect-free so the lane/category
// derivation is unit-testable and reused by the tab filters and the row view.

import type { BatchStatus, RunStatus, RunSummary, TopicBatch } from "@/lib/types";

// Three lanes, sorted by what needs a human first:
//   desk   — blocked on the operator (HITL gates, changes requested, failed)
//   motion — running autonomously right now
//   filed  — terminal / nothing pending
export type Lane = "desk" | "motion" | "filed";

// The editorial "section" a card belongs to. Drives the tab filters and the
// monochrome category tag (status colour stays the only colour-coded signal).
export type Category = "rewrite" | "create" | "topic_gen";

export type StampTone = "neutral" | "accent" | "ok" | "warn" | "info" | "danger";

// The gate the operator can act on from the row, without opening the run.
//   approve_outline    — HITL_1, one-click approve as drafted
//   approve_publish    — HITL_2, approve + publish to WordPress
//   request_changes    — HITL_2, send the draft back with notes
//   reject             — HITL_2, reject the draft
//   restart            — failed run, re-run from the top
//   promote            — topic batch, open the promotion meeting (needs detail)
//   open               — no inline action; just open the item
export type GateAction =
  | "approve_outline"
  | "approve_publish"
  | "request_changes"
  | "reject"
  | "restart"
  | "promote"
  | "open";

export const CATEGORY_META: Record<Category, { label: string; glyph: string }> = {
  rewrite: { label: "Rewrite", glyph: "↻" },
  create: { label: "Create", glyph: "✦" },
  topic_gen: { label: "Topic gen", glyph: "❉" },
};

// Tab keys mirror the categories, plus an "all" overview.
export type TabKey = "all" | "rewrite" | "create" | "topic_gen";

export const TABS: { key: TabKey; label: string; glyph?: string }[] = [
  { key: "all", label: "All" },
  { key: "rewrite", label: "Rewrites", glyph: CATEGORY_META.rewrite.glyph },
  { key: "create", label: "New articles", glyph: CATEGORY_META.create.glyph },
  { key: "topic_gen", label: "Topic batches", glyph: CATEGORY_META.topic_gen.glyph },
];

// Runs blocked on a human, vs. auto-running, vs. terminal. Anything not listed
// in DESK/MOTION is treated as "filed".
const RUN_DESK = new Set<RunStatus>(["hitl_1", "hitl_2", "changes_requested", "failed"]);
const RUN_MOTION = new Set<RunStatus>(["pending", "fetching", "strategy", "production"]);
const BATCH_DESK = new Set<BatchStatus>(["ready_for_review", "partially_promoted", "failed"]);
const BATCH_MOTION = new Set<BatchStatus>(["pending", "generating", "analysing"]);

export const BATCH_META: Record<BatchStatus, { label: string; tone: StampTone; pulse?: boolean }> = {
  pending: { label: "Queued", tone: "neutral" },
  generating: { label: "Generating", tone: "info", pulse: true },
  analysing: { label: "Analysing", tone: "info", pulse: true },
  ready_for_review: { label: "Ready for review", tone: "accent" },
  partially_promoted: { label: "Partly promoted", tone: "warn" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
};

export interface DeskItem {
  key: string;
  id: string;
  kind: "run" | "batch";
  status: string;
  lane: Lane;
  category: Category;
  categoryNote?: string;
  autoAccept: boolean;
  title: string;
  subtitle: string;
  keywords?: string[];
  meta?: string[];
  rowHref: string;
  /** Primary inline gate action label, or null when nothing is actionable. */
  action: string | null;
  /** The inline gate action to run, or "open" when the row only navigates. */
  gate: GateAction;
  createdAt: string;
  deletable: boolean;
}

function runActionLabel(r: RunSummary): string | null {
  switch (r.status) {
    case "hitl_1": return "Approve outline";
    case "hitl_2": return "Approve & publish";
    case "changes_requested": return "Open run";
    case "failed": return "Restart run";
    default: return null;
  }
}

function runGate(r: RunSummary): GateAction {
  switch (r.status) {
    case "hitl_1": return "approve_outline";
    case "hitl_2": return "approve_publish";
    case "failed": return "restart";
    default: return "open";
  }
}

export function runActionHref(r: RunSummary): string {
  switch (r.status) {
    case "hitl_1": return `/runs/${r.run_id}/hitl1`;
    case "hitl_2": return `/runs/${r.run_id}/hitl2`;
    default: return `/runs/${r.run_id}`;
  }
}

function batchActionLabel(b: TopicBatch): string | null {
  switch (b.status) {
    case "ready_for_review": return "Review topics";
    case "partially_promoted": return "Finish promotion";
    case "failed": return "Inspect failure";
    default: return null;
  }
}

export function runToItem(r: RunSummary): DeskItem {
  const category: Category = r.start_mode === "create" ? "create" : "rewrite";
  const lane: Lane = RUN_DESK.has(r.status) ? "desk" : RUN_MOTION.has(r.status) ? "motion" : "filed";
  const action = lane === "desk" ? runActionLabel(r) : null;
  const gate = lane === "desk" ? runGate(r) : "open";
  const categoryNote =
    category === "rewrite" && r.chosen_route
      ? r.chosen_route === "full_rewrite"
        ? "Full"
        : "Small"
      : undefined;
  const subtitle =
    category === "create"
      ? r.target_audience
        ? `New article · ${r.target_audience}`
        : "New article"
      : r.article_url;
  // Task brief at a glance: voice, mode (rewrite only), advertiser + widget.
  const meta: string[] = [];
  if (r.persona) meta.push(`Voice · ${r.persona}`);
  if (category === "rewrite") meta.push(`Mode · ${r.mode}`);
  // 0 is the "unset" sentinel for these ACF ids (ids start at 1), so treat it
  // as empty and omit the chip entirely — only show a real, assigned id.
  if (r.acf_adv_id) meta.push(`Adv ${r.acf_adv_id}`);
  if (r.acf_widget_id) meta.push(`Widget ${r.acf_widget_id}`);
  return {
    key: `run:${r.run_id}`,
    id: r.run_id,
    kind: "run",
    status: r.status,
    lane,
    category,
    categoryNote,
    autoAccept: r.auto_accept_hitl1 === true,
    title: r.topic,
    subtitle,
    keywords: r.keywords,
    meta,
    rowHref: action && gate !== "open" ? runActionHref(r) : `/runs/${r.run_id}`,
    action,
    gate,
    createdAt: r.created_at,
    // Every run is removable — deleting an in-motion run cancels its executor
    // server-side first, so no lane is exempt.
    deletable: true,
  };
}

export function batchToItem(b: TopicBatch): DeskItem {
  const lane: Lane = BATCH_DESK.has(b.status) ? "desk" : BATCH_MOTION.has(b.status) ? "motion" : "filed";
  const action = lane === "desk" ? batchActionLabel(b) : null;
  return {
    key: `batch:${b.batch_id}`,
    id: b.batch_id,
    kind: "batch",
    status: b.status,
    lane,
    category: "topic_gen",
    autoAccept: b.auto_accept_hitl1_default === true,
    title: b.research_theme,
    subtitle: `${b.topic_count} topics · ${b.target_audience}`,
    rowHref: `/topic-batches/${b.batch_id}`,
    action,
    // Topic promotion needs per-candidate decisions, so it only ever opens the
    // batch detail — never a one-click gate from the desk.
    gate: action ? "promote" : "open",
    createdAt: b.created_at,
    deletable: true,
  };
}

/** Build the sorted desk-item list from the two source queries. */
export function buildDeskItems(
  runs: readonly RunSummary[] | undefined,
  batches: readonly TopicBatch[] | undefined,
): DeskItem[] {
  return [
    ...(runs ?? []).map(runToItem),
    ...(batches ?? []).map(batchToItem),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Filter desk items to a tab. "all" passes everything through. */
export function filterByTab(items: readonly DeskItem[], tab: TabKey): DeskItem[] {
  if (tab === "all") return [...items];
  return items.filter((i) => i.category === tab);
}
