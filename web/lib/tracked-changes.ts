import { diffWordsWithSpace, type Change } from "diff";

/**
 * In-house tracked-changes engine for HUMAN edits (no paid Pro extension).
 *
 * A "committed" baseline and the live "working" body are diffed at word
 * granularity (the same `diff` package behind HtmlDiffView). Each insertion /
 * deletion is a `Hunk` the reviewer can commit (accept into the baseline) or
 * dismiss (revert the working body). All transforms are PURE and IMMUTABLE: they
 * rebuild both strings from the diff parts so the rejoined HTML stays valid (we
 * only ever keep or drop whole parts, never split one).
 *
 * AI edits are out of scope — they advance the baseline directly and never
 * surface here as pending changes.
 */

export interface Hunk {
  /** Index of this part within the diff `parts` array. */
  index: number;
  /** `add` = present in working only; `remove` = present in committed only. */
  type: "add" | "remove";
  value: string;
}

export interface TrackedChanges {
  parts: Change[];
  hunks: Hunk[];
}

/** The committed side = unchanged + removed parts (what the baseline holds). */
function buildCommitted(parts: readonly Change[]): string {
  return parts.map((p) => (p.added ? "" : p.value)).join("");
}

/** The working side = unchanged + added parts (what the editor holds). */
function buildWorking(parts: readonly Change[]): string {
  return parts.map((p) => (p.removed ? "" : p.value)).join("");
}

/** Diff the committed baseline against the working body into indexed hunks.
 * Uses `diffWordsWithSpace` (whitespace-significant) so that
 * unchanged+removed === committed and unchanged+added === working EXACTLY —
 * a lossless reconstruction commit/dismiss depends on. (`diffWords`, used by the
 * display-only HtmlDiffView, normalises boundary whitespace and would drift.) */
export function computeTrackedChanges(committed: string, working: string): TrackedChanges {
  const parts = diffWordsWithSpace(committed, working);
  const hunks: Hunk[] = [];
  parts.forEach((p, index) => {
    if (p.added) hunks.push({ index, type: "add", value: p.value });
    else if (p.removed) hunks.push({ index, type: "remove", value: p.value });
  });
  return { parts, hunks };
}

export interface CommitResult {
  committed: string;
  working: string;
}

/**
 * Accept the hunk at `index` into the baseline. The working body is unchanged;
 * the new baseline matches working at that part (gains an insertion, drops a
 * deletion), so a re-diff has one fewer hunk.
 */
export function commitHunk(parts: readonly Change[], index: number): CommitResult {
  const committed = parts
    .map((p, i) => {
      if (i === index) return p.added ? p.value : ""; // added → gain; removed → drop
      return p.added ? "" : p.value; // committed side for every other part
    })
    .join("");
  return { committed, working: buildWorking(parts) };
}

/**
 * Reject the hunk at `index`. The baseline is unchanged; the working body
 * reverts to the baseline at that part (drops an insertion, restores a deletion).
 */
export function dismissHunk(parts: readonly Change[], index: number): CommitResult {
  const working = parts
    .map((p, i) => {
      if (i === index) return p.removed ? p.value : ""; // removed → restore; added → drop
      return p.removed ? "" : p.value; // working side for every other part
    })
    .join("");
  return { committed: buildCommitted(parts), working };
}

/** Accept every pending change — the baseline becomes the working body. */
export function commitAll(parts: readonly Change[]): CommitResult {
  const working = buildWorking(parts);
  return { committed: working, working };
}

/** Reject every pending change — the working body reverts to the baseline. */
export function dismissAll(parts: readonly Change[]): CommitResult {
  const committed = buildCommitted(parts);
  return { committed, working: committed };
}
