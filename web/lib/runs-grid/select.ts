// Pure top-level item selection + record building for the Ledger board. Shared
// by the desktop grid and the responsive (below-lg) Desk-card fallback so both
// surfaces agree on what each tab shows and how search/voice filter it.

import type { BoardRecord } from "@/lib/runs-grid/board-record";
import { batchGroup, runGroup } from "@/lib/runs-grid/groups";
import type { TabKey } from "@/lib/desk-items";
import type { RunSummary, TopicBatch } from "@/lib/types";

/**
 * Top-level records for a tab, before search/voice filtering:
 *   • rewrite / create → flat run lists (create includes runs promoted from a
 *     batch — they appear both here and nested under their band).
 *   • topic_gen → batches only.
 *   • all → standalone runs (not promoted from a batch) + the batch bands.
 */
export function selectTopItems(
  tab: TabKey,
  runs: readonly RunSummary[],
  batches: readonly TopicBatch[],
): { runs: RunSummary[]; batches: TopicBatch[] } {
  if (tab === "rewrite") return { runs: runs.filter((r) => r.start_mode !== "create"), batches: [] };
  if (tab === "create") return { runs: runs.filter((r) => r.start_mode === "create"), batches: [] };
  if (tab === "topic_gen") return { runs: [], batches: [...batches] };
  return { runs: runs.filter((r) => r.topic_candidate_id == null), batches: [...batches] };
}

function runMatches(r: RunSummary, q: string, voice: string): boolean {
  if (voice && (r.persona ?? "") !== voice) return false;
  if (!q) return true;
  return `${r.topic} ${r.article_url} ${r.run_id}`.toLowerCase().includes(q);
}

function batchMatches(b: TopicBatch, q: string, voice: string): boolean {
  if (voice && (b.persona_default ?? "") !== voice) return false;
  if (!q) return true;
  return `${b.research_theme} ${b.batch_id}`.toLowerCase().includes(q);
}

/** Search + voice filtered board records for the active tab (unsorted). */
export function buildRecords(
  tab: TabKey,
  runs: readonly RunSummary[],
  batches: readonly TopicBatch[],
  search: string,
  voice: string,
): BoardRecord[] {
  const q = search.trim().toLowerCase();
  const top = selectTopItems(tab, runs, batches);
  const runRecs: BoardRecord[] = top.runs
    .filter((r) => runMatches(r, q, voice))
    .map((r) => ({
      kind: "run",
      id: r.run_id,
      createdAt: r.created_at,
      group: runGroup(r.status),
      voice: r.persona ?? "",
      run: r,
    }));
  const batchRecs: BoardRecord[] = top.batches
    .filter((b) => batchMatches(b, q, voice))
    .map((b) => ({
      kind: "batch",
      id: b.batch_id,
      createdAt: b.created_at,
      group: batchGroup(b.status),
      voice: b.persona_default ?? "",
      batch: b,
    }));
  return [...runRecs, ...batchRecs];
}

/** Distinct voices across runs + batches, for the rail's voice filter. */
export function distinctVoices(
  runs: readonly RunSummary[],
  batches: readonly TopicBatch[],
): string[] {
  const set = new Set<string>();
  for (const r of runs) if (r.persona) set.add(r.persona);
  for (const b of batches) if (b.persona_default) set.add(b.persona_default);
  return [...set].sort((a, b) => a.localeCompare(b));
}
