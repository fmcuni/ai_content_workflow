// Lightweight line-diff used by the version-history preview dialogs to show a
// past version against the current/live body. Wraps the already-bundled `diff`
// dependency (jsdiff) so the components consume a small, stable, testable shape
// instead of jsdiff's raw `Change[]`.

import { diffLines } from "diff";

export type DiffLineType = "add" | "del" | "ctx";

export interface DiffLine {
  type: DiffLineType;
  /** One line of text, without its trailing newline. */
  text: string;
}

/**
 * Compute a line-level diff of `before` → `after`.
 *
 * - `del` lines exist in `before` but not `after` (would be removed).
 * - `add` lines exist in `after` but not `before` (would be added).
 * - `ctx` lines are unchanged context.
 *
 * Directionality convention: callers pass the SELECTED (older) version as
 * `before` and the CURRENT/live body as `after`, so the diff reads "what would
 * change if the current body replaced this version" — additions are what the
 * live body has that the selected version lacked.
 */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const changes = diffLines(before ?? "", after ?? "");
  const lines: DiffLine[] = [];
  for (const change of changes) {
    const type: DiffLineType = change.added ? "add" : change.removed ? "del" : "ctx";
    // jsdiff groups consecutive lines into one Change whose `value` carries the
    // newlines; split back into individual lines and drop the trailing empty
    // element a final "\n" produces.
    const parts = change.value.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") {
      parts.pop();
    }
    for (const text of parts) {
      lines.push({ type, text });
    }
  }
  return lines;
}

/** True when `before` and `after` are byte-identical (no diff to show). */
export function isUnchanged(before: string, after: string): boolean {
  return (before ?? "") === (after ?? "");
}
