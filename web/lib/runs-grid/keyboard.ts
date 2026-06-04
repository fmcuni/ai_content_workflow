import type { BoardRecord } from "@/lib/runs-grid/board-record";
import { byNewest, GROUPS, type GroupKey } from "@/lib/runs-grid/groups";

// Pure keyboard-navigation logic for the ledger board (spec §4.7): the visible
// row order a j/k cursor walks, the next-id reducer, and the guard that keeps
// the hotkeys from hijacking text inputs / open overlays. The DOM wiring (window
// listener, roving tabindex, focus()) lives in use-board-keyboard; everything
// here is side-effect-free and unit-tested.

export interface NavRow {
  id: string;
  kind: "run" | "batch";
}

// Form controls + links that own their own key handling — the action hotkeys
// (x/e/Enter) must not fire while one of these holds focus.
const INTERACTIVE_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A", "OPTION"]);

/**
 * The flat, top-to-bottom order a j/k cursor walks: each open group's records
 * (newest-first, matching the rendered order), with an expanded batch's promoted
 * child runs inlined right after the batch — exactly what the operator sees.
 * Collapsed groups and unexpanded batches contribute only their own row.
 */
export function buildNavOrder(
  records: readonly BoardRecord[],
  isGroupOpen: (key: GroupKey) => boolean,
  expanded: ReadonlySet<string>,
  childIdsOf: (batchId: string) => readonly string[],
): NavRow[] {
  const order: NavRow[] = [];
  for (const group of GROUPS) {
    if (!isGroupOpen(group.key)) continue;
    const inGroup = records.filter((r) => r.group === group.key).sort(byNewest);
    for (const rec of inGroup) {
      if (rec.kind === "batch") {
        order.push({ id: rec.id, kind: "batch" });
        if (expanded.has(rec.id)) {
          for (const childId of childIdsOf(rec.id)) order.push({ id: childId, kind: "run" });
        }
      } else {
        order.push({ id: rec.id, kind: "run" });
      }
    }
  }
  return order;
}

/**
 * Next focus id after a j (`delta` +1) / k (`delta` -1). With nothing focused,
 * j lands on the first row and k on the last. At an end the cursor clamps (stays
 * put) rather than wrapping. An unknown current id re-enters at the nearest end.
 */
export function moveFocus(
  order: readonly NavRow[],
  currentId: string | null,
  delta: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  if (currentId === null) return delta > 0 ? order[0].id : order[order.length - 1].id;

  const idx = order.findIndex((r) => r.id === currentId);
  if (idx === -1) return delta > 0 ? order[0].id : order[order.length - 1].id;

  const next = idx + delta;
  if (next < 0 || next >= order.length) return currentId; // clamp at the ends
  return order[next].id;
}

/** The NavRow for an id, or null when it has scrolled out of the open order. */
export function findNavRow(order: readonly NavRow[], id: string | null): NavRow | null {
  if (id === null) return null;
  return order.find((r) => r.id === id) ?? null;
}

/**
 * True when a keystroke must be left alone: an overlay (dialog / menu) is open,
 * or focus sits in an editable field / interactive control. Keeps the board
 * hotkeys from stealing typing or double-firing a focused button/link.
 */
export function shouldIgnoreKbd(
  tagName: string | undefined,
  isContentEditable: boolean,
  overlayOpen: boolean,
): boolean {
  if (overlayOpen) return true;
  if (isContentEditable) return true;
  return tagName != null && INTERACTIVE_TAGS.has(tagName.toUpperCase());
}

/** Where Enter opens a focused row. */
export function rowHref(row: NavRow): string {
  return row.kind === "batch" ? `/topic-batches/${row.id}` : `/runs/${row.id}`;
}
