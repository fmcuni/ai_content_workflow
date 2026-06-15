import type { RunSummary, TopicBatch } from "@/lib/types";

import type { RunFilterOpts, SortOrder } from "./useLedgerData";
import { runMatches, sortRuns } from "./useLedgerData";

/**
 * Monday.com-style board model for `/runs`.
 *
 * Themes (topic batches) headline as parent tasks; the create/refresh runs
 * promoted from a theme nest beneath it as sub-tasks (linked by
 * `run.topic_batch_id === batch.batch_id`). Runs with no theme — ad-hoc "Create
 * New Article" and standalone refresh runs — fall through to a flat list
 * rendered below every theme group.
 */
export interface ThemeGroup {
  batch: TopicBatch;
  /** Promoted runs nested under this theme, already filtered + sorted. */
  children: RunSummary[];
  /** Theme title matched the active search query (children may be hidden). */
  matchedByTitle: boolean;
}

/** A single top-level board row: either a theme (topic batch) parent task or a
 *  standalone run. Themes and standalone runs are interleaved chronologically so
 *  themes are no longer pinned above every run. */
export type BoardItem =
  | { kind: "theme"; group: ThemeGroup }
  | { kind: "run"; run: RunSummary };

export interface BoardModel {
  themes: ThemeGroup[];
  standalone: RunSummary[];
  /** Themes + standalone runs interleaved in chronological (sort) order — the
   *  exact top-level render sequence for the board. */
  items: BoardItem[];
  /** Flattened run order of everything currently rendered (expanded children +
   *  standalone) — drives "select all", keyboard nav, and drawer stepping. */
  visibleRuns: RunSummary[];
}

function noFiltersActive(opts: RunFilterOpts): boolean {
  return opts.tab === "all" && !opts.search.trim() && !opts.voice && !opts.creator;
}

/**
 * Build the board from the raw runs + batches and the active filter/sort state.
 *
 * Visibility rules per theme:
 *  - shown if it has ≥1 child passing the active filters, OR
 *  - shown if no filters are active (so empty / not-yet-promoted themes appear), OR
 *  - shown if the search query matches the theme title (then its children are
 *    matched ignoring the search term, so the group is never rendered empty).
 *
 * `expanded` only affects `visibleRuns` (collapsed themes hide their children
 * from selection / keyboard nav); the theme rows themselves always render.
 */
export function buildBoard(
  runs: RunSummary[],
  batches: TopicBatch[],
  opts: RunFilterOpts & { sort: SortOrder },
  expanded: ReadonlySet<string>,
): BoardModel {
  const noFilters = noFiltersActive(opts);
  const q = opts.search.trim().toLowerCase();

  // Partition the filtered runs into per-theme buckets + standalone.
  const filtered = runs.filter((r) => runMatches(r, opts));
  const childrenByBatch = new Map<string, RunSummary[]>();
  const standalone: RunSummary[] = [];
  for (const run of filtered) {
    if (run.topic_batch_id) {
      const bucket = childrenByBatch.get(run.topic_batch_id);
      if (bucket) bucket.push(run);
      else childrenByBatch.set(run.topic_batch_id, [run]);
    } else {
      standalone.push(run);
    }
  }

  const themes: ThemeGroup[] = [];
  for (const batch of batches) {
    let children = childrenByBatch.get(batch.batch_id) ?? [];
    const matchedByTitle = q.length > 0 && batch.research_theme.toLowerCase().includes(q);

    // A title-matched theme should show its runs even though they failed the
    // search predicate — recompute its children ignoring the search term.
    if (matchedByTitle && children.length === 0) {
      children = runs.filter(
        (r) => r.topic_batch_id === batch.batch_id && runMatches(r, { ...opts, search: "" }),
      );
    }

    children = sortRuns(children, opts.sort);
    const visible = children.length > 0 || noFilters || matchedByTitle;
    if (visible) themes.push({ batch, children, matchedByTitle });
  }

  const sortedStandalone = sortRuns(standalone, opts.sort);

  // Interleave themes (keyed by their batch's created_at) with standalone runs
  // (keyed by the run's created_at) so themes sort chronologically among runs
  // instead of always headlining the board. localeCompare on ISO-8601
  // timestamps is a correct chronological compare; the sort is stable so equal
  // timestamps preserve insertion order (themes before standalone).
  const dir = opts.sort === "newest" ? -1 : 1;
  const ordered: { item: BoardItem; key: string }[] = [
    ...themes.map((group) => ({
      item: { kind: "theme" as const, group },
      key: group.batch.created_at,
    })),
    ...sortedStandalone.map((run) => ({ item: { kind: "run" as const, run }, key: run.created_at })),
  ];
  ordered.sort((a, b) => dir * a.key.localeCompare(b.key));
  const items: BoardItem[] = ordered.map((o) => o.item);

  // visibleRuns follows the rendered order: each standalone run in place, plus
  // the children of any expanded theme, walked in board sequence.
  const visibleRuns: RunSummary[] = items.flatMap((it) =>
    it.kind === "run"
      ? [it.run]
      : expanded.has(it.group.batch.batch_id)
        ? it.group.children
        : [],
  );

  return { themes, standalone: sortedStandalone, items, visibleRuns };
}

/** Aggregate counts of a theme's children by coarse lifecycle bucket — drives
 *  the collapsed theme row's mini status summary. */
export interface ChildStatusSummary {
  total: number;
  published: number;
  inFlight: number;
  needsReview: number;
  failed: number;
}

const PUBLISHED = new Set(["published"]);
const FAILED = new Set(["failed", "rejected"]);
const NEEDS_REVIEW = new Set(["hitl_1", "outlined", "hitl_2", "drafted", "changes_requested"]);

export function summarizeChildren(children: readonly RunSummary[]): ChildStatusSummary {
  const summary: ChildStatusSummary = {
    total: children.length,
    published: 0,
    inFlight: 0,
    needsReview: 0,
    failed: 0,
  };
  for (const c of children) {
    if (PUBLISHED.has(c.status)) summary.published += 1;
    else if (FAILED.has(c.status)) summary.failed += 1;
    else if (NEEDS_REVIEW.has(c.status)) summary.needsReview += 1;
    else summary.inFlight += 1;
  }
  return summary;
}
