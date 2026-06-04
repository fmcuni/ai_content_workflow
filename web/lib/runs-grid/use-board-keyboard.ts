"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import {
  findNavRow,
  moveFocus,
  type NavRow,
  rowHref,
  shouldIgnoreKbd,
} from "@/lib/runs-grid/keyboard";

// Window-level keydown wiring for the ledger board's roving-tabindex cursor
// (spec §4.7): j/k move the focused row, x toggles its selection, e expands /
// collapses its draft-preview insert, Enter opens it. The pure decisions live in
// keyboard.ts; this hook owns the listener lifecycle and moving real DOM focus.

interface BoardKeyboardArgs {
  order: readonly NavRow[];
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;
  onToggleSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
}

/** Move DOM focus to a row by its data-row-id (no-op if it isn't mounted). */
function focusRow(id: string): void {
  if (typeof document === "undefined") return;
  const el = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
  el?.focus();
}

/** An open Radix dialog / dropdown traps focus — board hotkeys must stand down. */
function isOverlayOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"],[role="menu"]') !== null;
}

export function useBoardKeyboard({
  order,
  focusedId,
  setFocusedId,
  onToggleSelect,
  onToggleExpand,
}: BoardKeyboardArgs): void {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Never fight a modifier combo (copy, browser shortcuts, etc.).
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (shouldIgnoreKbd(target?.tagName, target?.isContentEditable ?? false, isOverlayOpen())) {
        return;
      }

      switch (event.key) {
        case "j":
        case "k": {
          const next = moveFocus(order, focusedId, event.key === "j" ? 1 : -1);
          if (next !== null) {
            setFocusedId(next);
            focusRow(next);
          }
          event.preventDefault();
          break;
        }
        case "x": {
          if (focusedId) {
            onToggleSelect(focusedId);
            event.preventDefault();
          }
          break;
        }
        case "e": {
          if (focusedId) {
            onToggleExpand(focusedId);
            event.preventDefault();
          }
          break;
        }
        case "Enter": {
          const row = findNavRow(order, focusedId);
          if (row) {
            router.push(rowHref(row));
            event.preventDefault();
          }
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [order, focusedId, setFocusedId, onToggleSelect, onToggleExpand, router]);
}
